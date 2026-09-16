#!/usr/bin/env node
/**
 * Riscrittura massiva dei link di tracking — UNA SOLA VOLTA.
 *
 * Porta gli ordini già spediti a puntare alla nostra pagina.
 * Da qui in avanti ci pensa il webhook `fulfillments/create`.
 *
 *   node scripts/rewrite-urls.mjs              # dry-run
 *   node scripts/rewrite-urls.mjs --apply
 *   node scripts/rewrite-urls.mjs --days 90
 *
 * notifyCustomer è sempre false: nessuna email parte da questa operazione.
 */

import '../lib/env.js';
import { gql } from '../lib/shopify.js';
import { rewriteTrackingUrl, trackingPageUrl } from '../lib/orders.js';

const APPLY = process.argv.includes('--apply');
const i = process.argv.indexOf('--days');
const DAYS = Number(i > -1 ? process.argv[i + 1] : 45);

const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 50, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name
        fulfillments(first: 20) { id status trackingInfo { company number url } }
      }
    }
  }`;

const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
console.log(`\nRiscrittura URL — finestra ${DAYS} giorni — ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

// Senza lo scope read_all_orders, Shopify espone solo gli ultimi 60 giorni.
if (DAYS > 55) {
  console.log(`  ⚠  ${DAYS} giorni superano il limite di 60 giorni della Admin API.`);
  console.log('     Gli ordini più vecchi non compaiono, senza alcun errore.\n');
}

let cursor = null, done = 0, skipped = 0, failed = 0;
do {
  const data = await gql(QUERY, { q: `fulfillment_status:shipped AND created_at:>=${since}`, cursor });
  for (const order of data.orders.nodes) {
    for (const f of order.fulfillments) {
      if (f.status === 'CANCELLED') continue;
      if (!f.trackingInfo.some((t) => t.number)) continue;

      const target = trackingPageUrl(order.id);
      if (f.trackingInfo.every((t) => t.url === target)) { skipped++; continue; }

      if (!APPLY) {
        console.log(`  · ${order.name} → ${target}`);
        done++;
        continue;
      }
      try {
        await rewriteTrackingUrl(order, f);
        console.log(`  ✓ ${order.name}`);
        done++;
      } catch (err) {
        console.log(`  ✗ ${order.name} — ${err.message}`);
        failed++;
      }
    }
  }
  cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
} while (cursor);

console.log(`\n${APPLY ? 'Aggiornati' : 'Da aggiornare'}: ${done} · Già corretti: ${skipped} · Errori: ${failed}\n`);
