#!/usr/bin/env node
/**
 * Riparazione dei falsi "consegnato".
 *
 * Riapre le spedizioni che l'app ha chiuso come DELIVERED senza evidenza del
 * vettore, e toglie il tag `consegnato` agli ordini che di conseguenza non lo
 * meritano più.
 *
 * Perché serve uno script dedicato
 * --------------------------------
 * I fulfillment event sono append-only: l'evento sbagliato non si cancella,
 * si può solo scrivere un evento successivo. E `shouldWriteEvent()` blocca per
 * sempre qualsiasi scrittura su un fulfillment già DELIVERED — è la regola
 * giusta in produzione, ma è esattamente ciò che impedisce all'app di
 * correggersi da sola. Qui il blocco viene scavalcato di proposito, una volta,
 * su una lista chiusa di ordini.
 *
 * Uso
 * ---
 *   node scripts/ripara-consegnati.mjs --csv audit-consegnati-2026-09-16.csv
 *       dry-run: dice cosa farebbe, non scrive nulla
 *
 *   node scripts/ripara-consegnati.mjs --csv ... --apply --max 1
 *       PROVA su un solo ordine, sempre consigliata.
 *
 * Cosa succede davvero su Shopify (verificato il 16/09/2026, ordine 26CKPT2545)
 * ---------------------------------------------------------------------------
 * L'evento correttivo viene accettato e salvato, ma `displayStatus` resta
 * DELIVERED per sempre: Shopify non fa uscire un fulfillment dallo stato
 * terminale. Non e' un errore dello script ed e' inutile insistere.
 * La riparazione funziona lo stesso perche' `buildParcels()` in lib/orders.js
 * legge l'ultimo evento, non `displayStatus`. Senza quella modifica questo
 * script non cambia nulla per il cliente.
 *
 *   node scripts/ripara-consegnati.mjs --csv ... --apply
 *       applica a tutta la lista
 *
 *   --ordini 26CKPT2481,26CKPT2545     lista esplicita invece del CSV
 *   --verdetto SOSPETTO                filtro sul CSV (default: SOSPETTO)
 *   --senza-tag                        non toccare i tag, solo gli eventi
 *
 * Stato correttivo
 * ----------------
 * Non si inventa nulla: ShippyPro viene interrogato al momento della
 * riparazione.
 *
 *   - evidenza reale del vettore  -> si scrive lo stato corrente di ShippyPro
 *   - nessuna evidenza            -> CONFIRMED, che Shopify definisce
 *                                    "the default value when no other
 *                                    information is available"
 *
 * PRIMA DI --apply
 * ----------------
 * Verificare nelle impostazioni dello store che le notifiche cliente sugli
 * eventi di spedizione siano disattivate: `FulfillmentEventInput` non ha
 * `notifyCustomer` e non esiste alcuna leva API per silenziarle.
 * Verificare anche che non esistano automazioni Shopify Flow sul tag
 * `consegnato`.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql, assertNoUserErrors, sleep } from '../lib/shopify.js';
import { getTracking, unwrapTracking, trackingHasEvents } from '../lib/shippypro.js';
import { mapShippyProStatus } from '../lib/status.js';
import { APP_TAGS } from '../lib/tags.js';

/* ------------------------------------------------------------------ *
 * Argomenti
 * ------------------------------------------------------------------ */

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};

const APPLY = process.argv.includes('--apply');
const SENZA_TAG = process.argv.includes('--senza-tag');
const MAX = Number(arg('--max') || 0);
const CSV_IN = arg('--csv');
const VERDETTO = arg('--verdetto') || 'SOSPETTO';
const ORDINI = (arg('--ordini') || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = `ripara-consegnati-${new Date().toISOString().slice(0, 10)}.csv`;

/* ------------------------------------------------------------------ *
 * Lista di lavoro
 * ------------------------------------------------------------------ */

/** Parser CSV minimo, sufficiente per il formato prodotto da audit-consegnati. */
function leggiCsv(path) {
  const righe = fs.readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const intestazione = righe.shift().split(',');
  return righe.map((r) => {
    const celle = [];
    let cur = '', dentro = false;
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === '"') {
        if (dentro && r[i + 1] === '"') { cur += '"'; i++; } else dentro = !dentro;
      } else if (ch === ',' && !dentro) { celle.push(cur); cur = ''; }
      else cur += ch;
    }
    celle.push(cur);
    return Object.fromEntries(intestazione.map((c, i) => [c, celle[i] ?? '']));
  });
}

