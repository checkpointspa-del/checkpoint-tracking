#!/usr/bin/env node
/**
 * Riconciliazione: Shopify allineato a ShippyPro, spedizione per spedizione.
 *
 * Per ogni collo chiede a ShippyPro lo stato corrente e lo confronta con
 * l'ultimo evento su Shopify. Scrive SOLO quando i due divergono: se lo stato
 * e' gia' corretto non tocca niente.
 *
 * A differenza di `backfill.mjs` non salta le spedizioni gia' consegnate,
 * quindi e' l'unico strumento che puo' correggere una consegna sbagliata.
 *
 *   node scripts/riconcilia.mjs                      # dry-run dal 24/07/2026
 *   node scripts/riconcilia.mjs --dal 2026-08-01
 *   node scripts/riconcilia.mjs --apply --max 1      # PROVA su un solo ordine
 *   node scripts/riconcilia.mjs --apply
 *   node scripts/riconcilia.mjs --senza-tag          # non toccare i tag ordine
 *
 * CIO' CHE QUESTO SCRIPT NON PUO' FARE
 * ------------------------------------
 * Se ShippyPro non ha dati sulla spedizione, non esiste nessuno stato corretto
 * da scrivere e il collo viene lasciato esattamente com'e'. Riguarda il 14%
 * delle LDV Poste (129 su 896 al 17/09/2026), e non e' un limite aggirabile da
 * qui: 26CKPT2645 risulta consegnata su poste.it dal 25 agosto e ShippyPro non
 * lo ha mai riportato. Quei casi finiscono nel CSV con esito
 * `nessun dato ShippyPro` e vanno chiusi alla fonte.
 *
 * REGOLE DI SCRITTURA
 * -------------------
 * Le decide `shouldWriteEvent()` in lib/orders.js, non questo script: stessa
 * logica del webhook, una sola fonte di verita'. In pratica non si scrive se
 * lo stato e' identico, se l'evento e' piu' vecchio dell'ultimo registrato, o
 * se sarebbe una regressione fra stati non terminali. Si scrive invece quando
 * il vettore ha ritrattato una consegna.
 *
 * PRIMA DI --apply
 * ----------------
 * Verificare che le notifiche cliente sugli eventi di spedizione siano
 * disattivate nelle impostazioni dello store: `FulfillmentEventInput` non ha
 * `notifyCustomer` e non esiste alcuna leva API per silenziarle.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql, assertNoUserErrors, sleep } from '../lib/shopify.js';
import { getTracking, unwrapTracking, trackingHasEvents } from '../lib/shippypro.js';
import { mapShippyProStatus } from '../lib/status.js';
import { shouldWriteEvent, createFulfillmentEvent, addOrderTags } from '../lib/orders.js';
import { APP_TAGS } from '../lib/tags.js';

/* ------------------------------------------------------------------ *
 * Argomenti
 * ------------------------------------------------------------------ */

const arg = (f) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : null;
};

const APPLY = process.argv.includes('--apply');
const SENZA_TAG = process.argv.includes('--senza-tag');
const MAX = Number(arg('--max') || 0);
const DAL = arg('--dal') || '2026-07-24';
const OUT = `riconcilia-${new Date().toISOString().slice(0, 10)}.csv`;

if (!/^\d{4}-\d{2}-\d{2}$/.test(DAL)) {
  console.log(`\nData "${DAL}" non valida. Formato atteso: --dal AAAA-MM-GG\n`);
  process.exit(1);
}

const giorni = Math.round((Date.now() - new Date(DAL).getTime()) / 864e5);

/* ------------------------------------------------------------------ *
 * Shopify
 * ------------------------------------------------------------------ */

const ORDER_FIELDS = `
  id name tags displayFulfillmentStatus
  fulfillments(first: 20) {
    id status displayStatus
    trackingInfo { company number }
    events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt message } }
  }`;

const QUERY = `
  query($q: String!, $cursor: String) {
    orders(first: 25, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }`;

async function* ordini() {
  const q = `fulfillment_status:shipped,partial AND created_at:>=${DAL}`;
  let cursor = null;
  let pagina = 0;
  do {
    const data = await gql(QUERY, { q, cursor });
    pagina++;
    process.stdout.write(`\r  lettura Shopify — pagina ${pagina}…   `);
    for (const o of data.orders.nodes) yield o;
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  process.stdout.write('\n\n');
}

async function rileggiOrdine(gid) {
  const data = await gql(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid });
  return data.order;
}

