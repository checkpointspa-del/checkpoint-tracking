#!/usr/bin/env node
/**
 * AUDIT dei "consegnato" — SOLA LETTURA.
 *
 * Non scrive nulla: né su Shopify, né su ShippyPro. Produce solo un CSV.
 *
 * A cosa serve
 * ------------
 * Il 28/08/2026 una passata di backfill ha scritto DELIVERED su spedizioni
 * prive di qualunque scansione del vettore. DELIVERED è terminale e i
 * fulfillment event sono append-only: quegli stati non si correggono da soli
 * e l'app non li rimetterà mai in discussione.
 *
 * Questo script cerca tutti i casi analoghi nella finestra dei 60 giorni.
 *
 * Due livelli di controllo, indipendenti fra loro:
 *
 *   LIVELLO A — solo Shopify, deterministico, nessuna dipendenza esterna.
 *     Riconosce gli eventi scritti in blocco da uno script invece che dal
 *     webhook. Firma: `message` vuoto E `happenedAt` uguale a `createdAt`
 *     al secondo. Una consegna vera dal webhook porta la data del vettore
 *     (diversa dalla data di scrittura) e un messaggio del corriere.
 *     La colonna `lotto` conta quante altre consegne condividono lo stesso
 *     identico secondo: >1 significa scrittura massiva.
 *
 *   LIVELLO B — interroga ShippyPro (disattivabile con --solo-shopify).
 *     Verifica se oggi esiste evidenza del vettore. Attenzione: per circa il
 *     9% delle LDV Poste ShippyPro non ha MAI avuto dati, e i codici vecchi
 *     scadono. "Nessun dato oggi" non prova che la consegna sia falsa: è un
 *     indizio, da leggere insieme al livello A.
 *
 * Uso
 * ---
 *   node scripts/audit-consegnati.mjs                  # 60 giorni, A + B
 *   node scripts/audit-consegnati.mjs --days 45
 *   node scripts/audit-consegnati.mjs --solo-shopify   # solo A, veloce
 *   node scripts/audit-consegnati.mjs --tutti          # anche le non consegnate
 *
 * Limite Shopify: senza lo scope `read_all_orders` l'Admin API espone solo
 * gli ultimi 60 giorni. Oltre non dà errore, restituisce meno ordini.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql, sleep, numericId } from '../lib/shopify.js';
import { getTracking, unwrapTracking, trackingHasEvents } from '../lib/shippypro.js';
import { mapShippyProStatus } from '../lib/status.js';

/* ------------------------------------------------------------------ *
 * Argomenti
 * ------------------------------------------------------------------ */

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};

const DAYS = Number(arg('--days') || 60);
const SOLO_SHOPIFY = process.argv.includes('--solo-shopify');
const TUTTI = process.argv.includes('--tutti');
const OUT = `audit-consegnati-${new Date().toISOString().slice(0, 10)}.csv`;

/* ------------------------------------------------------------------ *
 * Shopify
 * ------------------------------------------------------------------ */

/**
 * Il throttling GraphQL non arriva come HTTP 429: è un 200 con
 * `errors[].extensions.code = "THROTTLED"`. `lib/shopify.js` lo rilancia come
 * errore applicativo, quindi qui lo riconosciamo dal testo e riproviamo.
 * Una passata su 60 giorni lo incontra di sicuro.
 */
async function gqlRetry(query, variables, tentativi = 6) {
  for (let i = 1; ; i++) {
    try {
      return await gql(query, variables);
    } catch (err) {
      const throttled = /THROTTLED|Throttled|exceeded .*cost/i.test(err.message);
      if (!throttled || i >= tentativi) throw err;
      const attesa = 2000 * i;
      console.log(`    · throttling Shopify, riprovo fra ${attesa / 1000}s (${i}/${tentativi})`);
      await sleep(attesa);
    }
  }
}

/**
 * Pagina piccola di proposito: il costo della query cresce col prodotto
 * ordini × fulfillment × eventi e il tetto per singola query è 1000 punti.
 * 15 × (1 + 10 × (1 + 5)) = 915.
 */
