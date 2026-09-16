/**
 * Riassunto delle tappe di spedizione, scritto su un metafield dell'ordine.
 *
 * PERCHÉ ESISTE
 * Il cruscotto spedizioni deve mostrare centinaia di ordini con la loro tappa.
 * Leggere i fulfillment event in lista costa `ordini × spedizioni × eventi` punti
 * di costo GraphQL: a 600 ordini la query non passa, e paginare abbastanza fine
 * richiederebbe minuti a ogni apertura di schermata. Un metafield invece è un
 * campo: costa 1.
 *
 * Nessun database, nessun servizio nuovo, nessun polling: il riassunto si
 * aggiorna nello stesso passaggio in cui questa app scrive già il fulfillment
 * event, cioè quando arriva il webhook ShippyPro.
 *
 * REGOLA TERMINALE
 * Quando una spedizione risulta consegnata diventa `terminale`: non viene più
 * interrogata, non viene più riscritta, e un webhook tardivo o duplicato non la
 * riapre. Quando tutte le spedizioni non annullate di un ordine sono terminali,
 * `maybeTagDelivered` applica il tag `consegnato` e l'ordine esce dalle viste
 * operative del cruscotto, che filtra alla sorgente con `tag_not:consegnato`.
 *
 * CHE COSA CONTIENE — e cosa NON contiene
 * Solo FATTI: date e stato grezzo dichiarato da Shopify, più il testo originale
 * del corriere. Nessuna interpretazione. Lo stato "normalizzato" (giacenza,
 * indirizzo errato, rientro al mittente…) lo calcola chi legge, così cambiare
 * l'interpretazione non obbliga a rifare il backfill.
 *
 * Il riassunto è un DERIVATO: la verità restano i fulfillment event. Chi legge
 * lo sa e, se manca, ricalcola dichiarandolo.
 *
 * Metafield: namespace `checkpoint`, key `spedizione_stato`, type `json`.
 */

import { gql, assertNoUserErrors } from './shopify.js';

export const SNAPSHOT_NS = 'checkpoint';
export const SNAPSHOT_KEY = 'spedizione_stato';
export const SNAPSHOT_VERSION = 1;

/**
 * Stati che provano l'uscita FISICA del collo dal magazzino.
 *
 * Esclusi deliberatamente:
 *  - CONFIRMED, LABEL_PURCHASED, LABEL_PRINTED: la LDV creata non è un ritiro,
 *    e questa è la regola su cui si regge tutto il cruscotto;
 *  - DELAYED: può comparire anche prima che il corriere passi.
 */
export const PRESA_IN_CARICO = new Set([
  'CARRIER_PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'READY_FOR_PICKUP',
  'ATTEMPTED_DELIVERY',
  'DELIVERED',
]);

export const provaUscitaMagazzino = (status) => PRESA_IN_CARICO.has(status);

/** Solo CARRIER_PICKED_UP data la presa in carico con esattezza. Gli altri la implicano. */
const PRESA_ESATTA = 'CARRIER_PICKED_UP';

/**
 * Legge il riassunto salvato. Un JSON corrotto o di versione ignota vale come
 * assente: meglio ricostruire che ragionare su un formato che non si conosce.
 */
export function leggiSnapshot(valore) {
  if (!valore) return null;
  try {
    const j = JSON.parse(valore);
    if (!j || typeof j !== 'object' || j.v !== SNAPSHOT_VERSION) return null;
    if (!Array.isArray(j.spedizioni)) return null;
    return j;
  } catch {
    return null;
  }
}

const vuoto = (fulfillment) => {
  const info = fulfillment.trackingInfo?.find((t) => t.number) || {};
  return {
    fulfillmentId: fulfillment.id,
    tracking: info.number || null,
    corriere: info.company || null,
    trackAt: fulfillment.createdAt || null,
    presaAt: null,
    presaStatus: null,
    presaApprossimata: false,
    consegnaAt: null,
    ultimoEventoAt: null,
    ultimoEventoStatus: null,
    ultimoEventoMessaggio: null,
    ultimoEventoLuogo: null,
    numeroEventi: 0,
    terminale: false,
  };
};

