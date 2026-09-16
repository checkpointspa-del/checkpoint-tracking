/**
 * Adattatore fra le due firme che Vercel può usare per una funzione Node.
 *
 * A seconda del runtime, l'handler riceve `(req, res)` in stile Node oppure
 * un `Request` Web. Cambiano tutti gli accessi: `req.url` è un percorso
 * relativo mentre `request.url` è assoluto, gli header sono un oggetto in un
 * caso e una `Headers` nell'altro.
 *
 * Qui gli handler ricevono sempre lo stesso contesto e restituiscono sempre
 * una `Response`. La conversione avviene in un punto solo.
 *
 * Contesto passato all'handler:
 *   ctx.method            'GET' | 'POST' | ...
 *   ctx.url               oggetto URL assoluto (ctx.url.searchParams)
 *   ctx.header(nome)      header, case-insensitive, null se assente
 *   await ctx.text()      body grezzo come stringa
 */

export function createHandler(fn) {
  return async function handler(a, b) {
    const isWeb = !b && typeof a?.headers?.get === 'function';
    const ctx = isWeb ? fromWeb(a) : fromNode(a);
    const response = await fn(ctx);
    return isWeb ? response : sendNode(b, response);
  };
}

function fromWeb(request) {
  return {
    method: request.method,
    url: new URL(request.url),
    header: (name) => request.headers.get(name),
    text: () => request.text(),
  };
}

function fromNode(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return {
    method: req.method,
    url: new URL(req.url, `${proto}://${host}`),
    header: (name) => req.headers[String(name).toLowerCase()] ?? null,
    text: () => readRaw(req),
  };
}

/**
 * Body grezzo.
 *
 * Con NODEJS_HELPERS=0 il runtime non tocca il body e lo stream arriva intatto:
 * sono i byte esatti, indispensabili per verificare l'HMAC dei webhook Shopify.
 *
 * Senza quella variabile il runtime ha già letto e parsato il body: possiamo
 * solo ricostruirlo, e la firma HMAC quasi certamente non corrisponderà.
 * In quel caso lo segnaliamo nei log invece di lasciare un 401 inspiegabile.
 */
async function readRaw(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') {
    console.warn(
      '[http] body già parsato dal runtime: HMAC non verificabile sui byte originali. ' +
      'Imposta NODEJS_HELPERS=0 nelle variabili d\'ambiente Vercel.'
    );
    return JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function sendNode(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = await response.text();
  res.end(body);
}

/** Risposta JSON, unica forma usata dagli handler. */
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