let bersagli = [];
if (CSV_IN) {
  bersagli = leggiCsv(CSV_IN)
    .filter((r) => r.verdetto.startsWith(VERDETTO))
    .map((r) => ({ ordine: r.ordine, tracking: r.tracking }));
} else if (ORDINI.length) {
  bersagli = ORDINI.map((o) => ({ ordine: o, tracking: null }));
} else {
  console.log('Serve --csv <file> oppure --ordini 26CKPT1234,26CKPT5678');
  process.exit(1);
}

// Un ordine può comparire più volte (stesso codice su più fulfillment):
// si lavora per ordine, i fulfillment si risolvono dopo.
const perOrdine = new Map();
for (const b of bersagli) {
  if (!perOrdine.has(b.ordine)) perOrdine.set(b.ordine, new Set());
  if (b.tracking) perOrdine.get(b.ordine).add(b.tracking);
}
let lista = [...perOrdine.entries()].map(([ordine, tk]) => ({ ordine, trackings: [...tk] }));
if (MAX > 0) lista = lista.slice(0, MAX);

/* ------------------------------------------------------------------ *
 * Shopify
 * ------------------------------------------------------------------ */

const ORDER_FIELDS = `
  id name tags displayFulfillmentStatus
  fulfillments(first: 20) {
    id status displayStatus
    trackingInfo { company number }
    events(first: 3, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt message } }
  }`;