async function togliTag(orderGid, tags) {
  const data = await gql(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: orderGid, tags }
  );
  return assertNoUserErrors(data.tagsRemove, 'tagsRemove');
}

/* ------------------------------------------------------------------ *
 * Data dell'evento
 * ------------------------------------------------------------------ */

/**
 * Data reale dell'ultimo evento del vettore, quando ShippyPro la espone.
 * I nomi dei campi sono quelli gia' gestiti da `unwrapTracking`.
 */
function dataVettore(evento) {
  for (const v of [evento?.date, evento?.Date, evento?.StatusDate, evento?.FirstStatusDate]) {
    if (v == null || v === '' || v === '0' || v === 0) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 1_000_000_000) return new Date(n * 1000).toISOString();
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * Quando scrivere l'evento.
 *
 * Si preferisce la data reale del vettore, perche' e' quella giusta nella
 * timeline. Ma se e' anteriore all'ultimo evento gia' registrato — succede
 * sulle spedizioni sporcate dal backfill, che porta la data del 27-28 agosto
 * invece di quella vera — l'evento verrebbe scartato come "piu' vecchio".
 * In quel caso si usa adesso: meglio una data imprecisa che nessuna correzione.
 */
function quandoScrivere(evento, ultimo) {
  const vettore = dataVettore(evento);
  if (!vettore) return { quando: new Date().toISOString(), fonte: 'adesso (nessuna data dal vettore)' };
  if (ultimo?.happenedAt && new Date(vettore) <= new Date(ultimo.happenedAt)) {
    return { quando: new Date().toISOString(), fonte: `adesso (data vettore ${vettore.slice(0, 10)} anteriore all'ultimo evento)` };
  }
  return { quando: vettore, fonte: 'data reale del vettore' };
}

/* ------------------------------------------------------------------ *
 * Esecuzione
 * ------------------------------------------------------------------ */

const intestazione = ['ordine', 'tracking', 'corriere', 'statoShopify', 'statoShippyPro', 'scritto', 'quando', 'fonteData', 'tag', 'esito'];
const righe = [intestazione];

let esaminate = 0, scritte = 0, gia = 0, senzaDati = 0, errori = 0;

console.log(`\nRiconciliazione — dal ${DAL} (${giorni} giorni) — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}`);
if (giorni > 58) {
  console.log(`  !  ${giorni} giorni superano la finestra di 60 della Admin API.`);
  console.log('     Gli ordini piu' + String.fromCharCode(39) + ' vecchi non compaiono, senza alcun errore.');
}
if (!process.env.SHIPPYPRO_API_KEY) {
  console.log('\n  SHIPPYPRO_API_KEY non configurato: senza ShippyPro non c\'e\' niente con cui confrontare.\n');
  process.exit(1);
}
console.log('  Si scrive solo dove Shopify e ShippyPro divergono.\n');

const cache = new Map();
let contati = 0;

for await (const ordine of ordini()) {
  if (MAX > 0 && contati >= MAX) break;

  let ordineToccato = false;

  for (const f of ordine.fulfillments) {
    if (f.status === 'CANCELLED') continue;

    const numero = f.trackingInfo.find((t) => t.number)?.number?.trim();
    if (!numero) continue;

    const corriere = f.trackingInfo.find((t) => t.company)?.company || '';
    const ultimo = f.events?.nodes?.[0] || null;
    const statoShopify = ultimo?.status || '(nessun evento)';
    esaminate++;

    // Una sola interrogazione per codice: lo stesso collo puo' comparire su
    // piu' fulfillment dello stesso ordine.
    let raw;
    try {
      if (!cache.has(numero)) cache.set(numero, await getTracking(numero));
      raw = cache.get(numero);
    } catch (err) {
      errori++;
      righe.push([ordine.name, numero, corriere, statoShopify, '', '', '', '', '', `errore ShippyPro: ${err.message.slice(0, 100)}`]);
      console.log(`  x ${ordine.name} ${numero} — ShippyPro: ${err.message.slice(0, 80)}`);
      continue;
    }

    const evento = unwrapTracking(raw);

    // Nessuna evidenza del vettore: non esiste uno stato corretto da scrivere.
    if (!trackingHasEvents(evento)) {
      senzaDati++;
      const nota = statoShopify === 'DELIVERED'
        ? 'nessun dato ShippyPro — consegna su Shopify non verificabile'
        : 'nessun dato ShippyPro — lasciato invariato';
      righe.push([ordine.name, numero, corriere, statoShopify, '(muto)', '', '', '', '', nota]);
      continue;
    }

    const { status: statoSp, message } = mapShippyProStatus(evento);
    if (!statoSp) {
      righe.push([ordine.name, numero, corriere, statoShopify, '(non mappato)', '', '', '', '', 'stato ShippyPro non mappato']);
      continue;
    }

    const { quando, fonte } = quandoScrivere(evento, ultimo);
    const decisione = shouldWriteEvent(f, statoSp, quando);

    if (!decisione.write) {
      gia++;
      righe.push([ordine.name, numero, corriere, statoShopify, statoSp, '', '', '', '', `nessuna azione: ${decisione.reason}`]);
      continue;
    }

    if (!APPLY) {
      scritte++;
      righe.push([ordine.name, numero, corriere, statoShopify, statoSp, statoSp, quando, fonte, '', 'da allineare (dry-run)']);
      console.log(`  · ${ordine.name} ${numero} — ${statoShopify} -> ${statoSp} (dry-run)`);
      continue;
    }

    try {
      await createFulfillmentEvent({
        fulfillmentId: f.id,
        status: statoSp,
        happenedAt: quando,
        message: message || undefined,
      });
      scritte++;
      ordineToccato = true;
      righe.push([ordine.name, numero, corriere, statoShopify, statoSp, statoSp, quando, fonte, '', 'allineato']);
      console.log(`  ok ${ordine.name} ${numero} — ${statoShopify} -> ${statoSp}`);
      await sleep(250);
    } catch (err) {
      errori++;
      righe.push([ordine.name, numero, corriere, statoShopify, statoSp, statoSp, quando, fonte, '', `errore Shopify: ${err.message.slice(0, 100)}`]);
      console.log(`  x ${ordine.name} ${numero} — Shopify: ${err.message.slice(0, 80)}`);
    }
  }

  // Tag `consegnato`, valutato una volta per ordine e solo se abbiamo scritto
  // qualcosa. Si guarda l'ultimo evento di ogni spedizione: `displayStatus` non
  // esce mai da DELIVERED e renderebbe il tag irremovibile.
  if (APPLY && ordineToccato && !SENZA_TAG) {
    try {
      const dopo = await rileggiOrdine(ordine.id);
      const attivi = dopo.fulfillments.filter((x) => x.status !== 'CANCELLED');
      const tutte = attivi.length > 0 && attivi.every((x) => x.events?.nodes?.[0]?.status === 'DELIVERED');
      const haTag = dopo.tags.includes(APP_TAGS.DELIVERED);

      if (tutte && !haTag && dopo.displayFulfillmentStatus === 'FULFILLED') {
        await addOrderTags(dopo.id, [APP_TAGS.DELIVERED]);
        righe.push([ordine.name, '', '', '', '', '', '', '', 'tag consegnato aggiunto', 'tag aggiornato']);
        console.log(`     ${ordine.name} — tag consegnato aggiunto`);
      } else if (!tutte && haTag) {
        await togliTag(dopo.id, [APP_TAGS.DELIVERED]);
        righe.push([ordine.name, '', '', '', '', '', '', '', 'tag consegnato rimosso', 'tag aggiornato']);
        console.log(`     ${ordine.name} — tag consegnato rimosso`);
      }
      await sleep(200);
    } catch (err) {
      errori++;
      console.log(`  x ${ordine.name} — tag: ${err.message.slice(0, 80)}`);
    }
  }

  contati++;
}

/* ------------------------------------------------------------------ *
 * CSV + riepilogo
 * ------------------------------------------------------------------ */

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.writeFileSync(OUT, righe.map((r) => r.map(csv).join(',')).join('\n'));

console.log('\nRiepilogo');
console.log('─────────');
console.log(`  Spedizioni esaminate          : ${esaminate}`);
console.log(`  ${APPLY ? 'Allineate' : 'Da allineare'}${APPLY ? '                    ' : '                 '}: ${scritte}`);
console.log(`  Gia' corrette, non toccate    : ${gia}`);
console.log(`  Senza dati su ShippyPro       : ${senzaDati}  <- non riconciliabili da qui`);
console.log(`  Errori                        : ${errori}`);
console.log(`\nReport: ${OUT}`);

if (!APPLY) {
  console.log('\nNessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply --max 1.\n');
} else if (senzaDati) {
  console.log(`\n${senzaDati} spedizioni restano com'erano perche' ShippyPro non ha dati.`);
  console.log('Filtra il CSV su "nessun dato ShippyPro": vanno chiuse alla fonte, non da qui.\n');
}
