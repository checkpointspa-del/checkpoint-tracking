#!/usr/bin/env node
/**
 * Mostra cosa è stato letto dal file .env, senza rivelare nessun valore.
 *
 * Serve a distinguere "variabile scritta male" da "file non letto", che
 * guardando un messaggio di errore sono indistinguibili.
 *
 *   node scripts/test-env.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../lib/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env');

console.log(`\nFile: ${file}`);

if (!fs.existsSync(file)) {
  console.log('  ✗ non esiste — crealo con:  cp .env.example .env\n');
  process.exit(1);
}

const raw = fs.readFileSync(file);
console.log(`  ✓ trovato, ${raw.length} byte`);

// Un BOM o una codifica UTF-16 rendono illeggibile la prima riga.
if (raw[0] === 0xff || raw[0] === 0xfe) {
  console.log('  ⚠ il file è in UTF-16: risalvalo come UTF-8 senza BOM');
}
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  console.log('  ⚠ il file ha un BOM UTF-8: la prima variabile potrebbe non essere letta');
}

const CHIAVI = [
  'SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_API_VERSION',
  'APP_BASE_URL', 'TRACKING_TOKEN_SECRET', 'TRACKING_PAGE_URL', 'STOREFRONT_ORIGIN',
  'SHOP_TIMEZONE', 'SHIPPYPRO_API_KEY', 'SHIPPYPRO_WEBHOOK_SECRET', 'DRY_RUN',
];

console.log('\nVariabili caricate (valori nascosti):\n');
for (const k of CHIAVI) {
  const v = process.env[k];
  const stato = v && String(v).trim() ? `✓ ${String(v).trim().length} caratteri` : '· assente';
  console.log(`  ${k.padEnd(26)} ${stato}`);
}

// Righe che il parser non ha saputo interpretare: quasi sempre il vero problema.
const brutte = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .map((l, i) => [i + 1, l.trim()])
  .filter(([, l]) => l && !l.startsWith('#') && !l.includes('='));

if (brutte.length) {
  console.log('\nRighe ignorate perché senza "=":\n');
  for (const [n, l] of brutte) console.log(`  riga ${n}: ${l.slice(0, 60)}`);
}

console.log('');
