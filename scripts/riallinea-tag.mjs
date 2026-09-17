#!/usr/bin/env node
/**
 * Riallineamento del tag `consegnato` — da eseguire in locale.
 *
 *   node scripts/riallinea-tag.mjs                    # dry-run: conta e scrive il CSV
 *   node scripts/riallinea-tag.mjs --apply --max 1    # PROVA su un solo ordine
 *   node scripts/riallinea-tag.mjs --apply            # applica a tutti
 *   node scripts/riallinea-tag.mjs --dal 2026-07-24   # data di inizio (default day 1)
 *   node scripts/riallinea-tag.mjs --anche-rimozioni  # toglie il tag dove non e' piu' dovuto
 *   node scripts/riallinea-tag.mjs --rispetta-senza-tracking
 *       Comportamento prudente: un fulfillment senza codice tiene aperto l'ordine.
 *       NON è la regola Checkpoint, serve solo a isolare i casi anomali.
 *
 * PERCHÉ SERVE
 * Il backfill del 27/08 ha scritto gli eventi ma non ha taggato tutti gli ordini che
 * ne avevano diritto. In più `maybeTagDelivered` contava anche i fulfillment SENZA
 * numero di tracking: quelli non ricevono mai eventi, quindi non diventano mai
 * DELIVERED e impedivano il tag PER SEMPRE.
 *
 * Risultato: ordini consegnati da settimane che resterebbero nelle viste operative
 * del cruscotto. Questo script applica il tag che la logica di produzione, corretta,
 * avrebbe già applicato.
 *
 * ⚠️  PRIMA DI --apply: verificare se esistono automazioni Shopify Flow che reagiscono
 *     ai TAG ORDINE. Una passata massiva le innescherebbe tutte insieme. È un rischio
 *     noto e mai verificato su questo store.
 *
 * RITIRO IN NEGOZIO — perche' questo script NON filtra per metodo di consegna.
 * Il ritiro e' fuori dal perimetro del cruscotto, ma l'esclusione vive nell'app
 * (`NOT delivery_method:pick-up`), non qui. Sui dati reali ~20% degli ordini di
 * ritiro ha comunque una LDV tracciata: aggiungere il filtro qui li lascerebbe
 * senza tag e senza riassunto, cioe' aperti per sempre. Un ritiro puro invece
 * si esclude da solo, perche' non ha spedizioni tracciate.
 *
 * Scrive SOLO il tag `consegnato`. Nessun fulfillment event, nessuna email possibile.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql } from '../lib/shopify.js';
import { valutaConsegnato, addOrderTags, consegnata } from '../lib/orders.js';
import { APP_TAGS } from '../lib/tags.js';

const APPLY = process.argv.includes('--apply');
const MAX = Number(argValue('--max') || 0);
const DAL = argValue('--dal') || '2026-07-24';
/* Regola Checkpoint (31/08): si lavora PER TRACKING. Un fulfillment senza codice
   è un'evasione parziale fatta per errore e poi chiusa: la merce viaggia con il
   primo tracking dell'ordine. Vedi lib/orders.js. */
