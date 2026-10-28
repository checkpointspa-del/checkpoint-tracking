/**
 * GET /api/tracking?o=<orderId>&t=<token>
 *
 * API pubblica letta dalla pagina /pages/tracking-area.
 * Legge solo da Shopify: non interroga mai ShippyPro.
 *
 * Restituisce esclusivamente dati non sensibili: numero ordine, stati,
 * codici spedizione. Nessun nome, indirizzo, email, importo o prodotto.
 */

import { createHandler, json } from '../lib/http.js';
import { verifyToken } from '../lib/token.js';
import { getOrderById, toPublicShape } from '../lib/orders.js';

const ALLOWED_ORIGIN = process.env.STOREFRONT_ORIGIN || 'https://www.check-point-store.it';

/**
 * Ultima risposta buona per ordine, in memoria. Se Shopify non risponde si
 * serve questa, invece di mostrare al cliente un errore: meglio l'ultimo stato
 * noto che "Servizio non disponibile". Non e' persistenza: sopravvive solo
 * all'istanza calda, e va bene cosi'.
 */
const ULTIMA_BUONA = new Map();
const MAX_ULTIME = 500;

const cors = () => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  Vary: 'Origin',
});

export default createHandler(async (ctx) => {
  if (ctx.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (ctx.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors());

  const orderId = String(ctx.url.searchParams.get('o') || '').replace(/\D/g, '');
  const token = String(ctx.url.searchParams.get('t') || '');

  try {
    if (!orderId || !verifyToken(orderId, token)) {
      // Stessa risposta per token errato e ordine inesistente: nessun segnale utile a chi sonda.
      return json({ error: 'not found' }, 404, cors());
    }
  } catch (err) {
    // Variabile d'ambiente mancante: errore di configurazione, non del richiedente.
    console.error('[tracking] configurazione incompleta:', err.message);
    return json({ error: 'misconfigured' }, 503, cors());
  }

  try {
    const order = await getOrderById(orderId);
    // Token valido ma ordine illeggibile: l'id l'abbiamo emesso noi, quindi l'ordine esiste.
    // La Admin API non espone gli ordini oltre i 60 giorni (manca read_all_orders): 410,
    // cosi' la pagina non dice "non trovata" a chi ha un link corretto.
    if (!order) return json({ error: 'too old' }, 410, cors());

    // Cache breve lato edge: protegge il rate limit Admin API sui refresh ripetuti.
    const shape = toPublicShape(order);
    if (ULTIMA_BUONA.size >= MAX_ULTIME) ULTIMA_BUONA.delete(ULTIMA_BUONA.keys().next().value);
    ULTIMA_BUONA.set(orderId, shape);

    return json(shape, 200, {
      ...cors(),
      // stale-if-error: se Shopify e' giu', l'edge continua a servire l'ultima risposta buona.
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120, stale-if-error=86400',
    });
  } catch (err) {
    console.error('[tracking] errore', err.message);
    const ultima = ULTIMA_BUONA.get(orderId);
    if (ultima) {
      return json(ultima, 200, { ...cors(), 'Cache-Control': 'no-store', 'X-Checkpoint-Stale': '1' });
    }
    return json({ error: 'temporarily unavailable' }, 503, cors());
  }
});
