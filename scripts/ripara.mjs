#!/usr/bin/env node
/**
 * Riparazione post-backfill — UNA SOLA VOLTA.
 *
 * Rimedia a due effetti del backfill eseguito con lo script precedente:
 *
 *   FASE A  Le spedizioni marcate DELAYED per cui ShippyPro non ha alcun
 *           evento del vettore. StatusCode 5 con Details vuoto significa
 *           "nessun dato", non "eccezione": scriverlo come DELAYED mostra
 *           "Spedizione in ritardo" su un pacco mai scansionato.
 *           Rimedio: un evento CONFIRMED, che Shopify definisce
 *           "the default value when no other information is available".
 *           La pagina torna a fase 1 "Ordine in lavorazione".
 *           I ritardi VERI (Details popolato) non vengono toccati.
 *
 *   FASE B  Gli ordini interamente consegnati rimasti senza tag `consegnato`.
 *           Due cause: lo storico chiuso da Track123, e il tag valutato su un
 *           ordine riletto prima che Shopify propagasse l'evento appena scritto.
 *
 *   node scripts/ripara.mjs                  # dry-run, non scrive
 *   node scripts/ripara.mjs --apply          # scrive davvero
 *   node scripts/ripara.mjs --days 45        # finestra (default 45)
 *
 * Nessuno stato scritto qui genera email al cliente: CONFIRMED e i tag
 * ordine non sono associati ad alcuna notifica Shopify.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql } from '../lib/shopify.js';
import { getTracking, unwrapTracking, trackingHasEvents } from '../lib/shippypro.js';
import { createFulfillmentEvent, addOrderTags } from '../lib/orders.js';
import { APP_TAGS } from '../lib/tags.js';

const APPLY = process.argv.includes('--apply');
const DAYS = Number(argValue('--days') || 45);
const OUT = `ripara-${new Date().toISOString().slice(0, 10)}.csv`;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 50, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name tags displayFulfillmentStatus
        fulfillments(first: 20) {
          id status displayStatus
          trackingInfo { number }
          events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt } }
        }
      }
    }
  }`;

async function caricaOrdini() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const q = `fulfillment_status:shipped,partial AND created_at:>=${since}`;
  const ordini = [];
  let cursor = null;
  do {
    const data = await gql(QUERY, { q, cursor });
    ordini.push(...data.orders.nodes);
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return ordini;
}

const rows = [['fase', 'ordine', 'tracking', 'prima', 'azione', 'esito']];

console.log(`\nRiparazione — finestra ${DAYS} giorni — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}\n`);

const ordini = await caricaOrdini();
console.log(`Ordini spediti nella finestra: ${ordini.length}\n`);

/* ---------------------------------------------------------------- *
 * FASE A — false DELAYED
 * ---------------------------------------------------------------- */

console.log('FASE A — spedizioni DELAYED senza eventi del vettore\n');

let aEsaminate = 0, aRiparate = 0, aRitardiVeri = 0, aErrori = 0;
const cache = new Map();

for (const order of ordini) {
  for (const f of order.fulfillments) {
    if (f.status === 'CANCELLED') continue;
    if (f.displayStatus !== 'DELAYED') continue;
    const numero = f.trackingInfo.find((t) => t.number)?.number;
    if (!numero) continue;

    aEsaminate++;
    let raw;
    try {
      if (!cache.has(numero)) cache.set(numero, await getTracking(numero));
      raw = cache.get(numero);
    } catch (err) {
      aErrori++;
      rows.push(['A', order.name, numero, 'DELAYED', '', `errore ShippyPro: ${err.message}`]);
      console.log(`  ✗ ${order.name} ${numero} — errore ShippyPro: ${err.message}`);
      continue;
    }

    // Ritardo vero: il vettore ha scansionato ed è davvero in eccezione.
    if (trackingHasEvents(unwrapTracking(raw))) {
      aRitardiVeri++;
      rows.push(['A', order.name, numero, 'DELAYED', 'nessuna', 'ritardo reale, lasciato invariato']);
      console.log(`  · ${order.name} ${numero} — ritardo reale, lasciato invariato`);
      continue;
    }

    if (!APPLY) {
      aRiparate++;
      rows.push(['A', order.name, numero, 'DELAYED', 'CONFIRMED', 'da riparare (dry-run)']);
      console.log(`  · ${order.name} ${numero} — DELAYED -> CONFIRMED (dry-run)`);
      continue;
    }

    try {
      await createFulfillmentEvent({
        fulfillmentId: f.id,
        status: 'CONFIRMED',
        happenedAt: new Date().toISOString(),
      });
      aRiparate++;
      rows.push(['A', order.name, numero, 'DELAYED', 'CONFIRMED', 'riparato']);
      console.log(`  ✓ ${order.name} ${numero} — DELAYED -> CONFIRMED`);
      await pausa(250);
    } catch (err) {
      aErrori++;
      rows.push(['A', order.name, numero, 'DELAYED', 'CONFIRMED', `errore Shopify: ${err.message}`]);
      console.log(`  ✗ ${order.name} ${numero} — errore Shopify: ${err.message}`);
    }
  }
}

/* ---------------------------------------------------------------- *
 * FASE B — tag `consegnato` mancanti
 * ---------------------------------------------------------------- */

console.log('\nFASE B — ordini consegnati senza tag consegnato\n');

let bCandidati = 0, bTaggati = 0, bErrori = 0;

for (const order of ordini) {
  if (order.displayFulfillmentStatus !== 'FULFILLED') continue;
  if (order.tags.includes(APP_TAGS.DELIVERED)) continue;

  const attive = order.fulfillments.filter((f) => f.status !== 'CANCELLED');
  if (!attive.length) continue;
  if (!attive.every((f) => f.displayStatus === 'DELIVERED')) continue;

  bCandidati++;

  if (!APPLY) {
    rows.push(['B', order.name, '', '', APP_TAGS.DELIVERED, 'da taggare (dry-run)']);
    console.log(`  · ${order.name} — tag ${APP_TAGS.DELIVERED} (dry-run)`);
    continue;
  }

  try {
    await addOrderTags(order.id, [APP_TAGS.DELIVERED]);
    bTaggati++;
    rows.push(['B', order.name, '', '', APP_TAGS.DELIVERED, 'taggato']);
    console.log(`  ✓ ${order.name} — tag ${APP_TAGS.DELIVERED}`);
    await pausa(250);
  } catch (err) {
    bErrori++;
    rows.push(['B', order.name, '', '', APP_TAGS.DELIVERED, `errore Shopify: ${err.message}`]);
    console.log(`  ✗ ${order.name} — ${err.message}`);
  }
}

fs.writeFileSync(OUT, rows.map((r) => r.map(csv).join(',')).join('\n'));

console.log('\n────────────────────────────────');
console.log(`FASE A  DELAYED esaminate: ${aEsaminate}`);
console.log(`        ${APPLY ? 'riparate' : 'da riparare'}: ${aRiparate} · ritardi reali lasciati: ${aRitardiVeri} · errori: ${aErrori}`);
console.log(`FASE B  ${APPLY ? 'taggati' : 'da taggare'}: ${APPLY ? bTaggati : bCandidati} · errori: ${bErrori}`);
console.log(`Report: ${OUT}`);
if (!APPLY) console.log('\nNessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply.\n');
else console.log('');

function csv(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
