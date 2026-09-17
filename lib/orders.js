import { gql, assertNoUserErrors, numericId } from './shopify.js';
import { present, isTerminal, rankOf, isOutOfScale } from './status.js';
import { carrierUrl } from './carriers.js';
import { makeToken } from './token.js';
import { parseEtaTag, etaIsStillRelevant, formatEtaLabel } from './eta.js';
import { APP_TAGS, hasAlert, stripTags } from './tags.js';

/**
 * Con il flag `alert` l'ordine ha un dato mancante a monte: la data calcolata
 * non è affidabile e promettere una spedizione che slitterà genera esattamente
 * le richieste al customer service che questa pagina deve evitare.
 * Metti a false per mostrare comunque la data.
 */
const HIDE_ETA_ON_ALERT = true;

/**
 * Chiave di identità di un collo: il codice spedizione normalizzato.
 * Spazi e maiuscole variano fra i sistemi che scrivono su Shopify, quindi
 * confrontare le stringhe grezze farebbe passare per distinti due colli uguali.
 *
 * Dichiarata qui in alto di proposito: è usata da rewriteTrackingUrl, che
 * compare prima di buildParcels nel file.
 */
const parcelKey = (number) => String(number || '').trim().toUpperCase();

const ORDER_FIELDS = `
  id
  name
  tags
  displayFulfillmentStatus
  fulfillments(first: 20) {
    id
    status
    displayStatus
    createdAt
    trackingInfo { company number url }
    events(first: 1, sortKey: HAPPENED_AT, reverse: true) {
      nodes { status happenedAt message }
    }
  }
`;

/**
 * Risolve un codice spedizione nell'ordine Shopify.
 *
 * Usa la ricerca full-text: il filtro `tracking_number:` NON esiste nella
 * search syntax di Shopify e viene ignorato in silenzio, restituendo tutti
 * gli ordini dello store. Non usarlo mai.
 *
 * Restituisce TUTTI i fulfillment con quel codice, non il primo: lo stesso
 * tracking può comparire su più fulfillment dello stesso ordine (succede
 * quando una spedizione viene registrata in più righe). Fermarsi al primo
 * lascerebbe gli altri senza stati, per sempre.
 *
 * NOTA — limite Shopify: senza lo scope `read_all_orders` l'app vede solo gli
 * ordini degli ultimi 60 giorni. Un codice più vecchio non viene trovato, e
 * non è un errore dell'app.
 *
 * @returns {{order: object, fulfillments: object[]}|null}
 */
export async function findOrderByTracking(trackingNumber) {
  const clean = String(trackingNumber).trim();
  if (!clean) return null;

  const data = await gql(
    `query($q: String!) { orders(first: 10, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
    { q: clean }
  );

  // Match esatto sul codice: la full-text può restituire più ordini.
  for (const order of data.orders.nodes) {
    const matches = order.fulfillments.filter((ff) =>
      ff.trackingInfo.some((t) => (t.number || '').trim() === clean)
    );
    if (matches.length) return { order, fulfillments: matches };
  }
  return null;
}

export async function getOrderById(numeric) {
  const data = await gql(
    `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: `gid://shopify/Order/${numeric}` }
  );
  return data.order;
}

export async function getOrderByGid(gid) {
  const data = await gql(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid });
  return data.order;
}

/* ------------------------------------------------------------------ *
 * Idempotenza
 * ------------------------------------------------------------------ */

/**
 * Decide se scrivere l'evento. Lo stato precedente vive già in Shopify,
 * quindi l'app resta senza database.
 *
 * @returns {{write: boolean, reason: string}}
 */