/**
 * Applica un evento a una voce del riassunto.
 *
 * Regole:
 *  1. `presaAt` si valorizza UNA SOLA VOLTA e non si sposta più. È la data su cui
 *     poggiano tutti i tempi del cruscotto: se si muovesse, si muoverebbero le
 *     statistiche già mostrate.
 *  2. Se il primo evento di uscita che vediamo non è CARRIER_PICKED_UP, la presa
 *     in carico è avvenuta prima e noi non l'abbiamo vista: la data è una stima
 *     per eccesso e va marcata `presaApprossimata`. Il backfill, che legge tutta
 *     la cronologia, la corregge.
 *  3. Un evento più vecchio dell'ultimo registrato non sovrascrive l'ultimo
 *     evento, ma può comunque valorizzare `presaAt` o `consegnaAt` se mancano.
 */
export function applicaEvento(voce, { status, happenedAt, message, luogo }) {
  // REGOLA TERMINALE: una spedizione consegnata è chiusa. Un webhook tardivo o
  // duplicato non la riapre, non sposta la data di consegna e non riscrive nulla.
  if (voce.terminale) return voce;

  const v = { ...voce };

  if (!v.presaAt && provaUscitaMagazzino(status) && happenedAt) {
    v.presaAt = happenedAt;
    v.presaStatus = status;
    v.presaApprossimata = status !== PRESA_ESATTA;
  }
  if (status === 'DELIVERED' && happenedAt && !v.consegnaAt) {
    v.consegnaAt = happenedAt;
    v.terminale = true;          // da qui in poi non si interroga né si riscrive
  }

  const piuRecente = !v.ultimoEventoAt || (happenedAt && new Date(happenedAt) > new Date(v.ultimoEventoAt));
  if (piuRecente) {
    v.ultimoEventoAt = happenedAt || v.ultimoEventoAt;
    v.ultimoEventoStatus = status;
    v.ultimoEventoMessaggio = message ? String(message).slice(0, 240) : null;
    v.ultimoEventoLuogo = luogo ? String(luogo).slice(0, 120) : null;
  }
  v.numeroEventi = (v.numeroEventi || 0) + 1;
  return v;
}

/**
 * Ricostruisce una voce dalla cronologia completa: usata dal backfill, dove
 * gli eventi ci sono tutti e la presa in carico si legge con esattezza.
 */
export function daCronologia(fulfillment, eventi) {
  const ordinati = [...(eventi || [])].sort((a, b) => String(a.happenedAt).localeCompare(String(b.happenedAt)));
  const v = vuoto(fulfillment);

  const presa = ordinati.find((e) => provaUscitaMagazzino(e.status));
  const consegna = [...ordinati].reverse().find((e) => e.status === 'DELIVERED');
  const ultimo = ordinati[ordinati.length - 1];

  if (ordinati.length) v.trackAt = ordinati[0].happenedAt || v.trackAt;
  if (presa) {
    v.presaAt = presa.happenedAt;
    v.presaStatus = presa.status;
    // Qui la cronologia è integrale: se il primo evento di uscita non è un ritiro
    // esplicito, il ritiro non è mai stato notificato dal corriere. Resta il dato
    // più preciso disponibile, e va detto.
    v.presaApprossimata = presa.status !== PRESA_ESATTA;
  }
  if (consegna) { v.consegnaAt = consegna.happenedAt; v.terminale = true; }
  if (ultimo) {
    v.ultimoEventoAt = ultimo.happenedAt;
    v.ultimoEventoStatus = ultimo.status;
    v.ultimoEventoMessaggio = ultimo.message ? String(ultimo.message).slice(0, 240) : null;
    v.ultimoEventoLuogo = ultimo.city ? String(ultimo.city).slice(0, 120) : null;
  }
  v.numeroEventi = ordinati.length;
  return v;
}

