/**
 * GET /api/health
 *
 * Diagnosi della configurazione. Dice QUALI variabili mancano, mai il loro
 * valore: nessun segreto esce da qui, nemmeno parzialmente.
 *
 * Serve a distinguere "app rotta" da "variabile dimenticata su Vercel", che
 * altrimenti sono indistinguibili guardando un 500.
 *
 * Con ?shopify=1 prova anche il Client Credentials Grant: conferma che
 * CLIENT_ID e CLIENT_SECRET siano quelli giusti e che l'app sia installata.
 *
 * Si può rimuovere a messa in esercizio conclusa.
 */

import { createHandler, json } from '../lib/http.js';

const REQUIRED = [
  'SHOPIFY_SHOP',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'TRACKING_TOKEN_SECRET',
  'TRACKING_PAGE_URL',
  'SHIPPYPRO_WEBHOOK_SECRET',
];

const OPTIONAL = [
  'SHOPIFY_API_VERSION',
  'APP_BASE_URL',
  'STOREFRONT_ORIGIN',
  'SHOP_TIMEZONE',
  'SHIPPYPRO_API_KEY',
  'DRY_RUN',
  'NODEJS_HELPERS',
];

export default createHandler(async (ctx) => {
  const present = (k) => Boolean(process.env[k] && String(process.env[k]).trim());
  const missing = REQUIRED.filter((k) => !present(k));

  const body = {
    ok: missing.length === 0,
    mancanti: missing,
    presenti: REQUIRED.filter(present),
    opzionali: Object.fromEntries(OPTIONAL.map((k) => [k, present(k)])),
    dryRun: process.env.DRY_RUN === '1',
    // NODEJS_HELPERS=0 serve a ricevere il body grezzo dei webhook Shopify.
    bodyGrezzo: process.env.NODEJS_HELPERS === '0' ? 'ok' : 'imposta NODEJS_HELPERS=0',
  };

  // Verifica opzionale delle credenziali Shopify: nessun dato dell'ordine,
  // solo l'esito del grant.
  if (ctx.url.searchParams.get('shopify') === '1') {
    if (missing.some((k) => k.startsWith('SHOPIFY_'))) {
      body.shopify = 'credenziali mancanti, controllo saltato';
    } else {
      try {
        const { getAccessToken } = await import('../lib/shopify.js');
        await getAccessToken({ force: true });
        body.shopify = 'ok — access token ottenuto';
      } catch (err) {
        body.ok = false;
        body.shopify = `errore — ${err.message}`;
      }
    }
  }

  return json(body, body.ok ? 200 : 503);
});
