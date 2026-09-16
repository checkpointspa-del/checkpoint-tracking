/**
 * Client per la Shopify Admin GraphQL API.
 *
 * Autenticazione: Client Credentials Grant.
 * L'app ottiene da sola un access token temporaneo da CLIENT_ID + CLIENT_SECRET;
 * non esiste nessun token statico da copiare a mano.
 *
 *   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *        -> POST /admin/oauth/access_token (grant_type=client_credentials)
 *        -> access token temporaneo
 *        -> Admin GraphQL API
 *
 * Il token viene tenuto in memoria e rinnovato da solo alla scadenza o al
 * primo 401. Su Vercel la cache sopravvive fra invocazioni "calde": in pratica
 * una chiamata OAuth ogni 24 ore, non una per richiesta.
 *
 * Nessuna dipendenza esterna: fetch nativo.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

/** Margine di sicurezza: rinnova prima della scadenza dichiarata. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cached = { token: null, expiresAt: 0 };

function shop() {
  const s = process.env.SHOPIFY_SHOP; // es. checkpointspa.myshopify.com
  if (!s) throw new Error('SHOPIFY_SHOP non configurato');
  return s;
}

/**
 * Access token Admin API. Da non salvare da nessuna parte:
 * è temporaneo e va richiesto di nuovo quando serve.
 */
export async function getAccessToken({ force = false } = {}) {
  if (!force && cached.token && Date.now() < cached.expiresAt) return cached.token;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET non configurati');
  }

  const res = await fetch(`https://${shop()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Client Credentials Grant fallito — HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('Risposta OAuth senza access_token');

  // expires_in è in secondi; se assente si assume un'ora, prudenzialmente.
  const ttlMs = (Number(data.expires_in) || 3600) * 1000;
  cached = { token: data.access_token, expiresAt: Date.now() + ttlMs - REFRESH_MARGIN_MS };

  return cached.token;
}

/**
 * Chiamata GraphQL.
 *
 * @param {object} opts
 * @param {boolean} opts.retryAuth       un solo rinnovo del token su 401
 * @param {number}  opts.throttleRetries quanti ritenti restano sul throttling
 */
export async function gql(query, variables = {}, { retryAuth = true, throttleRetries = 5 } = {}) {
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
    return gql(query, variables, { retryAuth: false, throttleRetries });
  }

  if (res.status === 429 && throttleRetries > 0) {
    await sleep(1500);
    return gql(query, variables, { retryAuth, throttleRetries: throttleRetries - 1 });
  }

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    // IL THROTTLING GRAPHQL NON E' UN HTTP 429.
    //
    // Arriva come HTTP 200 con `errors[].extensions.code = "THROTTLED"` e
    // `extensions.cost.throttleStatus`. Trattarlo come errore applicativo fa
    // perdere la scrittura in silenzio: nel webhook l'eccezione viene
    // catturata, si risponde 200 e ShippyPro non ritenta mai piu'.
    const throttled = json.errors.some((e) => e?.extensions?.code === 'THROTTLED');

    if (throttled && throttleRetries > 0) {
      // Attesa calcolata sul budget reale invece che a caso: punti mancanti
      // diviso velocita' di ricarica. Tetto a 10s per non bloccare un webhook.
      const cost = json.extensions?.cost;
      const stato = cost?.throttleStatus;
      const mancanti = Math.max(0, (cost?.requestedQueryCost || 0) - (stato?.currentlyAvailable || 0));
      const attesa = stato?.restoreRate
        ? Math.min(Math.ceil((mancanti / stato.restoreRate) * 1000) + 250, 10_000)
        : 1500;

      await sleep(attesa);
      return gql(query, variables, { retryAuth, throttleRetries: throttleRetries - 1 });
    }

    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 400)}`);
  }

  return json.data;
}

/** Solleva se la mutation ha restituito userErrors. */
export function assertNoUserErrors(payload, label) {
  const errs = payload?.userErrors;
  if (errs?.length) {
    throw new Error(`${label}: ${errs.map((e) => `${e.field ?? ''} ${e.message}`).join(' | ')}`);
  }
  return payload;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const numericId = (gid) => String(gid || '').split('/').pop();
