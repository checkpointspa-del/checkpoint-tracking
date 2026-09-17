#!/usr/bin/env node
/**
 * Esplora l'API ShippyPro alla ricerca di un metodo che conosca lo stato delle
 * spedizioni su cui `GetTracking` tace.
 *
 * Perche' esiste
 * --------------
 * 165 LDV Poste non hanno dati in `GetTracking`, ma almeno una di quelle
 * (26CKPT2645) risulta consegnata sul sito di Poste. Prima di costruire una
 * integrazione nuova va escluso che il dato sia gia' dentro ShippyPro, esposto
 * da un metodo diverso. La documentazione di ShippyPro e' inaffidabile — i
 * nomi dei campi del webhook e il parametro `Code` di GetTracking sono stati
 * scoperti sul campo — quindi si prova.
 *
 *   node scripts/probe-shippypro.mjs 3UW1JS2037703
 *   node scripts/probe-shippypro.mjs --metodo GetShipments --params '{"FromDate":"2026-08-01"}'
 *
 * SOLA LETTURA. Non scrive niente, ne' su ShippyPro ne' su Shopify.
 *
 * PRIVACY: non stampa mai il payload integrale. Le risposte di ShippyPro
 * contengono nomi e indirizzi dei destinatari, che non devono finire in un
 * terminale, in un log o in un incolla su chat. Vengono mostrati soltanto i
 * NOMI dei campi e un elenco chiuso di campi di stato.
 */

import '../lib/env.js';
import { call } from '../lib/shippypro.js';

const arg = (f) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : null;
};

/** Gli unici campi il cui VALORE puo' essere stampato: nessuno e' personale. */
const CAMPI_SICURI = [
  'StatusCode', 'ExtendedStatusCode', 'Status', 'StatusDescription', 'TrackingStatus',
  'Completed', 'Late', 'FirstStatusDate', 'EstimatedDeliveryDate', 'DeliveryDate',
  'Carrier', 'TrackingNumber', 'TransactionID', 'MarketplaceID', 'Date', 'date',
  'code', 'extendedCode', 'message', 'IsReturn', 'IsReturning',
];

function riassumi(valore, profondita = 0) {
  const spazio = '  '.repeat(profondita + 1);

  if (Array.isArray(valore)) {
    console.log(`${spazio}[array di ${valore.length}]`);
    if (valore.length) riassumi(valore[0], profondita + 1);
    return;
  }
  if (!valore || typeof valore !== 'object') {
    console.log(`${spazio}${JSON.stringify(valore)?.slice(0, 80)}`);
    return;
  }

  for (const [k, v] of Object.entries(valore)) {
    if (Array.isArray(v)) {
      console.log(`${spazio}${k}: [array di ${v.length}]`);
      if (v.length && profondita < 2) riassumi(v[0], profondita + 1);
    } else if (v && typeof v === 'object') {
      console.log(`${spazio}${k}: { ${Object.keys(v).join(', ')} }`);
    } else if (CAMPI_SICURI.includes(k)) {
      console.log(`${spazio}${k}: ${JSON.stringify(v)}`);
    } else {
      // Campo non in lista: si dichiara che esiste, non il contenuto.
      console.log(`${spazio}${k}: <presente, non mostrato>`);
    }
  }
}

async function prova(metodo, params) {
  console.log(`\n── ${metodo} ${JSON.stringify(params)}`);
  try {
    const r = await call(metodo, params);
    if (r?.Error || r?.error) {
      console.log(`   errore ShippyPro: ${JSON.stringify(r.Error ?? r.error).slice(0, 200)}`);
      if (r.ValidationErrors) console.log(`   validazione: ${JSON.stringify(r.ValidationErrors).slice(0, 200)}`);
      return;
    }
    riassumi(r);
  } catch (err) {
    console.log(`   eccezione: ${err.message.slice(0, 200)}`);
  }
}

const metodo = arg('--metodo');
const codice = process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\{/.test(a) && a !== metodo);

if (!process.env.SHIPPYPRO_API_KEY) {
  console.log('\nSHIPPYPRO_API_KEY non configurato.\n');
  process.exit(1);
}

if (metodo) {
  let params = {};
  const raw = arg('--params');
  if (raw) {
    try { params = JSON.parse(raw); }
    catch { console.log('\n--params non e\' JSON valido.\n'); process.exit(1); }
  }
  await prova(metodo, params);
} else {
  if (!codice) {
    console.log('\nUso: node scripts/probe-shippypro.mjs <tracking>');
    console.log('     node scripts/probe-shippypro.mjs --metodo <Metodo> --params \'{"..."}\'\n');
    process.exit(1);
  }

  console.log(`\nEsplorazione ShippyPro su ${codice} — sola lettura, nessun dato personale mostrato.`);

  // Baseline: quello che gia' usiamo.
  await prova('GetTracking', { Code: codice });

  // Candidati: se uno di questi conosce lo stato, l'integrazione nuova non serve.
  await prova('GetShipments', { TrackingNumber: codice });
  await prova('GetShipments', { Code: codice });
  await prova('GetOrders', { TrackingNumber: codice });
  await prova('GetShipment', { Code: codice });

  console.log('\nCerca un campo di stato valorizzato in uno dei metodi diversi da GetTracking.');
  console.log('Se lo trovi, `riconcilia.mjs` puo\' usarlo come fonte di riserva.\n');
}
