/**
 * POST /api/shopify/fulfillment
 *
 * Webhook Shopify `fulfillments/create` e `fulfillments/update`.
 *
 * Fa una cosa sola: garantire che il link di tracking punti alla nostra
 * pagina. Serve sui fulfillment nuovi e come presidio se un altro sistema
 * riscrive l'URL con quello del vettore.
 *
 * Non scrive stati e non genera notifiche.
 *
 * Firma Web standard (Request -> Response): `await request.text()` restituisce
 * il body grezzo byte per byte, indispensabile per verificare l'HMAC.
 * Con la firma (req, res) il runtime consuma il body prima di passarlo qui e
 * la verifica fallirebbe sempre.
 */

import { createHandler, json } from '../../lib/http.js';
import { verifyShopifyHmac } from '../../lib/token.js';
import { getOrderById, rewriteTrackingUrl } from '../../lib/orders.js';
import { syncFulfillmentFromShippyPro } from '../../lib/sync.js';

const DRY_RUN = process.env.DRY_RUN === '1';

/** Si disattiva con SYNC_ON_CREATE=0 se ShippyPro dà problemi. */
const SYNC_ON_CREATE = process.env.SYNC_ON_CREATE !== '0';

export default createHandler(async (ctx) => {
  if (ctx.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const raw = await ctx.text();

  if (!verifyShopifyHmac(raw, ctx.header('x-shopify-hmac-sha256'))) {
    console.warn('[shopify] HMAC non valido');
    return json({ error: 'unauthorized' }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: true, reason: 'payload non JSON' });
  }

  const orderId = payload.order_id;
  const fulfillmentId = payload.id;
  if (!orderId || !fulfillmentId) return json({ ok: true, reason: 'payload incompleto' });

  try {
    const order = await getOrderById(orderId);
    if (!order) return json({ ok: true, reason: 'ordine non trovato' });

    const fulfillment = order.fulfillments.find((f) => f.id.endsWith(`/${fulfillmentId}`));
    if (!fulfillment) return json({ ok: true, reason: 'fulfillment non trovato' });
    if (fulfillment.status === 'CANCELLED') return json({ ok: true, reason: 'fulfillment annullato' });

    if (DRY_RUN) {
      console.log('[shopify] DRY_RUN, riscriverei URL di', order.name, fulfillmentId);
      return json({ ok: true, dryRun: true });
    }

    const out = await rewriteTrackingUrl(order, fulfillment);
    console.log('[shopify] URL tracking', order.name, out.skipped ? `skip: ${out.skipped}` : 'aggiornato');

    // Allineamento immediato: recupera da ShippyPro lo stato corrente e lo
    // scrive. Senza, gli eventi arrivati prima che Beestore creasse il
    // fulfillment sarebbero persi e la pagina direbbe "in lavorazione" su un
    // pacco già in viaggio. Vedi lib/sync.js.
    let allineamento = null;
    if (SYNC_ON_CREATE) {
      allineamento = await syncFulfillmentFromShippyPro(fulfillment, { dryRun: DRY_RUN });
      for (const e of allineamento) {
        console.log('[shopify] allineamento', order.name, e.tracking, e.status || '', '—', e.esito);
      }
    }

    return json({ ok: true, result: out.skipped || 'aggiornato', allineamento });
  } catch (err) {
    console.error('[shopify] errore', err.message);
    // 200: Shopify riproverebbe per 48h su un errore applicativo che non si risolve da solo.
    return json({ ok: false, error: err.message });
  }
});
