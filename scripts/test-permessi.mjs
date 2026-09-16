#!/usr/bin/env node
/**
 * Test da fare PRIMA di tutto il resto.
 *
 * Verifica l'unico rischio potenzialmente bloccante del progetto:
 * se Shopify accetta un fulfillment event scritto dalla nostra app su un
 * fulfillment creato da un'altra app (Beestore).
 *
 *   node scripts/test-permessi.mjs                       # solo lettura
 *   node scripts/test-permessi.mjs --write <tracking>    # scrive 1 evento di prova
 *
 * PRIMA DI --write: disattivare in Shopify le notifiche cliente
 * "In consegna" e "Consegnato". L'evento scritto è IN_TRANSIT, che non
 * ha una notifica dedicata, ma la prudenza costa zero.
 */

import '../lib/env.js';
import { gql, getAccessToken } from '../lib/shopify.js';
import { findOrderByTracking, createFulfillmentEvent } from '../lib/orders.js';

const i = process.argv.indexOf('--write');
const WRITE = i > -1 ? process.argv[i + 1] : null;

console.log('\n0. Client Credentials Grant');
await getAccessToken();
console.log('   ✓ access token ottenuto da CLIENT_ID + CLIENT_SECRET');

console.log('\n1. Connessione e permessi di lettura');
const shop = await gql('{ shop { name ianaTimezone } }');
console.log(`   ✓ ${shop.shop.name} — fuso ${shop.shop.ianaTimezone}`);

console.log('\n2. Un ordine spedito di esempio');
const sample = await gql(`{
  orders(first: 1, query: "fulfillment_status:shipped", reverse: true) {
    nodes { name fulfillments(first:3){ id displayStatus trackingInfo{ company number } events(first:1){ nodes{ status } } } }
  }
}`);
const order = sample.orders.nodes[0];
if (!order) { console.log('   ✗ nessun ordine spedito trovato'); process.exit(1); }
const f = order.fulfillments[0];
console.log(`   ✓ ${order.name} — ${f.trackingInfo[0]?.company} ${f.trackingInfo[0]?.number}`);
console.log(`     displayStatus: ${f.displayStatus} · eventi presenti: ${f.events.nodes.length}`);

if (!WRITE) {
  console.log('\nLettura OK. Per il test di scrittura:');
  console.log(`   node scripts/test-permessi.mjs --write ${f.trackingInfo[0]?.number}\n`);
  process.exit(0);
}

console.log(`\n3. Scrittura evento di prova su ${WRITE}`);
const hit = await findOrderByTracking(WRITE);
if (!hit) {
  console.log('   ✗ codice non trovato');
  console.log('     Senza lo scope read_all_orders l\'app vede solo gli ordini');
  console.log('     degli ultimi 60 giorni: se il codice è più vecchio, è normale.');
  console.log('     Usa un codice recente e riprova.');
  process.exit(1);
}
console.log(`   ordine ${hit.order.name} · ${hit.fulfillments.length} fulfillment con questo codice`);

try {
  const ev = await createFulfillmentEvent({
    fulfillmentId: hit.fulfillments[0].id,
    status: 'IN_TRANSIT',
    happenedAt: new Date().toISOString(),
    message: 'Test permessi Check Point',
  });
  console.log(`   ✓ evento creato: ${ev.status} @ ${ev.happenedAt}`);
  console.log('\n   Il progetto è sbloccato: possiamo scrivere eventi su fulfillment di Beestore.');
  console.log('   Gli eventi non sono cancellabili via API: verifica in Admin che');
  console.log(`   l'ordine ${hit.order.name} mostri "In transito" e che sia accettabile.\n`);
} catch (err) {
  console.log(`   ✗ ${err.message}`);
  console.log('\n   Blocco confermato. Prima di proseguire serve capire se dipende dagli scope');
  console.log('   della custom app o da una restrizione di ownership sui fulfillment.\n');
  process.exit(1);
}
