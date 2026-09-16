import io, re, sys

p = 'lib/shopify.js'
s = io.open(p, encoding='utf-8').read()

vecchio_inizio = s.index('export async function gql(')
vecchio_fine = s.index('/** Solleva se la mutation ha restituito userErrors. */')
vecchio = s[vecchio_inizio:vecchio_fine]

nuovo = '''/**
 * Numero massimo di ritentativi su throttling.
 *
 * Il rate limit GraphQL di Shopify e' a punti: un secchiello che si ricarica a
 * `restoreRate` punti al secondo. Superata la capacita', la richiesta viene
 * respinta e va semplicemente ripetuta piu' tardi.
 */
const THROTTLE_MAX_RETRY = 6;

/**
 * Il throttling GraphQL NON arriva come HTTP 429.
 *
 * Shopify risponde 200 con un corpo che contiene:
 *
 *   { "errors": [{ "message": "Throttled",
 *                  "extensions": { "code": "THROTTLED" } }],
 *     "extensions": { "cost": { "requestedQueryCost": 12,
 *                               "throttleStatus": { "maximumAvailable": 2000,
 *                                                   "currentlyAvailable": 3,
 *                                                   "restoreRate": 100 } } } }
 *
 * Trattarlo come un errore applicativo, com'era prima, significa perdere la
 * scrittura: nel webhook l'eccezione viene catturata, si risponde 200 e
 * ShippyPro non ritenta. L'evento sparisce senza traccia.
 */
const isThrottled = (errors) =>
  Array.isArray(errors) &&
  errors.some(
    (e) =>
      e?.extensions?.code === 'THROTTLED' ||
      /throttl/i.test(String(e?.message || ''))
  );

/**
 * Quanto aspettare prima di ritentare.
 *
 * Se Shopify dichiara lo stato del secchiello si calcola il tempo esatto di
 * ricarica dei punti mancanti; altrimenti si ripiega su un backoff esponenziale.
 */
function attesaThrottle(json, tentativo) {
  const cost = json?.extensions?.cost;
  const stato = cost?.throttleStatus;
  const richiesti = Number(cost?.requestedQueryCost);
  const disponibili = Number(stato?.currentlyAvailable);
  const ricarica = Number(stato?.restoreRate);

  if (Number.isFinite(richiesti) && Number.isFinite(disponibili) && ricarica > 0) {
    const mancanti = Math.max(0, richiesti - disponibili);
    return Math.min(30_000, Math.ceil((mancanti / ricarica) * 1000) + 300);
  }
  return Math.min(30_000, 1000 * 2 ** tentativo);
}

export async function gql(query, variables = {}, { retryAuth = true, throttleRetry = THROTTLE_MAX_RETRY } = {}) {
  const token = await getAccessToken();

  const res = await fetch(`https://${shop()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  // Token scaduto prima del previsto: se ne prende uno nuovo, una volta sola.
  if (res.status === 401 && retryAuth) {
    await getAccessToken({ force: true });
    return gql(query, variables, { retryAuth: false, throttleRetry });
  }

  // 429: throttling a livello HTTP (REST-style, o limiti di piattaforma).
  if (res.status === 429 && throttleRetry > 0) {
    const tentativo = THROTTLE_MAX_RETRY - throttleRetry;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1000 * 2 ** tentativo)
    );
    return gql(query, variables, { retryAuth, throttleRetry: throttleRetry - 1 });
  }

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    if (isThrottled(json.errors) && throttleRetry > 0) {
      const tentativo = THROTTLE_MAX_RETRY - throttleRetry;
      await sleep(attesaThrottle(json, tentativo));
      return gql(query, variables, { retryAuth, throttleRetry: throttleRetry - 1 });
    }
    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 400)}`);
  }

  return json.data;
}

'''

s = s[:vecchio_inizio] + nuovo + s[vecchio_fine:]
io.open(p, 'w', encoding='utf-8').write(s)
print('lib/shopify.js aggiornato')