export function shouldWriteEvent(fulfillment, nextStatus, happenedAt) {
  if (!nextStatus) return { write: false, reason: 'stato non mappato' };

  if (fulfillment.status === 'CANCELLED') {
    return { write: false, reason: 'fulfillment annullato' };
  }

  const last = fulfillment.events?.nodes?.[0];
  if (!last) return { write: true, reason: 'primo evento' };

  if (last.status === nextStatus) {
    return { write: false, reason: 'stato identico al precedente' };
  }

  // Ordine temporale: un evento piu' vecchio dell'ultimo registrato non entra
  // mai. E' questa la protezione contro i webhook fuori sequenza, non il
  // blocco sullo stato terminale: DHL manda regolarmente un IN_TRANSIT delle
  // 06:56 dopo il DELIVERED delle 07:54, e viene scartato qui.
  if (happenedAt && last.happenedAt && new Date(happenedAt) <= new Date(last.happenedAt)) {
    return { write: false, reason: 'evento più vecchio dell\'ultimo registrato' };
  }

  // CONSEGNA RITRATTATA DAL VETTORE.
  //
  // Prima qui si usciva con `write: false` e l'evento spariva in silenzio.
  // E' cosi' che l'ordine 26CKPT2545 e' rimasto due settimane come consegnato
  // mentre ShippyPro riportava "in transito, in ritardo": ogni aggiornamento
  // reale veniva buttato via senza lasciare traccia.
  //
  // Su Shopify il `displayStatus` resta comunque DELIVERED — non c'e' modo di
  // cambiarlo — ma l'evento viene accettato e salvato, e `buildParcels()`
  // legge l'ultimo evento: la pagina cliente torna cosi' a dire la verita'.
  if (isTerminal(last.status)) {
    console.warn(
      '[allarme] consegna ritrattata dal vettore —',
      fulfillment.id,
      `${last.status} -> ${nextStatus}`,
      happenedAt || '',
      '| displayStatus resta DELIVERED su Shopify, la pagina cliente mostra lo stato reale'
    );
    return { write: true, reason: `consegna ritrattata: ${last.status} -> ${nextStatus}` };
  }
  if (!isOutOfScale(nextStatus) && rankOf(nextStatus) < rankOf(last.status)) {
    return { write: false, reason: `regressione ${last.status} -> ${nextStatus}` };
  }
  return { write: true, reason: 'ok' };
}

/* ------------------------------------------------------------------ *
 * Scritture
 * ------------------------------------------------------------------ */

export async function createFulfillmentEvent({ fulfillmentId, status, happenedAt, message, estimatedDeliveryAt }) {
  const data = await gql(
    `mutation($e: FulfillmentEventInput!) {
       fulfillmentEventCreate(fulfillmentEvent: $e) {
         fulfillmentEvent { id status happenedAt }
         userErrors { field message }
       }
     }`,
    {
      e: {
        fulfillmentId,
        status,
        ...(happenedAt ? { happenedAt } : {}),
        ...(message ? { message: message.slice(0, 240) } : {}),
        ...(estimatedDeliveryAt ? { estimatedDeliveryAt } : {}),
      },
    }
  );
  return assertNoUserErrors(data.fulfillmentEventCreate, 'fulfillmentEventCreate').fulfillmentEvent;
}

/**
 * Riscrive l'URL di tracking verso la nostra pagina.
 *
 * `notifyCustomer: false` è obbligatorio: l'app non deve generare
 * comunicazioni al cliente. L'input sostituisce l'intero blocco tracking,
 * quindi company e numbers vanno rispediti invariati.
 */
export async function rewriteTrackingUrl(order, fulfillment) {
  // Codici distinti: se lo stesso codice compare due volte nello stesso
  // fulfillment, riscriverlo due volte lo consoliderebbe come duplicato.
  const visti = new Set();
  const infos = fulfillment.trackingInfo.filter((t) => {
    const k = parcelKey(t.number);
    if (!k || visti.has(k)) return false;
    visti.add(k);
    return true;
  });
  if (!infos.length) return { skipped: 'nessun codice spedizione' };

  const target = trackingPageUrl(order.id);
  const alreadyOk = infos.every((t) => t.url === target);
  if (alreadyOk) return { skipped: 'URL già corretto' };

  const company = infos.find((t) => t.company)?.company || null;

  const data = await gql(
    `mutation($id: ID!, $info: FulfillmentTrackingInput!, $notify: Boolean) {
       fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $info, notifyCustomer: $notify) {
         fulfillment { id trackingInfo { company number url } }
         userErrors { field message }
       }
     }`,
    {
      id: fulfillment.id,
      notify: false,
      info: {
        ...(company ? { company } : {}),
        numbers: infos.map((t) => t.number),
        urls: infos.map(() => target),
      },
    }
  );
  return assertNoUserErrors(data.fulfillmentTrackingInfoUpdate, 'fulfillmentTrackingInfoUpdate');
}

export async function addOrderTags(orderGid, tags) {
  if (!tags.length) return null;
  const data = await gql(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: orderGid, tags }
  );
  return assertNoUserErrors(data.tagsAdd, 'tagsAdd');
}

