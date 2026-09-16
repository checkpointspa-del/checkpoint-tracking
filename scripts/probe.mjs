#!/usr/bin/env node
/**
 * Interroga un metodo ShippyPro e stampa la risposta grezza.
 *
 * Serve a confermare la forma delle risposte prima di scriverci codice sopra:
 * la documentazione descrive le richieste ma quasi mai le risposte, e finora
 * ogni ipotesi sulla forma si è rivelata sbagliata.
 *
 * I preset evitano di dover passare JSON da riga di comando, cosa scomoda
 * su PowerShell per via delle virgolette.
 *
 *   node scripts/probe.mjs tracking 3UW1JS2038673   stato di una spedizione
 *   node scripts/probe.mjs order 367092226          dettagli ordine ShippyPro
 *   node scripts/probe.mjs label 367092226          etichette + stato tracking
 *   node scripts/probe.mjs shipments 3              spedizioni ultimi N giorni
 *   node scripts/probe.mjs pending                  ordini non ancora spediti
 *   node scripts/probe.mjs carriers                 corrieri collegati
 *   node scripts/probe.mjs raw GetCarrierPackagesTypes
 */

import '../lib/env.js';
import { call } from '../lib/shippypro.js';

const [preset, arg] = process.argv.slice(2);
const giorni = (n) => Math.floor(Date.now() / 1000) - n * 86400;
const adesso = () => Math.floor(Date.now() / 1000);

const PRESET = {
  // `Code` con la maiuscola: la documentazione dice `code`, l'API vuole `Code`.
  tracking:  () => ['GetTracking',        { Code: richiesto(arg, 'un codice spedizione') }],
  order:     () => ['GetOrder',           { OrderID: Number(richiesto(arg, 'un OrderID ShippyPro')) }],
  label:     () => ['GetLabelUrl',        { OrderID: Number(richiesto(arg, 'un OrderID ShippyPro')) }],
  shipments: () => ['GetShipmentsReport', { DateMin: giorni(Number(arg) || 3), DateMax: adesso() }],
  shipped:   () => ['GetShippedOrders',   { DateMin: giorni(Number(arg) || 3), DateMax: adesso() }],
  pending:   () => ['GetPendingOrders',   {}],
  carriers:  () => ['GetCarriers',        { Active: 1 }],
  raw:       () => [richiesto(arg, 'il nome di un metodo'), {}],
};

function richiesto(v, cosa) {
  if (!v) {
    console.error(`\nServe ${cosa}.\n`);
    process.exit(1);
  }
  return v;
}

if (!preset || !PRESET[preset]) {
  console.log('\nPreset disponibili:\n');
  for (const k of Object.keys(PRESET)) console.log(`  node scripts/probe.mjs ${k}`);
  console.log('');
  process.exit(preset ? 1 : 0);
}

const [metodo, params] = PRESET[preset]();

console.log(`\n${metodo} ${JSON.stringify(params)}\n`);

try {
  const risposta = await call(metodo, params);
  const testo = JSON.stringify(risposta, null, 2);

  // Le risposte bulk possono essere enormi: si stampa l'inizio e la struttura.
  if (testo.length > 6000) {
    console.log(testo.slice(0, 6000));
    console.log(`\n... troncato (${testo.length} caratteri in tutto)\n`);
    console.log('Chiavi di primo livello:', Object.keys(risposta || {}).join(', '));
    const primoArray = Object.entries(risposta || {}).find(([, v]) => Array.isArray(v));
    if (primoArray) {
      console.log(`\n"${primoArray[0]}" è un array di ${primoArray[1].length} elementi.`);
      console.log('Campi del primo elemento:', Object.keys(primoArray[1][0] || {}).join(', '));
    }
  } else {
    console.log(testo);
  }
  console.log('');
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  process.exitCode = 1;
}
