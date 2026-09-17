#!/usr/bin/env node
/**
 * Imposta a mano lo stato di una spedizione, quando lo sappiamo da fuori.
 *
 * Serve per il buco ShippyPro ↔ Poste: 165 spedizioni su cui ShippyPro non ha
 * dati e che nessuno degli altri script puo' toccare.
 *
 *   riconcilia.mjs         scrive solo cio' che dice ShippyPro. Se tace, tace.
 *   ripara-consegnati.mjs  agisce solo su spedizioni gia' a DELIVERED.
 *
 * Qui la fonte di verita' e' una persona che ha guardato il sito del vettore.
 * Lo stato viene scritto cosi' com'e' dato, senza chiedere niente a ShippyPro.
 *
 * Uso
 * ---
 *   node scripts/imposta-stato.mjs --ordini 26CKPT2645 --stato DELIVERED --quando 2026-08-25T12:29
 *   node scripts/imposta-stato.mjs --csv da-impostare.csv
 *   ... --apply
 *
 *   --tracking 3UW1JS2037703   agisce su una sola LDV dell'ordine
 *   --nota "..."               testo dell'evento (default: verifica sul vettore)
 *   --senza-tag                non toccare il tag `consegnato`
 *
 * Formato CSV (intestazione obbligatoria, `quando` e `nota` facoltativi):
 *
 *   ordine,tracking,stato,quando,nota
 *   26CKPT2645,3UW1JS2037703,DELIVERED,2026-08-25T12:29,consegnata a Mantova
 *
 * `--quando` accetta `AAAA-MM-GG` (che vale mezzogiorno) oppure
 * `AAAA-MM-GGTHH:MM`, interpretati come ora italiana. Con fuso esplicito
 * (`Z` o `+02:00`) viene preso alla lettera.
 *
 * Perche' scavalca `shouldWriteEvent()`
 * -------------------------------------
 * Le regole di idempotenza servono a difendersi da dati automatici incoerenti.
 * Qui il dato lo fornisce un operatore che ha la prova davanti: e' lui la fonte
 * piu' affidabile che abbiamo, e deve poter vincere. Resta un solo vincolo
 * tecnico: Shopify ordina gli eventi per `happenedAt`, quindi una data
 * anteriore all'ultimo evento registrato verrebbe di fatto ignorata. In quel
 * caso si scrive con la data di adesso e lo si dichiara nel CSV.
 *
 * PRIMA DI --apply
 * ----------------
 * Verificare che le notifiche cliente sugli eventi di spedizione siano
 * disattivate nelle impostazioni dello store: scrivere DELIVERED e' proprio
 * lo stato a cui Shopify associa una mail.
 */

