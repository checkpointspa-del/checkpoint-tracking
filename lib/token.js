import crypto from 'node:crypto';

/**
 * Token HMAC deterministico, senza database.
 *
 * Il token è derivato dall'id ordine con un segreto applicativo:
 * ricalcolabile all'infinito, non enumerabile, stabile fra i deploy.
 * Protegge la pagina tracking dall'accesso a ordini altrui.
 */

const SECRET = () => {
  const s = process.env.TRACKING_TOKEN_SECRET;
  if (!s) throw new Error('TRACKING_TOKEN_SECRET non configurato');
  return s;
};

/** @param {string|number} orderId id numerico ordine Shopify */
export function makeToken(orderId) {
  return crypto
    .createHmac('sha256', SECRET())
    .update(`order:${orderId}`)
    .digest('base64url')
    .slice(0, 16);
}

/** Confronto a tempo costante. */
export function verifyToken(orderId, token) {
  if (!orderId || !token) return false;
  const expected = makeToken(orderId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifica l'HMAC dei webhook Shopify sul body grezzo.
 *
 * I webhook registrati dall'app via API sono firmati con il **client secret
 * dell'app**, non con la chiave di firma dei webhook creati da Admin.
 * Per questo la chiave è SHOPIFY_CLIENT_SECRET e non una variabile a parte.
 */
export function verifyShopifyHmac(rawBody, header) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !header) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifica l'header segreto condiviso con ShippyPro.
 * @param {string|null} got valore dell'header x-checkpoint-secret
 */
export function verifyShippyProHeader(got) {
  const expected = process.env.SHIPPYPRO_WEBHOOK_SECRET;
  if (!expected) throw new Error('SHIPPYPRO_WEBHOOK_SECRET non configurato');
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(got));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
