#!/usr/bin/env node
/**
 * Diagnostica: perche' una spedizione risulta DELAYED?
 *
 * StatusCode 5 in ShippyPro significa "Exception", ma su una LDV appena
 * creata significa invece "nessun dato". La differenza sta in `Details`
 * e `FirstStatusDate`, che il backfill NON guarda (vedi trackingHasEvents).
 *
 *   node scripts/probe-delayed.mjs 3UW1JS2038631 3UW1JRZ000047 ...
 *   node scripts/probe-delayed.mjs --csv backfill-2026-08-27.csv --stato DELAYED --max 20
 *
 * Legge soltanto. Non scrive nulla, ne' su Shopify ne' su ShippyPro.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { getTracking, trackingHasEvents, unwrapTracking } from '../lib/shippypro.js';
import { mapShippyProStatus } from '../lib/status.js';

const arg = (f) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : null;
};

let codes = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/\.csv$/.test(a));
const csvPath = arg('--csv');
if (csvPath) {
  const wanted = arg('--stato') || 'DELAYED';
  const max = Number(arg('--max') || 20);
  codes = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1)
    .map((r) => r.split(','))
    .filter((c) => c[5] === wanted)
    .map((c) => c[1])
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .slice(0, max);
  console.log(`\n${codes.length} codici con stato ${wanted} da ${csvPath}\n`);
}

if (!codes.length) {
  console.log('Nessun codice. Passa i tracking number o usa --csv <file>.');
  process.exit(1);
}

let senzaEventi = 0;
for (const c of codes) {
  try {
    const raw = await getTracking(c);
    const dettagli = Array.isArray(raw?.Details) ? raw.Details : [];
    const eventi = trackingHasEvents(raw);
    if (!eventi) senzaEventi++;
    const m = mapShippyProStatus(unwrapTracking(raw));
    console.log([
      c.padEnd(22),
      `SC=${raw?.StatusCode ?? '-'}`,
      `Ext=${raw?.ExtendedStatusCode ?? '-'}`,
      `Details=${String(dettagli.length).padStart(2)}`,
      `First=${raw?.FirstStatusDate ?? '-'}`,
      `Compl=${raw?.Completed ?? '-'}`,
      `Late=${raw?.Late ?? '-'}`,
      eventi ? 'eventi=SI ' : 'eventi=NO ',
      `-> ${m.status ?? '—'}`,
      `| ${(m.message || '').slice(0, 60)}`,
    ].join('  '));
  } catch (err) {
    console.log(`${c.padEnd(22)}  ERRORE  ${err.message.slice(0, 120)}`);
  }
}

console.log(`\nSenza eventi reali del vettore: ${senzaEventi} su ${codes.length}`);
if (senzaEventi) {
  console.log('Queste NON sono spedizioni in ritardo: sono LDV senza dati.');
  console.log('Scriverle come DELAYED mostrerebbe "Spedizione in ritardo" al cliente.\n');
}
