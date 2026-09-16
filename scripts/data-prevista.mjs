#!/usr/bin/env node
/**
 * Correzione UNA TANTUM del tag `spedizione_prevista` sull'arretrato.
 *
 * ⚠️  ATTENZIONE ARCHITETTURALE, da leggere prima di usarlo.
 *
 * `spedizione_prevista` e' un tag di proprieta' dell'ERP: vedi
 * FOREIGN_TAG_PREFIXES in lib/tags.js — "l'app li legge, non li tocca mai".
 * Questo script rompe deliberatamente quella regola per rimettere in ordine
 * gli ordini che oggi la data non ce l'hanno affatto.
 *
 * NON e' il posto dove far vivere la regola. Per gli ordini futuri la regola
 * va implementata in Beestore, dove il tag nasce. Se questo script diventa
 * ricorrente, il tag ha due padroni e nessuno sa piu' quale data e' vera.
 *
 * REGOLA APPLICATA (Checkpoint, 01/09/2026)
 *   - categoria SCUOLACALCIO2020/2021/2022  -> 2026-09-04, fissa
 *   - tutte le altre categorie:
 *       ordine entro le 08:00  -> +10 giorni lavorativi dalla data d'acquisto
 *       ordine dopo le 08:00   -> +11 giorni lavorativi
 *     Giorni lavorativi = esclusi sabato, domenica e festivi italiani.
 *     Ora e data valutate in Europe/Rome, non in UTC.
 *
 * Gli ordini che hanno GIA' una data valida non vengono toccati:
 * questo script riempie i vuoti, non riscrive le scelte di qualcun altro.
 *
 *   node scripts/data-prevista.mjs                    # dry-run + CSV
 *   node scripts/data-prevista.mjs --apply --max 1    # PROVA su un ordine
 *   node scripts/data-prevista.mjs --apply            # applica
 *   node scripts/data-prevista.mjs --soc TUTTE        # non solo Sporting Castellana
 *   node scripts/data-prevista.mjs --dal 2026-07-24   # inizio perimetro
 *
 * Scrive SOLO il tag `spedizione_prevista=...`. Nessun evento, nessuna email.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql } from '../lib/shopify.js';
import { addOrderTags, removeOrderTags } from '../lib/orders.js';
import { parseEtaTag, dataEOraShop, calcolaDataPrevista, categoriaDaTag, REGOLA_ETA } from '../lib/eta.js';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const APPLY = process.argv.includes('--apply');
const MAX   = Number(argValue('--max') || 0);
const DAL   = argValue('--dal') || '2026-07-24';
const SOC   = argValue('--soc') || 'SPORTINGC2627';
/* Elenco di ordini di cui RISCRIVERE la data anche se ce l'hanno gia'.
   Serve solo per correggere cio' che abbiamo scritto noi oggi: le date messe
   dall'ERP o a mano non si toccano. Es: --correggi 26CKPT2332,26CKPT2333 */
const CORREGGI = new Set((argValue('--correggi') || '').split(',').map((x) => x.trim()).filter(Boolean));
const OUT   = `data-prevista-${new Date().toISOString().slice(0, 10)}.csv`;

const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { id name createdAt tags displayFulfillmentStatus }
    }
  }`;

/* Due fasi: si legge tutto PRIMA di scrivere. La query filtra su tag che
   questa passata modifica, e paginare mentre si scrive fa saltare record.
   Lezione imparata sul campo con riallinea-tag.mjs il 01/09. */
async function leggiTutti() {
  const q = [
    `created_at:>=${DAL}`,
    'NOT status:cancelled',
    'tag_not:consegnato',
    SOC === 'TUTTE' ? null : `tag:'codice_soc=${SOC}'`,
  ].filter(Boolean).join(' AND ');

  const out = [];
  let cursor = null;
  do {
    const d = await gql(QUERY, { q, cursor });
    out.push(...d.orders.nodes);
    cursor = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

console.log(`
Data prevista di spedizione — dal ${DAL} — società ${SOC} — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}${MAX ? ` — massimo ${MAX}` : ''}

⚠  spedizione_prevista è un tag dell'ERP. Questa è una correzione una tantum
   sull'arretrato, non il posto dove far vivere la regola.
`);

const ordini = await leggiTutti();
console.log(`Lettura completata: ${ordini.length} ordini nel perimetro.\n`);

const rows = [['ordine', 'creato', 'oraRoma', 'categoria', 'dataAttuale', 'dataCalcolata', 'esito', 'motivo']];
let daScrivere = 0, scritti = 0, giaPresenti = 0, errori = 0;
const perData = new Map();

for (const o of ordini) {
  const { data: dataRoma, ora } = dataEOraShop(o.createdAt);
  const categoria = categoriaDaTag(o.tags);
  const attuale = parseEtaTag(o.tags);
  const { data, motivo } = calcolaDataPrevista(o.createdAt, categoria);

  const daCorreggere = CORREGGI.has(o.name);

  if (attuale && !daCorreggere) {
    giaPresenti++;
    rows.push([o.name, dataRoma, ora, categoria, attuale, data, 'invariato', 'data già presente: non si sovrascrive']);
    continue;
  }
  if (attuale && attuale === data) {
    giaPresenti++;
    rows.push([o.name, dataRoma, ora, categoria, attuale, data, 'invariato', 'già coerente con la regola']);
    continue;
  }

  daScrivere++;
  perData.set(data, (perData.get(data) || 0) + 1);
  rows.push([o.name, dataRoma, ora, categoria, attuale || '', data,
             APPLY ? (attuale ? 'corretto' : 'scritto') : (attuale ? 'da correggere' : 'da scrivere'), motivo]);

  if (!APPLY) continue;
  try {
    // Correzione: il vecchio tag va tolto, altrimenti l'ordine ne avrebbe due
    // e scatterebbe l'alert `tag_conflitto` — con ragione.
    if (attuale) await removeOrderTags(o.id, [`spedizione_prevista=${attuale}`]);
    await addOrderTags(o.id, [`spedizione_prevista=${data}`]);
    scritti++;
    if (scritti % 25 === 0) console.log(`  ...${scritti} ordini aggiornati`);
    if (MAX && scritti >= MAX) { console.log(`\n  Limite --max ${MAX} raggiunto: mi fermo qui.`); break; }
  } catch (err) {
    errori++;
    console.error(`  ✗ ${o.name}: ${err.message}`);
    rows[rows.length - 1][6] = `errore: ${err.message}`;
  }
}

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.writeFileSync(OUT, rows.map((r) => r.map(csv).join(',')).join('\n'));

console.log(`
Ordini esaminati:      ${ordini.length}
Data già presente:     ${giaPresenti}   <- non toccati
Da scrivere:           ${daScrivere}
Scritti:               ${scritti}
Errori:                ${errori}

Distribuzione delle date calcolate:`);
for (const [d, n] of [...perData.entries()].sort()) console.log(`  ${d}   ${n} ordini`);
console.log(`\nCSV: ${OUT}`);
if (!APPLY) console.log('\nNessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply.\n');
