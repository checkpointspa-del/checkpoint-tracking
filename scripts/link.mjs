#!/usr/bin/env node
/**
 * Genera il link della pagina tracking per un ordine, e verifica che l'API
 * in produzione lo accetti.
 *
 * È il controllo che i segreti locali e quelli su Vercel coincidano:
 * se TRACKING_TOKEN_SECRET è diverso fra i due, il token non viene
 * riconosciuto e l'API risponde 404. Meglio scoprirlo qui che dopo aver
 * riscritto i link su centinaia di ordini.
 *
 *   node scripts/link.mjs 26CKPT2221
 *   node scripts/link.mjs 26CKPT2221 --check   # interroga anche l'API
 */

import '../lib/env.js';
import { gql, numericId } from '../lib/shopify.js';
import { trackingPageUrl } from '../lib/orders.js';

const arg = process.argv[2];
const CHECK = process.argv.includes('--check');

if (!arg || arg.startsWith('--')) {
  console.error('\nUso: node scripts/link.mjs <numero-ordine> [--check]\n');
  process.exit(1);
}

const name = arg.replace(/^#/, '');
const data = await gql(
  `query($q: String!) { orders(first: 5, query: $q) { nodes { id name } } }`,
  { q: `name:${name}` }
);

const order = data.orders.nodes.find((o) => o.name.replace(/^#/, '') === name) || data.orders.nodes[0];
if (!order) {
  console.error(`\nOrdine "${name}" non trovato.`);
  console.error('Ricorda: senza read_all_orders si vedono solo gli ultimi 60 giorni.\n');
  process.exit(1);
}

let url;
try {
  url = trackingPageUrl(order.id);
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

console.log(`\nOrdine ${order.name} (id ${numericId(order.id)})\n`);
console.log(`  ${url}\n`);

if (!CHECK) {
  console.log('Aggiungi --check per verificare che l\'API in produzione accetti il token.\n');
  process.exit(0);
}

const api = process.env.APP_BASE_URL;
if (!api) {
  console.error('APP_BASE_URL non configurato: impossibile verificare.\n');
  process.exit(1);
}

const query = url.slice(url.indexOf('?'));
const res = await fetch(`${api.replace(/\/$/, '')}/api/tracking${query}`);
const body = await res.text();

console.log(`Verifica API — HTTP ${res.status}\n`);

if (res.status === 200) {
  const data = JSON.parse(body);
  console.log(`  ✓ token riconosciuto: i segreti locali e quelli su Vercel coincidono`);
  console.log(`  ordine ${data.order} · ${data.parcels.length} spedizione/i`);
  for (const p of data.parcels) {
    console.log(`    ${p.status.padEnd(18)} ${p.number || '(nessun tracking)'}`);
  }
  console.log(data.eta ? `  spedizione prevista: ${data.eta}` : '  nessuna data prevista');
} else if (res.status === 404) {
  console.log('  ✗ token non riconosciuto.');
  console.log('    TRACKING_TOKEN_SECRET locale e su Vercel devono essere IDENTICI.');
} else {
  console.log(`  ✗ ${body.slice(0, 200)}`);
}
console.log('');
