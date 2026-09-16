/**
 * POST /api/shippypro/tracking
 *
 * Webhook "Tracking Updates" di ShippyPro.
 * Unico ingresso della sincronizzazione. Nessun polling, nessun database:
 * lo stato precedente viene letto dai fulfillment event già presenti su Shopify.
 *
 * Risponde SEMPRE 200 quando la richiesta è autentica, anche sui no-op:
 * un non-200 farebbe ripartire i 10 retry automatici di ShippyPro a vuoto.
 */

import { createHandler, json } from '../../lib/http.js';
import { verifyShippyProHeader } from '../../lib/token.js';
import { mapShippyProStatus, ORDER_TAGS, isReturningToSender } from '../../lib/status.js';
import { normalizeOrderRef, matchesOrderPattern } from '../../lib/orderref.js';
import { APP_TAGS } from '../../lib/tags.js';
import {
  findOrderByTracking,
  shouldWriteEvent,
  createFulfillmentEvent,
  addOrderTags,
  maybeTagDelivered,
  getOrderByGid,
} from '../../lib/orders.js';

const DRY_RUN = process.env.DRY_RUN === '1';

/**
 * Canali ShippyPro che ci riguardano.
 *
 * L'account è condiviso fra più business: la maggior parte degli eventi
 * riguarda spedizioni che non hanno nulla a che vedere con Shopify. Senza
 * filtro ognuna costerebbe una ricerca sull'Admin API per poi essere scartata.
 *
 * È solo un'ottimizzazione: la correttezza è già garantita dal fatto che il
 * codice spedizione deve corrispondere a un fulfillment Shopify. Se la lista
 * è vuota non si filtra nulla — meglio lavorare a vuoto che perdere eventi.
 *
 * Gli ID si ricavano con `npm run marketplaces`.
 */