async function trovaOrdine(nome) {
  const data = await gql(
    `query($q: String!) { orders(first: 5, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
    { q: `name:${nome}` }
  );
  return data.orders.nodes.find((o) => o.name === nome) || null;
}

async function scriviEvento(fulfillmentId, status, message) {
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
        happenedAt: new Date().toISOString(),
        ...(message ? { message: message.slice(0, 240) } : {}),
      },
    }
  );
  return assertNoUserErrors(data.fulfillmentEventCreate, 'fulfillmentEventCreate').fulfillmentEvent;
}

async function togliTag(orderGid, tags) {
  const data = await gql(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: orderGid, tags }
  );
  return assertNoUserErrors(data.tagsRemove, 'tagsRemove');
}

/* ------------------------------------------------------------------ *
 * Esecuzione
 * ------------------------------------------------------------------ */

const righe = [['ordine', 'tracking', 'statoPrima', 'shippyPro', 'statoScritto', 'ultimoEventoDopo', 'tag', 'esito']];
let riparati = 0, saltati = 0, errori = 0;

console.log(`\nRiparazione falsi consegnati — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}`);
console.log(`Ordini in lista: ${lista.length}${MAX ? ` (limitati a ${MAX})` : ''}\n`);

if (APPLY && !MAX) {
  console.log('  !  Stai per scrivere su tutti gli ordini della lista.');
  console.log('     Se non hai ancora provato con --apply --max 1, fallo prima: nessuno');
  console.log('     ha verificato che Shopify faccia uscire un fulfillment da DELIVERED.\n');
}

for (const voce of lista) {
  const ordine = await trovaOrdine(voce.ordine);
  if (!ordine) {
    errori++;
    righe.push([voce.ordine, '', '', '', '', '', '', 'ordine non trovato (fuori dai 60 giorni?)']);
    console.log(`  x ${voce.ordine} — ordine non trovato`);
    continue;
  }

  // Fulfillment da riaprire: quelli consegnati che portano uno dei codici in
  // lista. Senza codici in lista, tutti i consegnati dell'ordine.
  const candidati = ordine.fulfillments.filter((f) => {
    if (f.status === 'CANCELLED') return false;
    if (f.displayStatus !== 'DELIVERED') return false;
    if (!voce.trackings.length) return true;
    return f.trackingInfo.some((t) => voce.trackings.includes(String(t.number || '').trim()));
  });

  if (!candidati.length) {
    saltati++;
    righe.push([voce.ordine, voce.trackings.join(' '), '', '', '', '', '', 'no-op: nessun fulfillment consegnato da riaprire']);
    console.log(`  · ${voce.ordine} — niente da riaprire`);
    continue;
  }

  for (const f of candidati) {
    const numero = f.trackingInfo.find((t) => t.number)?.number || '';

    // Stato corretto secondo ShippyPro, adesso.
    let statoSp = '', descrSp = '', evidenza = false;
    if (numero && process.env.SHIPPYPRO_API_KEY) {
      try {
        const raw = await getTracking(numero);
        evidenza = trackingHasEvents(raw);
        const m = mapShippyProStatus(unwrapTracking(raw));
        statoSp = m.status || '';
        descrSp = m.message || '';
      } catch (err) {
        descrSp = `errore ShippyPro: ${err.message.slice(0, 80)}`;
      }
    }

    // Con evidenza reale si scrive ciò che dice il vettore, purché non sia di
    // nuovo DELIVERED: in quel caso la consegna è vera e non c'è nulla da fare.
    // Senza evidenza si torna a CONFIRMED.
    if (evidenza && statoSp === 'DELIVERED') {
      saltati++;
      righe.push([ordine.name, numero, f.displayStatus, `${statoSp} (evidenza reale)`, '', f.displayStatus, '', 'no-op: ShippyPro conferma la consegna']);
      console.log(`  · ${ordine.name} ${numero} — ShippyPro conferma la consegna, lasciato invariato`);
      continue;
    }
    const daScrivere = evidenza && statoSp ? statoSp : 'CONFIRMED';
    const nota = evidenza ? (descrSp || `stato ShippyPro: ${statoSp}`) : 'stato ripristinato: consegna scritta senza evidenza del vettore';

    if (!APPLY) {
      riparati++;
      righe.push([ordine.name, numero, f.displayStatus, evidenza ? statoSp : 'nessuna evidenza', daScrivere, '', '', 'da riparare (dry-run)']);
      console.log(`  · ${ordine.name} ${numero} — DELIVERED -> ${daScrivere} (dry-run)`);
      continue;
    }

    try {
      await scriviEvento(f.id, daScrivere, nota);
      await sleep(400);

      const dopo = await trovaOrdine(ordine.name);
      const fDopo = dopo?.fulfillments.find((x) => x.id === f.id);

      // Su Shopify `displayStatus` NON esce mai da DELIVERED: e' un limite
      // della piattaforma, verificato il 16/09/2026 sull'ordine 26CKPT2545.
      // L'evento pero' viene accettato e salvato, e `buildParcels()` legge
      // l'ultimo evento: e' quello il risultato da controllare.
      const eventoDopo = fDopo?.events?.nodes?.[0]?.status || '?';

      let esitoTag = '';
      if (!SENZA_TAG && dopo) {
        if (!dopo.tags.includes(APP_TAGS.DELIVERED)) {
          esitoTag = 'tag non presente';
        } else {
          // Stesso motivo: il tag si decide sull'ultimo evento di ogni
          // spedizione, non su `displayStatus` che resterebbe sempre DELIVERED
          // e impedirebbe per sempre la rimozione.
          const attivi = dopo.fulfillments.filter((x) => x.status !== 'CANCELLED');
          const tuttiConsegnati =
            attivi.length > 0 &&
            attivi.every((x) => (x.events?.nodes?.[0]?.status || x.displayStatus) === 'DELIVERED');

          if (tuttiConsegnati) {
            esitoTag = 'tag lasciato: le altre spedizioni risultano consegnate';
          } else {
            await togliTag(dopo.id, [APP_TAGS.DELIVERED]);
            esitoTag = 'tag consegnato rimosso';
          }
        }
      }

      riparati++;
      righe.push([ordine.name, numero, 'DELIVERED', evidenza ? statoSp : 'nessuna evidenza', daScrivere, eventoDopo, esitoTag, 'riparato']);
      const allarme = eventoDopo === daScrivere ? '' : `  <-- ATTENZIONE: ultimo evento ${eventoDopo}, atteso ${daScrivere}`;
      console.log(`  ok ${ordine.name} ${numero} — ultimo evento ora ${eventoDopo}${esitoTag ? ` · ${esitoTag}` : ''}${allarme}`);

      await sleep(300);
    } catch (err) {
      errori++;
      righe.push([ordine.name, numero, 'DELIVERED', evidenza ? statoSp : 'nessuna evidenza', daScrivere, '', '', `errore: ${err.message.slice(0, 140)}`]);
      console.log(`  x ${ordine.name} ${numero} — ${err.message.slice(0, 140)}`);
    }
  }
}

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.writeFileSync(OUT, righe.map((r) => r.map(csv).join(',')).join('\n'));

console.log(`\nRiparati: ${riparati} · No-op: ${saltati} · Errori: ${errori}`);
console.log(`Report: ${OUT}\n`);
if (!APPLY) console.log('Nessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply --max 1.\n');