const IGNORA_SENZA_TRACKING = !process.argv.includes('--rispetta-senza-tracking');
const ANCHE_RIMOZIONI = process.argv.includes('--anche-rimozioni');
const OUT = `riallinea-tag-${new Date().toISOString().slice(0, 10)}.csv`;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt tags displayFulfillmentStatus
        fulfillments(first: 10) {
          id status displayStatus
          trackingInfo { number }
          events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status } }
        }
      }
    }
  }`;

/**
 * DUE FASI, e non e' un dettaglio.
 *
 * La query filtra su `tag_not:consegnato`, che e' esattamente cio' che questa passata
 * modifica. Paginare e scrivere insieme significa invalidare il filtro mentre lo si
 * scorre: ogni ordine taggato esce dal risultato, l'insieme si accorcia sotto il
 * cursore e le pagine successive **saltano dei record**.
 *
 * Verificato sullo store l'1/09: la passata dal 03/07 ha esaminato 242 ordini su 244
 * disponibili, e 26CKPT2142 — evaso, spedizione DELIVERED, taggabile — non e' mai
 * stato letto. Un ordine saltato in silenzio e' il difetto peggiore possibile qui:
 * resta aperto per sempre e nessuno sa perche'.
 *
 * Quindi prima si legge tutto (nessuna scrittura, nessun effetto sul filtro), poi si
 * scrive. Sono qualche centinaio di ordini: stanno in memoria senza problemi.
 */
async function leggiTutti() {
  const q = `created_at:>=${DAL} AND NOT status:cancelled AND tag_not:${APP_TAGS.DELIVERED}`;
  const out = [];
  let cursor = null;
  do {
    const data = await gql(QUERY, { q, cursor });
    out.push(...data.orders.nodes);
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

console.log(`
Riallineamento tag "${APP_TAGS.DELIVERED}" — dal ${DAL} — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}${MAX ? ` — massimo ${MAX}` : ''}
`);
if (APPLY) {
  console.log('⚠  Se esistono Shopify Flow che reagiscono ai tag ordine, questa passata le innesca.\n');
}

const rows = [['ordine', 'creato', 'statoEvasione', 'spedizioni', 'tracciate', 'consegnate', 'esito', 'motivo']];
let letti = 0, daTaggare = 0, taggati = 0, errori = 0;
const motivi = new Map();

const tuttiGliOrdini = await leggiTutti();
console.log(`Lettura completata: ${tuttiGliOrdini.length} ordini nel perimetro.\n`);

for (const o of tuttiGliOrdini) {
  letti++;
  const attive = o.fulfillments.filter((f) => f.status !== 'CANCELLED');
  const tracciate = attive.filter((f) => (f.trackingInfo || []).some((t) => t.number));
  const consegnate = tracciate.filter((f) => f.displayStatus === 'DELIVERED');

  const esito = valutaConsegnato(o, { ignoraSenzaTracking: IGNORA_SENZA_TRACKING });
  const chiave = esito.tagged ? 'DA TAGGARE' : esito.skipped;
  motivi.set(chiave, (motivi.get(chiave) || 0) + 1);

  if (!esito.tagged) {
    rows.push([o.name, o.createdAt.slice(0, 10), o.displayFulfillmentStatus,
               attive.length, tracciate.length, consegnate.length, 'resta aperto', esito.skipped]);
    continue;
  }

  daTaggare++;
  rows.push([o.name, o.createdAt.slice(0, 10), o.displayFulfillmentStatus,
             attive.length, tracciate.length, consegnate.length,
             APPLY ? 'taggato' : 'da taggare', esito.motivo || '']);

  if (!APPLY) continue;
  try {
    await addOrderTags(o.id, [APP_TAGS.DELIVERED]);
    taggati++;
    if (taggati % 25 === 0) console.log(`  ...${taggati} ordini taggati`);
    if (MAX && taggati >= MAX) { console.log(`\n  Limite --max ${MAX} raggiunto: mi fermo qui.`); break; }
  } catch (err) {
    errori++;
    console.error(`  ✗ ${o.name}: ${err.message}`);
    rows[rows.length - 1][6] = `errore: ${err.message}`;
  }
}

/* ------------------------------------------------------------------ *
 * Seconda fase: togliere il tag dove non e' piu' dovuto.
 *
 * La prima fase filtra su `tag_not:consegnato`, quindi puo' solo aggiungere.
 * Ma un tag puo' diventare sbagliato: una consegna falsa corretta da
 * `ripara-consegnati` o da `riconcilia` lascia l'ordine taggato con una
 * spedizione che non e' piu' DELIVERED. Senza questa fase il tag resta li'
 * e l'ordine sparisce dalle viste operative pur non essendo consegnato.
 * ------------------------------------------------------------------ */

let rimossi = 0, daRimuovere = 0;

if (ANCHE_RIMOZIONI) {
  console.log('\nSeconda fase — ordini gia\' taggati, verifica che il tag sia ancora dovuto.\n');

  const qTaggati = `created_at:>=${DAL} AND NOT status:cancelled AND tag:${APP_TAGS.DELIVERED}`;
  const taggatiOrdini = [];
  let cursor2 = null;
  do {
    const data = await gql(QUERY, { q: qTaggati, cursor: cursor2 });
    taggatiOrdini.push(...data.orders.nodes);
    cursor2 = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor2);

  console.log(`Ordini taggati nel perimetro: ${taggatiOrdini.length}\n`);

  for (const o of taggatiOrdini) {
    const attive = o.fulfillments.filter((f) => f.status !== 'CANCELLED');
    const tracciate = attive.filter((f) => (f.trackingInfo || []).some((t) => t.number));
    const consegnate = tracciate.filter(consegnata);

    // Il tag resta dovuto se tutte le spedizioni tracciate risultano consegnate.
    const ancoraDovuto = tracciate.length > 0 && consegnate.length === tracciate.length;
    if (ancoraDovuto) continue;

    daRimuovere++;
    const motivo = tracciate.length === 0
      ? 'nessuna spedizione tracciata'
      : `${tracciate.length - consegnate.length} spedizioni non consegnate`;

    rows.push([o.name, o.createdAt.slice(0, 10), o.displayFulfillmentStatus,
               attive.length, tracciate.length, consegnate.length,
               APPLY ? 'tag rimosso' : 'da rimuovere', motivo]);

    if (!APPLY) continue;
    try {
      await gql(
        `mutation($id: ID!, $tags: [String!]!) {
           tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
         }`,
        { id: o.id, tags: [APP_TAGS.DELIVERED] }
      );
      rimossi++;
      console.log(`  - ${o.name} — tag rimosso (${motivo})`);
    } catch (err) {
      errori++;
      console.error(`  x ${o.name}: ${err.message}`);
      rows[rows.length - 1][6] = `errore: ${err.message}`;
    }
  }
}

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.writeFileSync(OUT, rows.map((r) => r.map(csv).join(',')).join('\n'));

console.log(`\nOrdini esaminati:  ${letti}`);
console.log(
  IGNORA_SENZA_TRACKING
    ? "Policy:            i fulfillment senza tracking viaggiano col primo tracking"
    : "Policy:            PRUDENTE — un fulfillment senza tracking tiene aperto l'ordine",
);
console.log(`Da taggare:        ${daTaggare}   <- uscirebbero dalle viste operative`);
console.log(`Taggati:           ${taggati}`);
if (ANCHE_RIMOZIONI) {
  console.log(`${APPLY ? 'Tag rimossi' : 'Da rimuovere'}:       ${APPLY ? rimossi : daRimuovere}   <- tag non piu' dovuti`);
}
console.log(`Errori:            ${errori}`);
console.log(`\nPerché gli altri restano aperti:`);
for (const [m, n] of [...motivi.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${m}`);
}
console.log(`\nCSV: ${OUT}`);
if (!APPLY) console.log('\nNessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply.\n');