/**
 * L'ordine merita il tag `consegnato`?
 *
 * Unica fonte di verita' della regola: la usano il webhook, `maybeTagDelivered()`
 * e `scripts/riallinea-tag.mjs`. Non reimplementarla altrove.
 *
 * Due punti che sembrano dettagli e non lo sono.
 *
 * 1. **Si guarda l'ultimo evento, non `displayStatus`.** Shopify non fa mai uscire
 *    un fulfillment da DELIVERED: usare `displayStatus` significa non poter piu'
 *    togliere il tag a una consegna rivelatasi falsa. `displayStatus` resta come
 *    ripiego quando la query non ha chiesto gli eventi.
 *
 * 2. **I fulfillment senza codice spedizione non contano** (regola Checkpoint del
 *    31/08/2026). Un'evasione parziale senza tracking e' un errore poi chiuso: la
 *    merce viaggia col primo tracking dell'ordine. Contarla significa aspettare un
 *    DELIVERED che non arrivera' mai, e tenere l'ordine aperto PER SEMPRE.
 *    `ignoraSenzaTracking: false` ripristina il conteggio prudente, utile solo per
 *    isolare i casi anomali.
 *
 * @returns {{tagged: boolean, skipped?: string, motivo?: string}}
 */
export function valutaConsegnato(order, { ignoraSenzaTracking = true } = {}) {
  if (order.tags?.includes(APP_TAGS.DELIVERED)) return { tagged: false, skipped: 'tag già presente' };
  if (order.displayFulfillmentStatus !== 'FULFILLED') return { tagged: false, skipped: 'ordine non completamente evaso' };

  const attive = order.fulfillments.filter((f) => f.status !== 'CANCELLED');
  if (!attive.length) return { tagged: false, skipped: 'nessuna spedizione attiva' };

  const conCodice = attive.filter((f) => (f.trackingInfo || []).some((t) => t.number));
  const daValutare = ignoraSenzaTracking ? conCodice : attive;
  if (!daValutare.length) return { tagged: false, skipped: 'nessuna spedizione tracciata' };

  if (!daValutare.every(consegnata)) return { tagged: false, skipped: 'non tutte le spedizioni consegnate' };

  const ignorate = attive.length - conCodice.length;
  return {
    tagged: true,
    motivo: ignoraSenzaTracking && ignorate > 0
      ? `${daValutare.length} consegnate, ${ignorate} senza codice ignorate`
      : `${daValutare.length} consegnate`,
  };
}

/** Stato reale del collo: l'ultimo evento, con `displayStatus` come ripiego. */
export const consegnata = (f) => (f.events?.nodes?.[0]?.status ?? f.displayStatus) === 'DELIVERED';

/** Applica il tag `consegnato` se dovuto. Sottile involucro su `valutaConsegnato()`. */
export async function maybeTagDelivered(order) {
  const esito = valutaConsegnato(order);
  if (!esito.tagged) return { skipped: esito.skipped };
  await addOrderTags(order.id, [APP_TAGS.DELIVERED]);
  return { tagged: true, motivo: esito.motivo };
}

/* ------------------------------------------------------------------ *
 * Proiezione pubblica per la pagina tracking
 * ------------------------------------------------------------------ */

export function trackingPageUrl(orderGid) {
  const base = process.env.TRACKING_PAGE_URL; // es. https://www.check-point-store.it/pages/tracking-area

  // Senza guardia, una variabile mancante produrrebbe "undefined?o=..." e lo
  // scriverebbe come link di tracking su ordini reali, in silenzio.
  if (!/^https:\/\/.+/.test(base || '')) {
    throw new Error(
      'TRACKING_PAGE_URL mancante o non valido. ' +
      'Atteso un URL https, es. https://www.check-point-store.it/pages/tracking-area'
    );
  }

  const id = numericId(orderGid);
  return `${base.replace(/\?.*$/, '').replace(/\/$/, '')}?o=${id}&t=${makeToken(id)}`;
}

/**
 * Quanto è avanti un collo, per la presentazione.
 *
 * Non si usa RANK: lì ATTEMPTED_DELIVERY e DELAYED valgono 0 perché sono
 * eccezioni fuori scala, e perderebbero contro CONFIRMED. Qui serve invece
 * l'ordine visibile al cliente, che è esattamente fase + passo.
 */
const progress = (p) => p.phase * 10 + p.step;

/**
 * Sceglie quale versione di uno stesso collo mostrare.
 * Vince chi è più avanti; a parità, chi ha un evento reale e più recente.
 */
function pickBetterParcel(a, b) {
  if (!a) return b;
  if (progress(b) !== progress(a)) return progress(b) > progress(a) ? b : a;
  if (Boolean(b.happenedAt) !== Boolean(a.happenedAt)) return b.happenedAt ? b : a;
  if (a.happenedAt && b.happenedAt) return new Date(b.happenedAt) > new Date(a.happenedAt) ? b : a;
  return a;
}