import fs from 'node:fs';
import '../lib/env.js';
import { gql, assertNoUserErrors, sleep } from '../lib/shopify.js';
import { SHOPIFY_STATUSES } from '../lib/status.js';
import { createFulfillmentEvent, addOrderTags } from '../lib/orders.js';
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
const CSV_IN = arg('--csv');
const ORDINI = (arg('--ordini') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TRACKING = (arg('--tracking') || '').trim();
const STATO = (arg('--stato') || '').trim().toUpperCase();
const QUANDO = (arg('--quando') || '').trim();
const NOTA = arg('--nota') || 'stato verificato sul sito del vettore';
const OUT = `imposta-stato-${new Date().toISOString().slice(0, 10)}.csv`;

/* ------------------------------------------------------------------ *
 * Date
 * ------------------------------------------------------------------ */

/** `AAAA-MM-GG` o `AAAA-MM-GGTHH:MM` come ora italiana -> ISO in UTC. */
function isoDaOraItaliana(s) {
  if (!s) return null;
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const base = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s;
  const comeUtc = new Date(`${base}${base.length === 16 ? ':00' : ''}Z`);
  if (Number.isNaN(comeUtc.getTime())) return null;

  // Scarto fra Roma e UTC per quella data: tiene conto dell'ora legale.
  const roma = new Date(comeUtc.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const utc = new Date(comeUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(comeUtc.getTime() - (roma.getTime() - utc.getTime())).toISOString();
}

/* ------------------------------------------------------------------ *
 * Lista di lavoro
 * ------------------------------------------------------------------ */

function leggiCsv(path) {
  const righe = fs.readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const intestazione = righe.shift().split(',').map((c) => c.trim());
  return righe.map((r) => {
    const celle = [];
    let cur = '', dentro = false;
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === '"') {
        if (dentro && r[i + 1] === '"') { cur += '"'; i++; } else dentro = !dentro;
      } else if (ch === ',' && !dentro) { celle.push(cur); cur = ''; }
      else cur += ch;
    }
    celle.push(cur);
    return Object.fromEntries(intestazione.map((c, i) => [c, (celle[i] ?? '').trim()]));
  });
}

let lista = [];
if (CSV_IN) {
  lista = leggiCsv(CSV_IN).map((r) => ({
    ordine: r.ordine,
    tracking: r.tracking || '',
    stato: (r.stato || '').toUpperCase(),
    quando: r.quando || '',
    nota: r.nota || NOTA,
  }));
} else if (ORDINI.length) {
  if (!STATO) { console.log('\nCon --ordini serve anche --stato.\n'); process.exit(1); }
  lista = ORDINI.map((o) => ({ ordine: o, tracking: TRACKING, stato: STATO, quando: QUANDO, nota: NOTA }));
} else {
  console.log('\nServe --csv <file> oppure --ordini <elenco> --stato <STATO>.\n');
  process.exit(1);
}

const invalidi = lista.filter((v) => !SHOPIFY_STATUSES.includes(v.stato));
if (invalidi.length) {
  console.log(`\nStati non validi: ${[...new Set(invalidi.map((v) => v.stato || '(vuoto)'))].join(', ')}`);
  console.log(`Ammessi: ${SHOPIFY_STATUSES.join(', ')}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Shopify
 * ------------------------------------------------------------------ */

const ORDER_FIELDS = `
  id name tags displayFulfillmentStatus
  fulfillments(first: 20) {
    id status displayStatus
    trackingInfo { company number }
    events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt } }
  }`;

async function trovaOrdine(nome) {
  const data = await gql(
    `query($q: String!) { orders(first: 5, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
    { q: `name:${nome}` }
  );
  return data.orders.nodes.find((o) => o.name === nome) || null;
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

/**
 * Il tag `consegnato` guarda solo le spedizioni CON un codice.
 * Un fulfillment senza tracking non ricevera' mai eventi e, se contato,
 * bloccherebbe il tag per sempre.
 */
function tutteConsegnate(ordine) {
  const tracciate = ordine.fulfillments.filter(
    (f) => f.status !== 'CANCELLED' && f.trackingInfo.some((t) => t.number)
  );
  return tracciate.length > 0 && tracciate.every((f) => f.events?.nodes?.[0]?.status === 'DELIVERED');
}

/* ------------------------------------------------------------------ *
 * Esecuzione
 * ------------------------------------------------------------------ */

const righe = [['ordine', 'tracking', 'statoPrima', 'statoScritto', 'quando', 'fonteData', 'tag', 'esito']];
let scritte = 0, saltate = 0, errori = 0;

console.log(`\nImpostazione manuale dello stato — ${APPLY ? 'APPLY (scrive)' : 'DRY-RUN (non scrive)'}`);
console.log(`Voci in lista: ${lista.length}\n`);

for (const voce of lista) {
  const ordine = await trovaOrdine(voce.ordine);
  if (!ordine) {
    errori++;
    righe.push([voce.ordine, voce.tracking, '', '', '', '', '', 'ordine non trovato (fuori dai 60 giorni?)']);
    console.log(`  x ${voce.ordine} — non trovato`);
    continue;
  }

  const bersagli = ordine.fulfillments.filter((f) => {
    if (f.status === 'CANCELLED') return false;
    if (!f.trackingInfo.some((t) => t.number)) return false;
    if (!voce.tracking) return true;
    return f.trackingInfo.some((t) => String(t.number).trim() === voce.tracking);
  });

  if (!bersagli.length) {
    saltate++;
    righe.push([ordine.name, voce.tracking, '', '', '', '', '', 'nessuna spedizione con codice corrispondente']);
    console.log(`  · ${ordine.name} — nessuna spedizione corrispondente`);
    continue;
  }

  let toccato = false;

  for (const f of bersagli) {
    const numero = f.trackingInfo.find((t) => t.number)?.number?.trim() || '';
    const ultimo = f.events?.nodes?.[0] || null;
    const prima = ultimo?.status || '(nessun evento)';

    if (prima === voce.stato) {
      saltate++;
      righe.push([ordine.name, numero, prima, '', '', '', '', 'no-op: stato gia\' corretto']);
      console.log(`  · ${ordine.name} ${numero} — gia' ${voce.stato}`);
      continue;
    }

    const richiesta = isoDaOraItaliana(voce.quando);
    if (voce.quando && !richiesta) {
      errori++;
      righe.push([ordine.name, numero, prima, '', voce.quando, '', '', 'data non valida']);
      console.log(`  x ${ordine.name} ${numero} — data "${voce.quando}" non valida`);
      continue;
    }

    let quando = richiesta || new Date().toISOString();
    let fonteData = richiesta ? 'data indicata' : 'adesso (nessuna data indicata)';
    if (ultimo?.happenedAt && new Date(quando) <= new Date(ultimo.happenedAt)) {
      fonteData = `adesso (${quando.slice(0, 10)} anteriore all'ultimo evento del ${ultimo.happenedAt.slice(0, 10)})`;
      quando = new Date().toISOString();
    }

    if (!APPLY) {
      scritte++;
      righe.push([ordine.name, numero, prima, voce.stato, quando, fonteData, '', 'da scrivere (dry-run)']);
      console.log(`  · ${ordine.name} ${numero} — ${prima} -> ${voce.stato} (${fonteData}) (dry-run)`);
      continue;
    }

    try {
      await createFulfillmentEvent({
        fulfillmentId: f.id,
        status: voce.stato,
        happenedAt: quando,
        message: voce.nota,
      });
      scritte++;
      toccato = true;
      righe.push([ordine.name, numero, prima, voce.stato, quando, fonteData, '', 'scritto']);
      console.log(`  ok ${ordine.name} ${numero} — ${prima} -> ${voce.stato}`);
      await sleep(300);
    } catch (err) {
      errori++;
      righe.push([ordine.name, numero, prima, voce.stato, quando, fonteData, '', `errore: ${err.message.slice(0, 120)}`]);
      console.log(`  x ${ordine.name} ${numero} — ${err.message.slice(0, 100)}`);
    }
  }

  if (APPLY && toccato && !SENZA_TAG) {
    try {
      const dopo = await trovaOrdine(ordine.name);
      const tutte = tutteConsegnate(dopo);
      const haTag = dopo.tags.includes(APP_TAGS.DELIVERED);

      if (tutte && !haTag && dopo.displayFulfillmentStatus === 'FULFILLED') {
        await addOrderTags(dopo.id, [APP_TAGS.DELIVERED]);
        righe.push([ordine.name, '', '', '', '', '', 'tag consegnato aggiunto', 'tag aggiornato']);
        console.log(`     ${ordine.name} — tag consegnato aggiunto`);
      } else if (!tutte && haTag) {
        await togliTag(dopo.id, [APP_TAGS.DELIVERED]);
        righe.push([ordine.name, '', '', '', '', '', 'tag consegnato rimosso', 'tag aggiornato']);
        console.log(`     ${ordine.name} — tag consegnato rimosso`);
      }
      await sleep(200);
    } catch (err) {
      errori++;
      console.log(`  x ${ordine.name} — tag: ${err.message.slice(0, 100)}`);
    }
  }
}

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.writeFileSync(OUT, righe.map((r) => r.map(csv).join(',')).join('\n'));

console.log(`\n${APPLY ? 'Scritte' : 'Da scrivere'}: ${scritte} · No-op: ${saltate} · Errori: ${errori}`);
console.log(`Report: ${OUT}\n`);
if (!APPLY) console.log('Nessuna scrittura effettuata. Controlla il CSV, poi rilancia con --apply.\n');