/**
 * Costruisce il riassunto aggiornato per un ordine.
 * Non scrive nulla: restituisce il nuovo valore e se è cambiato qualcosa.
 *
 * @param {object} order            ordine come lo restituisce ORDER_FIELDS
 * @param {object[]} aggiornamenti  [{ fulfillmentId, status, happenedAt, message }]
 * @param {string} sorgente         'webhook' | 'backfill' | 'allineamento'
 */
export function componiSnapshot(order, aggiornamenti, sorgente = 'webhook') {
  const precedente = leggiSnapshot(order.snapshot?.value);
  const perId = new Map((precedente?.spedizioni || []).map((s) => [s.fulfillmentId, s]));

  const attivi = (order.fulfillments || []).filter((f) => f.status !== 'CANCELLED');
  const spedizioni = attivi.map((f) => {
    let v = perId.get(f.id) || vuoto(f);

    // Il codice o il corriere possono essere stati corretti dopo la creazione.
    const info = f.trackingInfo?.find((t) => t.number) || {};
    v = { ...v, tracking: info.number || v.tracking, corriere: info.company || v.corriere };
    if (!v.trackAt) v.trackAt = f.createdAt || null;

    for (const a of aggiornamenti.filter((x) => x.fulfillmentId === f.id)) {
      v = applicaEvento(v, a);
    }

    // Shopify deriva displayStatus dagli eventi: se dice DELIVERED e a noi manca
    // la data, l'evento c'è ma non è passato da qui. Meglio dichiarare la
    // consegna senza data che dire che il pacco è ancora in viaggio.
    if (f.displayStatus === 'DELIVERED' && !v.consegnaAt) {
      v.consegnaAt = v.ultimoEventoAt || null;
      v.terminale = true;
    }
    return v;
  });

  const nuovo = {
    v: SNAPSHOT_VERSION,
    aggiornatoIl: new Date().toISOString(),
    sorgente,
    spedizioni,
  };

  return { snapshot: nuovo, cambiato: differisce(precedente, nuovo) };
}

/** Confronto che ignora `aggiornatoIl`: serve a non riscrivere per nulla. */
function differisce(prima, dopo) {
  if (!prima) return true;
  const pulisci = (s) => JSON.stringify({ v: s.v, spedizioni: s.spedizioni });
  return pulisci(prima) !== pulisci(dopo);
}

/** Unica scrittura di questo modulo. */
export async function scriviSnapshot(orderGid, snapshot) {
  const data = await gql(
    `mutation($m: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $m) {
         metafields { key updatedAt }
         userErrors { field message code }
       }
     }`,
    {
      m: [{
        ownerId: orderGid,
        namespace: SNAPSHOT_NS,
        key: SNAPSHOT_KEY,
        type: 'json',
        value: JSON.stringify(snapshot),
      }],
    }
  );
  return assertNoUserErrors(data.metafieldsSet, 'metafieldsSet');
}

/**
 * Compone e scrive, se serve. Non solleva mai: il riassunto è un'ottimizzazione
 * di lettura, e un suo fallimento non deve far fallire la sincronizzazione dello
 * stato, che è la funzione vera di questa app.
 */
export async function aggiornaSnapshot(order, aggiornamenti, { dryRun = false, sorgente = 'webhook' } = {}) {
  try {
    const { snapshot, cambiato } = componiSnapshot(order, aggiornamenti, sorgente);
    if (!cambiato) return { scritto: false, motivo: 'riassunto invariato' };
    if (dryRun) return { scritto: false, motivo: 'DRY_RUN', anteprima: snapshot };
    await scriviSnapshot(order.id, snapshot);
    return { scritto: true, spedizioni: snapshot.spedizioni.length };
  } catch (err) {
    console.error('[snapshot] scrittura fallita', order?.name, err.message);
    return { scritto: false, errore: err.message };
  }
}