const MARKETPLACE_IDS = new Set(
  String(process.env.SHIPPYPRO_MARKETPLACE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

export default createHandler(async (ctx) => {
  if (ctx.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  if (!verifyShippyProHeader(ctx.header('x-checkpoint-secret'))) {
    console.warn('[shippypro] header segreto non valido');
    return json({ error: 'unauthorized' }, 401);
  }

  const raw = await ctx.text();

  // Con DRY_RUN attivo logghiamo il payload integrale: serve a confermare i
  // nomi reali dei campi ShippyPro, che la documentazione non espone.
  // Da rimuovere — o lasciare spento — a messa in esercizio conclusa.
  if (DRY_RUN) console.log('[shippypro] payload ricevuto:', raw.slice(0, 4000));

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn('[shippypro] payload non JSON:', raw.slice(0, 500));
    return json({ ok: true, handled: 0, reason: 'payload non JSON' });
  }

  const events = extractEvents(payload);
  if (!events.length) {
    console.log('[shippypro] payload senza eventi utilizzabili', safe(payload));
    return json({ ok: true, handled: 0 });
  }

  const results = [];
  for (const ev of events) {
    try {
      results.push(await handleOne(ev));
    } catch (err) {
      // Errore applicativo: log e prosegui. Il 200 finale evita retry inutili
      // su payload che non diventeranno validi ripetendo la stessa chiamata.
      console.error('[shippypro] errore', ev.trackingNumber, err.message);
      results.push({ tracking: ev.trackingNumber, error: err.message });
    }
  }

  return json({ ok: true, handled: results.length, results });
});

async function handleOne(ev) {
  const { trackingNumber, orderRef, happenedAt, estimatedDeliveryAt, raw } = ev;
  const { status, code, message } = mapShippyProStatus(raw);

  if (!status) return skip(trackingNumber, 'stato ShippyPro non mappato', orderRef);

  const hit = await findOrderByTracking(trackingNumber);
  if (!hit) {
    // Caso frequente e atteso: la LDV esiste su ShippyPro ma Beestore non ha
    // ancora creato il fulfillment su Shopify. Il webhook fulfillments/create
    // recupererà lo stato corrente al momento della creazione.
    return skip(trackingNumber, 'nessun fulfillment Shopify con questo codice', orderRef);
  }

  const { order, fulfillments } = hit;

  // Lo stesso codice può essere su più fulfillment: vanno aggiornati tutti,
  // altrimenti quelli oltre il primo restano senza stati per sempre.
  const written = [];
  for (const fulfillment of fulfillments) {
    const decision = shouldWriteEvent(fulfillment, status, happenedAt);

    if (!decision.write) {
      console.log('[shippypro] no-op', trackingNumber, fulfillment.id, status, '—', decision.reason);
      continue;
    }
    if (DRY_RUN) {
      console.log('[shippypro] DRY_RUN, scriverei', trackingNumber, fulfillment.id, status);
      continue;
    }

    await createFulfillmentEvent({
      fulfillmentId: fulfillment.id,
      status,
      happenedAt,
      message: message || undefined,
      estimatedDeliveryAt: estimatedDeliveryAt || undefined,
    });
    written.push(fulfillment.id);
  }

  if (!written.length) {
    return { tracking: trackingNumber, status, written: false, reason: DRY_RUN ? 'DRY_RUN' : 'nessuna scrittura necessaria' };
  }

  // Eccezioni che richiedono azione operativa: le rendiamo filtrabili in Admin.
  const tags = [];
  if (ORDER_TAGS[code]) tags.push(ORDER_TAGS[code]);
  if (isReturningToSender(raw)) tags.push(APP_TAGS.RETURNING);

  const nuovi = [...new Set(tags)].filter((t) => !order.tags.includes(t));
  if (nuovi.length) await addOrderTags(order.id, nuovi);

  // Il tag `consegnato` va valutato sull'ordine aggiornato, non su quello letto prima.
  let tagged = null;
  if (status === 'DELIVERED') {
    tagged = await maybeTagDelivered(await getOrderByGid(order.id));
  }

  console.log('[shippypro] scritto', order.name, trackingNumber, status, `(${written.length} fulfillment)`);
  return { tracking: trackingNumber, order: order.name, status, written: written.length, tagged };
}

const skip = (tracking, reason, orderRef = '') => {
  console.log('[shippypro] skip', tracking, orderRef ? `ordine ${orderRef}` : '', '—', reason);
  return { tracking, orderRef: orderRef || undefined, written: false, reason };
};

/**
 * Normalizza il payload ShippyPro.
 *
 * Forma reale dell'evento `tracking_update`, verificata sui webhook in
 * produzione:
 *
 *   {
 *     "Event": "TRACKING_UPDATE",
 *     "tracking": "JJD1499902...",      <- codice spedizione, minuscolo
 *     "date": 1787756418,               <- epoch in secondi
 *     "message": "Gateway departed",
 *     "code": 2,                        <- stato semplice 1-6
 *     "extendedCode": "2330",           <- stato esteso, come STRINGA
 *     "est_delivery_date": "0",         <- epoch, "0" = sconosciuta
 *     "IsReturn": false,
 *     "ReturnTrackingNumber": "JJD...",
 *     "ExternalLink": "https://...",    <- tracking del vettore
 *     "TrackingCarrier": "DHLConnect",
 *     ...
 *   }
 */
function extractEvents(body) {
  if (!body) return [];
  const list = Array.isArray(body) ? body : [body];

  return list
    .map((item) => {
      // Se un giorno venissero attivati altri eventi sullo stesso endpoint.
      const event = String(item?.Event || '').toUpperCase();
      if (event && event !== 'TRACKING_UPDATE') return null;

      const trackingNumber = item?.tracking || item?.TrackingNumber || null;
      if (!trackingNumber) return null;

      // Spedizione di un altro business sullo stesso account ShippyPro.
      if (MARKETPLACE_IDS.size) {
        const mkp = String(item?.MarketplaceID ?? '').trim();
        if (!MARKETPLACE_IDS.has(mkp)) {
          console.log(
            '[shippypro] canale non nostro, ignorato',
            trackingNumber,
            `mkp=${mkp}`,
            `(${item?.MarketplacePlatform || '?'})`
          );
          return null;
        }
      }

      // Un reso ha un tracking suo: aggiornare con esso la spedizione in
      // uscita significherebbe dire al cliente che il pacco sta tornando
      // indietro mentre è in consegna.
      if (item?.IsReturn === true || item?.IsReturn === 'true') {
        console.log('[shippypro] reso ignorato', trackingNumber);
        return null;
      }

      // TransactionID -> numero ordine Shopify. Con le spedizioni multiple
      // arriva come 26CKPT2661_1 o 26CKPT2661#2: il suffisso va tolto.
      const orderRef = normalizeOrderRef(item?.TransactionID);

      // Riferimento di un altro business sullo stesso account ShippyPro.
      if (orderRef && !matchesOrderPattern(orderRef)) {
        console.log('[shippypro] riferimento non nostro, ignorato', trackingNumber, `ref=${orderRef}`);
        return null;
      }

      return {
        trackingNumber: String(trackingNumber).trim(),
        orderRef,
        happenedAt: toIso(item?.date) || new Date().toISOString(),
        estimatedDeliveryAt: toIso(item?.est_delivery_date),
        raw: item,
      };
    })
    .filter(Boolean);
}

/**
 * Epoch in secondi -> ISO. Restituisce null per valori assenti o "0",
 * che ShippyPro usa per "data non disponibile".
 */
function toIso(value) {
  if (value == null || value === '' || value === '0' || value === 0) return null;

  const n = Number(value);
  if (Number.isFinite(n) && n > 1_000_000_000) return new Date(n * 1000).toISOString();

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const safe = (o) => JSON.stringify(o).slice(0, 500);
