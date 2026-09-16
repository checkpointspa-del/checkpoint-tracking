/**
 * Caricamento del file .env, senza dipendenze.
 *
 * Sostituisce `dotenv`: era l'unica dipendenza del progetto e bastava
 * un `node_modules` mancante per bloccare tutti gli script.
 * Ora il progetto ha zero dipendenze: gli script girano su una cartella
 * appena scompattata, senza `npm install`.
 *
 * Import a effetto: `import '../lib/env.js'` in cima allo script.
 * Le variabili già presenti nell'ambiente hanno la precedenza, così su
 * Vercel (dove .env non esiste) non cambia nulla.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env');

if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue; // l'ambiente vince sempre

    let value = trimmed.slice(eq + 1).trim();

    // Commento a fine riga, solo se il valore non è fra virgolette
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '').trim();
    // Virgolette di contenimento
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);

    process.env[key] = value;
  }
}