/**
 * Colli dell'ordine, uno per codice spedizione distinto.
 *
 * Due correzioni rispetto alla lettura ingenua dei fulfillment:
 *
 * 1. Un fulfillment può portare PIÙ codici spedizione. Prendere solo il primo
 *    (`trackingInfo.find`) nascondeva i colli successivi al cliente.
 *
 * 2. Lo STESSO codice può comparire su più fulfillment dello stesso ordine —
 *    succede quando la spedizione viene registrata in più righe, ed è ciò che
 *    ha prodotto la pagina "Ordine in 2 spedizioni" con due card identiche
 *    sull'ordine 26CKPT2818. Un collo fisico è uno: si accorpano.
 *
 * L'accorpamento non è un semplice "tieni il primo": le due righe possono
 * avere stati diversi (una con eventi, una senza). Si tiene la più avanti,
 * altrimenti un pacco già in viaggio potrebbe mostrarsi "in lavorazione".
 */
export function buildParcels(order) {
  const perKey = new Map();

  for (const f of order.fulfillments) {
    if (f.status === 'CANCELLED') continue;

    const last = f.events?.nodes?.[0] || null;

    // L'ULTIMO EVENTO VINCE SUL displayStatus DI SHOPIFY.
    //
    // Shopify non fa mai uscire un fulfillment da DELIVERED: `displayStatus`
    // resta consegnato per sempre anche quando il vettore ritratta la consegna
    // e noi scriviamo un evento successivo. Verificato sul campo il 16/09/2026
    // sull'ordine 26CKPT2545: evento IN_TRANSIT accettato e salvato,
    // `displayStatus` rimasto DELIVERED.
    //
    // Fidarsi di `displayStatus` significa quindi mostrare "Ordine consegnato"
    // a un cliente il cui pacco e' ancora in viaggio, senza alcun rimedio
    // possibile. Il registro eventi invece resta corretto: e' quella la fonte
    // di verita'. `displayStatus` serve solo quando eventi non ce ne sono.
    const status = last?.status || (f.displayStatus === 'DELIVERED' ? 'DELIVERED' : 'NONE');
    const p = present(status);

    // Codici distinti dentro lo stesso fulfillment.
    const visti = new Set();

    for (const info of f.trackingInfo) {
      const key = parcelKey(info.number);
      if (!key || visti.has(key)) continue;
      visti.add(key);

      // Il codice va mostrato ripulito: spazi accidentali finirebbero nel
      // testo della card e nel link al corriere.
      const numero = String(info.number).trim();

      const candidato = {
        status,
        phase: p.phase,
        step: p.step,
        tone: p.tone,
        title: p.parcelTitle || p.title,
        sub: p.sub,
        pill: p.pill,
        number: numero,
        carrier: info.company || null,
        carrierUrl: p.phase === 2 ? carrierUrl(info.company, numero) : null,
        happenedAt: last?.happenedAt || null,
      };

      const precedente = perKey.get(key);
      const vincente = pickBetterParcel(precedente, candidato);

      // Il corriere può mancare su una riga e non sull'altra: si conserva.
      if (precedente && !vincente.carrier) {
        const company = precedente.carrier || candidato.carrier;
        if (company) {
          vincente.carrier = company;
          vincente.carrierUrl = vincente.phase === 2 ? carrierUrl(company, vincente.number) : null;
        }
      }

      perKey.set(key, vincente);
    }
  }

  return [...perKey.values()];
}

/**
 * Riduce l'ordine a ciò che la pagina può mostrare.
 * Nessun dato personale: niente nome, indirizzo, email, importi o prodotti.
 */
export function toPublicShape(order) {
  const parcels = buildParcels(order);

  // Nessuna spedizione tracciabile ancora: l'ordine è in lavorazione.
  if (!parcels.length) {
    const p = present('NONE');
    parcels.push({
      status: 'NONE', phase: 1, step: 0, tone: 'idle',
      title: p.title, sub: p.sub, pill: p.pill,
      number: null, carrier: null, carrierUrl: null, happenedAt: null,
    });
  }

  const allDelivered = parcels.every((x) => x.status === 'DELIVERED');
  const anyProcessing = parcels.some((x) => x.phase === 1);

  // La data prevista vive solo in fase 1, solo se non è ancora passata
  // e solo se l'ordine non è in `alert`.
  const etaDate = parseEtaTag(order.tags);
  const blockedByAlert = HIDE_ETA_ON_ALERT && hasAlert(order.tags);
  const showEta = anyProcessing && etaDate && etaIsStillRelevant(etaDate) && !blockedByAlert;

  // stripTags: garanzia esplicita che nessun tag ordine raggiunga il browser.
  // codice_soc, soc_atleta, soc_nome e soc_categoria contengono dati di
  // persone e società e non devono uscire da un link condivisibile.
  return stripTags({
    order: order.name,
    allDelivered,
    parcels,
    eta: showEta ? formatEtaLabel(etaDate) : null,
    tags: undefined,
  });
}