const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 15, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        tags
        displayFulfillmentStatus
        fulfillments(first: 10) {
          id
          status
          displayStatus
          createdAt
          trackingInfo { company number }
          events(first: 5, sortKey: HAPPENED_AT, reverse: true) {
            nodes { status happenedAt createdAt message }
          }
        }
      }
    }
  }`;

async function* ordiniSpediti() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const q = `fulfillment_status:shipped,partial AND created_at:>=${since}`;
  let cursor = null;
  let pagina = 0;
  do {
    const data = await gqlRetry(QUERY, { q, cursor });
    pagina++;
    process.stdout.write(`\r  lettura Shopify — pagina ${pagina}…   `);
    for (const o of data.orders.nodes) yield o;
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  process.stdout.write('\n');
}

/* ------------------------------------------------------------------ *
 * Livello A — raccolta e firma della scrittura massiva
 * ------------------------------------------------------------------ */

const alSecondo = (iso) => String(iso || '').slice(0, 19);

/**
 * Evento scritto da uno script, non dal webhook.
 *
 *   webhook  -> happenedAt = data del vettore, message valorizzato
 *   script   -> happenedAt = istante della scrittura, message assente
 *
 * `backfill.mjs` e `ripara.mjs` non passano alcun `message`: è la firma più
 * netta che abbiamo, e non richiede di interrogare nessun sistema esterno.
 */
const scritturaMassiva = (ev) =>
  Boolean(ev) && !ev.message && alSecondo(ev.happenedAt) === alSecondo(ev.createdAt);

const righe = [];
let ordiniVisti = 0;
let consegnate = 0;

console.log(`\nAudit consegnati — finestra ${DAYS} giorni — SOLA LETTURA`);
if (DAYS > 55) {
  console.log(`  !  ${DAYS} giorni sono al limite dei 60 della Admin API.`);
  console.log('     Senza lo scope read_all_orders gli ordini più vecchi non compaiono,');
  console.log('     senza alcun errore. Il risultato è un sottoinsieme, non un falso negativo.');
}
console.log(SOLO_SHOPIFY ? '  Livello A soltanto (nessuna chiamata a ShippyPro)\n' : '  Livello A + B (ShippyPro interrogato in sola lettura)\n');

for await (const ordine of ordiniSpediti()) {
  ordiniVisti++;
  for (const f of ordine.fulfillments) {
    if (f.status === 'CANCELLED') continue;

    const eventi = f.events?.nodes || [];
    const ultimo = eventi[0] || null;
    const consegnato = f.displayStatus === 'DELIVERED';
    if (!consegnato && !TUTTI) continue;
    if (consegnato) consegnate++;

    // Eventi con un messaggio del corriere = prova che il webhook ha lavorato
    // su questa spedizione. Zero significa che Shopify non ha mai visto un
    // evento reale del vettore per quel collo.
    const eventiReali = eventi.filter((e) => e.message).length;

    // Codici distinti: lo stesso fulfillment può portare più colli.
    const visti = new Set();
    for (const info of f.trackingInfo) {
      const numero = String(info.number || '').trim();
      if (!numero || visti.has(numero)) continue;
      visti.add(numero);

      righe.push({
        ordine: ordine.name,
        ordineId: numericId(ordine.id),
        creato: ordine.createdAt,
        tracking: numero,
        corriere: info.company || '',
        statoShopify: f.displayStatus,
        tagConsegnato: ordine.tags.includes('consegnato') ? 'si' : 'no',
        ultimoStato: ultimo?.status || '',
        ultimoHappenedAt: ultimo?.happenedAt || '',
        ultimoCreatedAt: ultimo?.createdAt || '',
        ultimoMessaggio: ultimo?.message || '',
        eventiConMessaggio: eventiReali,
        massiva: consegnato && scritturaMassiva(ultimo) ? 'si' : 'no',
        lotto: '',
        spStatusCode: '',
        spExtended: '',
        spDetails: '',
        spFirst: '',
        spCompleted: '',
        spLate: '',
        spEventiReali: '',
        spStatoMappato: '',
        verdetto: '',
      });
    }
  }
}

console.log(`  Ordini letti: ${ordiniVisti} · spedizioni consegnate: ${consegnate} · righe: ${righe.length}\n`);

/* Lotto: quante consegne condividono lo stesso identico secondo di scrittura. */
const conteggioLotto = new Map();
for (const r of righe) {
  if (r.statoShopify !== 'DELIVERED' || !r.ultimoCreatedAt) continue;
  const k = alSecondo(r.ultimoCreatedAt);
  conteggioLotto.set(k, (conteggioLotto.get(k) || 0) + 1);
}
for (const r of righe) {
  r.lotto = r.statoShopify === 'DELIVERED' && r.ultimoCreatedAt
    ? String(conteggioLotto.get(alSecondo(r.ultimoCreatedAt)) || 1)
    : '';
}

/* ------------------------------------------------------------------ *
 * Livello B — ShippyPro
 * ------------------------------------------------------------------ */

if (!SOLO_SHOPIFY) {
  if (!process.env.SHIPPYPRO_API_KEY) {
    console.log('  SHIPPYPRO_API_KEY non configurato: livello B saltato.\n');
  } else {
    const daChiedere = [...new Set(righe.filter((r) => r.statoShopify === 'DELIVERED' || TUTTI).map((r) => r.tracking))];
    console.log(`  Interrogo ShippyPro su ${daChiedere.length} codici distinti (20 ogni 10s)…`);

    const cache = new Map();
    let i = 0;
    for (const numero of daChiedere) {
      i++;
      if (i % 25 === 0) process.stdout.write(`\r    ${i}/${daChiedere.length}   `);
      try {
        cache.set(numero, { raw: await getTracking(numero) });
      } catch (err) {
        cache.set(numero, { errore: err.message.slice(0, 120) });
      }
    }
    process.stdout.write(`\r    ${i}/${daChiedere.length}\n\n`);

    for (const r of righe) {
      const esito = cache.get(r.tracking);
      if (!esito) continue;
      if (esito.errore) {
        r.spStatoMappato = `ERRORE: ${esito.errore}`;
        continue;
      }
      const raw = esito.raw || {};
      const dettagli = Array.isArray(raw.Details) ? raw.Details : [];
      r.spStatusCode = raw.StatusCode ?? '';
      r.spExtended = raw.ExtendedStatusCode ?? '';
      r.spDetails = String(dettagli.length);
      r.spFirst = raw.FirstStatusDate ?? '';
      r.spCompleted = String(raw.Completed ?? '');
      r.spLate = String(raw.Late ?? '');
      r.spEventiReali = trackingHasEvents(raw) ? 'si' : 'no';
      r.spStatoMappato = mapShippyProStatus(unwrapTracking(raw)).status || '';
    }
  }
}

/* ------------------------------------------------------------------ *
 * Verdetto
 * ------------------------------------------------------------------ */

for (const r of righe) {
  if (r.statoShopify !== 'DELIVERED') {
    r.verdetto = 'non consegnata';
    continue;
  }

  const sospettoA = r.massiva === 'si' && Number(r.eventiConMessaggio) === 0;

  if (SOLO_SHOPIFY || !r.spEventiReali) {
    r.verdetto = sospettoA
      ? 'SOSPETTO: consegna scritta in blocco, nessun evento del vettore su Shopify'
      : (r.massiva === 'si' ? 'scritta in blocco, ma il collo aveva eventi reali' : 'ok');
    continue;
  }

  if (r.spEventiReali === 'si') {
    r.verdetto = r.spStatoMappato === 'DELIVERED'
      ? 'ok, consegna confermata da ShippyPro'
      : `INCOERENTE: ShippyPro dice ${r.spStatoMappato || '—'}`;
  } else if (sospettoA) {
    r.verdetto = 'SOSPETTO: scritta in blocco e ShippyPro non ha alcun evento del vettore';
  } else {
    r.verdetto = 'da verificare: ShippyPro non ha dati su questo codice';
  }
}

/* ------------------------------------------------------------------ *
 * CSV + riepilogo
 * ------------------------------------------------------------------ */

const colonne = Object.keys(righe[0] || { ordine: '' });
const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

fs.writeFileSync(
  OUT,
  [colonne.join(','), ...righe.map((r) => colonne.map((c) => csv(r[c])).join(','))].join('\n')
);

const per = (pred) => righe.filter(pred).length;

console.log('Riepilogo');
console.log('─────────');
console.log(`  Spedizioni consegnate esaminate : ${per((r) => r.statoShopify === 'DELIVERED')}`);
console.log(`  Scritte in blocco da script     : ${per((r) => r.massiva === 'si')}`);
console.log(`  SOSPETTE                        : ${per((r) => r.verdetto.startsWith('SOSPETTO'))}`);
console.log(`  Incoerenti con ShippyPro        : ${per((r) => r.verdetto.startsWith('INCOERENTE'))}`);
console.log(`  Da verificare (ShippyPro muto)  : ${per((r) => r.verdetto.startsWith('da verificare'))}`);
console.log(`  Confermate                      : ${per((r) => r.verdetto.startsWith('ok'))}`);
console.log(`\nReport: ${OUT}`);
console.log('Nessuna scrittura effettuata.\n');

const sospette = righe.filter((r) => r.verdetto.startsWith('SOSPETTO'));
if (sospette.length) {
  console.log('Ordini da controllare:');
  for (const r of sospette) console.log(`  ${r.ordine.padEnd(12)} ${r.tracking.padEnd(24)} scritto ${r.ultimoCreatedAt} (lotto ${r.lotto})`);
  console.log('');
}
