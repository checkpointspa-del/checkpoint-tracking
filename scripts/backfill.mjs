#!/usr/bin/env node
/**
 * Sincronizzazione iniziale — UNA SOLA VOLTA.
 *
 * Prende gli ordini spediti e non ancora consegnati, legge lo stato corrente
 * su ShippyPro e allinea Shopify. Non va deployato: si esegue in locale.
 *
 *   node scripts/backfill.mjs                  # dry-run, scrive solo il CSV
 *   node scripts/backfill.mjs --apply          # scrive davvero
 *   node scripts/backfill.mjs --days 60        # finestra temporale (default 45)
 *
 * PRIMA DI --apply: disattivare in Shopify le notifiche cliente
 * "Consegnato" e "In consegna", altrimenti parte un'email per ogni ordine.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql } from '../lib/shopify.js';
import { getTracking, unwrapTracking, trackingHasEvents } from '../lib/shippypro.js';
import { mapShippyProStatus } from '../lib/status.js';
import { shouldWriteEvent, createFulfillmentEvent, maybeTagDelivered, getOrderByGid } from '../lib/orders.js';

const APPLY = process.argv.includes('--apply');
const DAYS = Number(argValue('--days') || 45);
const OUT = `backfill-${new Date().toISOString().slice(0, 10)}.csv`;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 50, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name tags displayFulfillmentStatus
        fulfillments(first: 20) {
          id status displayStatus
          trackingInfo { company number url }
          events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt } }
        }
      }
    }
  }`;

async function* shippedOrders() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const q = `fulfillment_status:shipped AND created_at:>=${since}`;
  let cursor = null;
  do {
    const data = await gql(QUERY, { q, cursor });
    for (const o of data.orders.nodes) yield o;
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
}

const rows = [['ordine', 'tracking', 'corriere', 'stato_shopify_prima', 'stato_shippypro', 'stato_da_scrivere', 'quando', 'esito']];

console.log(`\nBackfill — finestra ${DAYS} giorni — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}\n`);

// Senza lo scope read_all_orders, Shopify espone solo gli ultimi 60 giorni.
// Oltre, la query non dà errore: restituisce semplicemente meno ordini.
if (DAYS > 55) {
  console.log(`  ⚠  ${DAYS} giorni superano il limite di 60 giorni della Admin API.`);
  console.log('     Senza lo scope read_all_orders gli ordini più vecchi non compaiono,');
  console.log('     senza alcun errore. Usa --days 45 oppure richiedi lo scope.\n');
}

let seen = 0, written = 0, skipped = 0, failed = 0;

for await (const order of shippedOrders()) {
  for (const f of order.fulfillments) {
    if (f.status === 'CANCELLED') continue;
    if (f.displayStatus === 'DELIVERED') continue; // già chiusa, si salta
    const info = f.trackingInfo.find((t) => t.number);
    if (!info) continue;

    seen++;
    let raw, status, esito;
    const quando = new Date().toISOString();

    try {
      raw = await getTracking(info.number);
    } catch (err) {
      esito = `errore ShippyPro: ${err.message}`;
      failed++;
      rows.push([order.name, info.number, info.company || '', f.displayStatus, '', '', quando, esito]);
      console.log(`  ✗ ${order.name} ${info.number} — ${esito}`);
      continue;
    }

    const evento = unwrapTracking(raw);

    // ⚠️  IL GUARD. NON RIMUOVERLO E NON REIMPLEMENTARLO QUI.
    //
    // Su una LDV che il vettore non ha ancora scansionato, GetTracking risponde
    // con uno `StatusCode` di primo livello senza alcuna cronologia:
    // `Details: []` e `FirstStatusDate: "0"`. Quel codice non descrive il pacco,
    // descrive l'assenza di dati.
    //
    // Fidarsene ha gia' prodotto due volte dati falsi in produzione:
    //   27/08/2026  StatusCode 5 -> 70 false "spedizioni in ritardo"
    //   28/08/2026  StatusCode 6 -> 21 false CONSEGNE
    //
    // Le false consegne sono irreparabili: DELIVERED e' terminale e su Shopify
    // un fulfillment non ne esce piu'.
    //
    // Questo script NON reimplementa la logica delle lib: la importa.
    if (!trackingHasEvents(evento)) {
      skipped++;
      rows.push([order.name, info.number, info.company || '', f.displayStatus, describe(raw), '', quando, 'no-op: nessun evento dal vettore']);
      console.log(`  · ${order.name} ${info.number} — nessun evento dal vettore`);
      continue;
    }

    ({ status } = mapShippyProStatus(evento));

    const decision = shouldWriteEvent(f, status, quando);
    if (!decision.write) {
      esito = `no-op: ${decision.reason}`;
      skipped++;
    } else if (!APPLY) {
      esito = 'da scrivere (dry-run)';
    } else {
      try {
        await createFulfillmentEvent({ fulfillmentId: f.id, status, happenedAt: quando });
        if (status === 'DELIVERED') await maybeTagDelivered(await getOrderByGid(order.id));
        esito = 'scritto';
        written++;
      } catch (err) {
        esito = `errore Shopify: ${err.message}`;
        failed++;
      }
    }

    rows.push([order.name, info.number, info.company || '', f.displayStatus, describe(raw), status || '', quando, esito]);
    console.log(`  ${esito === 'scritto' ? '✓' : '·'} ${order.name} ${info.number} → ${status || '—'} (${esito})`);
  }
}

fs.writeFileSync(OUT, rows.map((r) => r.map(csv).join(',')).join('\n'));

console.log(`\nSpedizioni esaminate: ${seen}`);
console.log(`Scritte: ${written} · No-op: ${skipped} · Errori: ${failed}`);
console.log(`Report: ${OUT}\n`);
if (!APPLY) console.log('Nessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply.\n');

/**
 * Riga diagnostica per il CSV. `unwrapTracking` arriva da lib/shippypro.js:
 * la copia locale di `unwrap()` che stava qui saltava il controllo sugli
 * eventi del vettore ed e' la causa diretta dei falsi stati del 27-28/08/2026.
 */
function describe(raw) {
  const u = unwrapTracking(raw) || {};
  const dettagli = Array.isArray(raw?.Details) ? raw.Details.length : 0;
  return [
    u.StatusCode ?? u.status_code ?? '',
    `Details=${dettagli}`,
    u.StatusDescription ?? u.Status ?? '',
  ].filter(Boolean).join(' ');
}
function csv(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
