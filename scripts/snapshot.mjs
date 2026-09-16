#!/usr/bin/env node
/**
 * Inizializzazione del riassunto sugli ordini ANCORA APERTI — da eseguire in locale.
 *
 *   node scripts/snapshot.mjs                 # dry-run: legge, calcola, scrive solo il CSV
 *   node scripts/snapshot.mjs --apply         # scrive i metafield
 *   node scripts/snapshot.mjs --days 45       # finestra temporale (default 60)
 *   node scripts/snapshot.mjs --forza         # riscrive anche i riassunti già presenti
 *   node scripts/snapshot.mjs --apply --max 1 # PROVA: scrive un solo ordine
 *
 * Prima di lanciarlo su tutti, conviene sempre `--apply --max 1`: verifica in dieci
 * secondi che l'app abbia davvero il permesso di scrivere il metafield, invece di
 * scoprirlo a metà di una passata da centinaia di ordini.
 *
 * NON è un backfill storico. Tocca soltanto gli ordini che il cruscotto deve
 * mostrare adesso: quelli non consegnati (`tag_not:consegnato`). Gli ordini già
 * chiusi restano su Shopify come sono e non vengono nemmeno letti.
 *
 * Perché serve: il webhook aggiorna il riassunto dal momento in cui è attivo.
 * Senza questa passata, le liste del cruscotto partirebbero vuote proprio sugli
 * ordini in corso. Qui la cronologia si legge integrale, quindi la presa in
 * carico risulta esatta e non stimata.
 *
 * RITIRO IN NEGOZIO — perche' questo script NON filtra per metodo di consegna.
 * Il ritiro e' fuori dal perimetro del cruscotto, ma l'esclusione vive nell'app
 * (`NOT delivery_method:pick-up`), non qui. Sui dati reali ~20% degli ordini di
 * ritiro ha comunque una LDV tracciata: aggiungere il filtro qui li lascerebbe
 * senza tag e senza riassunto, cioe' aperti per sempre. Un ritiro puro invece
 * si esclude da solo, perche' non ha spedizioni tracciate.
 *
 * Scrive SOLO il metafield `checkpoint.spedizione_stato`.
 * Non crea fulfillment event, non tocca tag, non riscrive URL:
 * ⇒ nessuna email al cliente può partire da questo script.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql } from '../lib/shopify.js';
import { daCronologia, leggiSnapshot, scriviSnapshot, SNAPSHOT_VERSION } from '../lib/snapshot.js';

const APPLY = process.argv.includes('--apply');
const FORZA = process.argv.includes('--forza');
const MAX = Number(argValue('--max') || 0);   // 0 = nessun limite
const DAL  = argValue('--dal') || '2026-07-24';   // day 1 del cruscotto
const DAYS = Number(argValue('--days') || 0);    // alternativa: finestra mobile
const OUT = `snapshot-${new Date().toISOString().slice(0, 10)}.csv`;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

/**
 * Qui gli eventi servono TUTTI, quindi la query è costosa e si pagina stretta:
 * 25 ordini × 5 spedizioni × 100 eventi resta sotto il limite di costo.
 * È accettabile perché è una passata una tantum, non una schermata.
 */
const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 25, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt
        snapshot: metafield(namespace: "checkpoint", key: "spedizione_stato") { value }
        fulfillments(first: 5) {
          id status displayStatus createdAt
          trackingInfo { company number url }
          events(first: 100, sortKey: HAPPENED_AT) {
            nodes { status happenedAt message city }
          }
        }
      }
    }
  }`;

async function* ordini() {
  const since = DAYS ? new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10) : DAL;
  // Stesso perimetro del cruscotto: solo ordini non consegnati, filtrati alla sorgente.
  const q = `created_at:>=${since} AND NOT status:cancelled AND tag_not:consegnato`;
  let cursor = null;
  do {
    const data = await gql(QUERY, { q, cursor });
    for (const o of data.orders.nodes) yield o;
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
}

const etaGiorni = Math.floor((Date.now() - new Date(`${DAL}T00:00:00Z`)) / 864e5);
if (DAYS > 55 || (!DAYS && etaGiorni > 55)) {
  console.log(
    `\n⚠  Perimetro di ${DAYS || etaGiorni} giorni. L'app non richiede lo scope read_all_orders,\n` +
    `   quindi Shopify restituisce al massimo gli ultimi 60 giorni e lo fa in\n` +
    `   silenzio. Se il totale sotto sembra basso, è quasi certamente questo.\n`
  );
}
console.log(`Riassunti ordini aperti — dal ${DAYS ? `${DAYS} giorni fa` : DAL} — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}${MAX ? ` — massimo ${MAX} ordini` : ''}\n`);

const rows = [[
  'ordine', 'spedizioni', 'tracking', 'trackAt', 'presaAt', 'presaStatus',
  'presaApprossimata', 'consegnaAt', 'ultimoEvento', 'eventi', 'esito',
]];

let letti = 0, scritti = 0, invariati = 0, senzaSpedizioni = 0, errori = 0, approssimate = 0;

for await (const o of ordini()) {
  letti++;
  const attivi = (o.fulfillments || []).filter((f) => f.status !== 'CANCELLED');

  if (!attivi.length) {
    senzaSpedizioni++;
    continue;
  }

  const precedente = leggiSnapshot(o.snapshot?.value);
  if (precedente && !FORZA) {
    invariati++;
    rows.push([o.name, attivi.length, '', '', '', '', '', '', '', '', 'già presente']);
    continue;
  }

  const spedizioni = attivi.map((f) => daCronologia(f, f.events?.nodes || []));
  const snapshot = {
    v: SNAPSHOT_VERSION,
    aggiornatoIl: new Date().toISOString(),
    sorgente: 'backfill',
    spedizioni,
  };

  for (const s of spedizioni) {
    if (s.presaApprossimata) approssimate++;
    rows.push([
      o.name, spedizioni.length, s.tracking || '', s.trackAt || '', s.presaAt || '',
      s.presaStatus || '', s.presaApprossimata ? 'si' : 'no', s.consegnaAt || '',
      s.ultimoEventoStatus || '', s.numeroEventi, APPLY ? 'scritto' : 'dry-run',
    ]);
  }

  if (!APPLY) continue;

  try {
    await scriviSnapshot(o.id, snapshot);
    scritti++;
    if (scritti % 25 === 0) console.log(`  ...${scritti} ordini scritti`);
    if (MAX && scritti >= MAX) {
      console.log(`\n  Limite --max ${MAX} raggiunto: mi fermo qui.`);
      break;
    }
  } catch (err) {
    errori++;
    console.error(`  ✗ ${o.name}: ${err.message}`);
    rows[rows.length - 1][10] = `errore: ${err.message}`;
  }
}

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.writeFileSync(OUT, rows.map((r) => r.map(csv).join(',')).join('\n'));

console.log(`
Ordini aperti letti:       ${letti}
Senza spedizioni attive:   ${senzaSpedizioni}
Riassunti già presenti:    ${invariati}${FORZA ? ' (riscritti: --forza)' : ''}
Riassunti scritti:         ${scritti}
Errori:                    ${errori}
Prese in carico stimate:   ${approssimate}   <- il corriere non ha mai notificato il ritiro
CSV:                       ${OUT}
`);
if (!APPLY) console.log('Nessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply.\n');
