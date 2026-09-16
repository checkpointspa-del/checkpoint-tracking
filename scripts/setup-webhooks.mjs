#!/usr/bin/env node
/**
 * Registra i webhook Shopify dell'app.
 *
 * L'app li crea da sé via API: non vanno inseriti a mano in
 * Impostazioni > Notifiche. Così sono firmati con il client secret dell'app
 * e li verifichiamo con la stessa credenziale che usiamo per l'OAuth.
 *
 *   node scripts/setup-webhooks.mjs           # elenca lo stato attuale
 *   node scripts/setup-webhooks.mjs --apply   # crea o aggiorna
 *   node scripts/setup-webhooks.mjs --remove  # rimuove i nostri
 *
 * Idempotente: se un webhook esiste già con lo stesso URL non fa nulla.
 */

import '../lib/env.js';
import { gql, assertNoUserErrors } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');

// L'URL si può passare da riga di comando: utile per non dipendere dal .env.
const urlFlag = process.argv.indexOf('--url');
const BASE = (urlFlag > -1 ? process.argv[urlFlag + 1] : process.env.APP_BASE_URL) || '';

if (!/^https:\/\/.+/.test(BASE)) {
  console.error('\nURL dell\'app mancante o non valido.\n');
  console.error('Passalo da riga di comando:');
  console.error('  node scripts/setup-webhooks.mjs --url https://checkpoint-tracking.vercel.app\n');
  console.error('oppure aggiungi al file .env:');
  console.error('  APP_BASE_URL=https://checkpoint-tracking.vercel.app\n');
  process.exit(1);
}

const CALLBACK = `${BASE.replace(/\/$/, '')}/api/shopify/fulfillment`;
const TOPICS = ['FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE'];

const existing = await gql(`{
  webhookSubscriptions(first: 50) {
    nodes {
      id topic
      endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
    }
  }
}`);

const mine = existing.webhookSubscriptions.nodes.filter(
  (w) => w.endpoint?.callbackUrl && w.endpoint.callbackUrl.startsWith(BASE.replace(/\/$/, ''))
);

console.log('\nWebhook già registrati dall\'app:');
if (!mine.length) console.log('  (nessuno)');
for (const w of mine) console.log(`  ${w.topic} -> ${w.endpoint.callbackUrl}`);

if (REMOVE) {
  if (!mine.length) { console.log('\nNiente da rimuovere.\n'); process.exit(0); }
  for (const w of mine) {
    const out = await gql(
      `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }`,
      { id: w.id }
    );
    assertNoUserErrors(out.webhookSubscriptionDelete, 'webhookSubscriptionDelete');
    console.log(`  ✓ rimosso ${w.topic}`);
  }
  console.log('');
  process.exit(0);
}

console.log(`\nDestinazione: ${CALLBACK}\n`);

for (const topic of TOPICS) {
  const found = mine.find((w) => w.topic === topic);

  if (found && found.endpoint.callbackUrl === CALLBACK) {
    console.log(`  · ${topic} già corretto`);
    continue;
  }

  if (!APPLY) {
    console.log(`  · ${topic} ${found ? 'da aggiornare' : 'da creare'}`);
    continue;
  }

  if (found) {
    const out = await gql(
      `mutation($id: ID!, $sub: WebhookSubscriptionInput!) {
         webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
           webhookSubscription { id } userErrors { field message }
         }
       }`,
      { id: found.id, sub: { callbackUrl: CALLBACK, format: 'JSON' } }
    );
    assertNoUserErrors(out.webhookSubscriptionUpdate, 'webhookSubscriptionUpdate');
    console.log(`  ✓ ${topic} aggiornato`);
  } else {
    const out = await gql(
      `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
         webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
           webhookSubscription { id } userErrors { field message }
         }
       }`,
      { topic, sub: { callbackUrl: CALLBACK, format: 'JSON' } }
    );
    assertNoUserErrors(out.webhookSubscriptionCreate, 'webhookSubscriptionCreate');
    console.log(`  ✓ ${topic} creato`);
  }
}

console.log(APPLY ? '\nFatto.\n' : '\nNessuna modifica. Rilancia con --apply.\n');
