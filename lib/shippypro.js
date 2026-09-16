/**
 * Client ShippyPro — usato SOLO dal backfill iniziale.
 * Il funzionamento a regime è push (webhook) e non tocca questo file.
 *
 * Autenticazione: API key come username in Basic Auth, password vuota.
 * Rate limit dichiarato: 20 chiamate ogni 10 secondi.
 *
 * Metodo: GetTracking, parametro `code` = tracking number.
 *
 * ⚠️ ShippyPro scrive: "This method is not recommended for bulk usage.
 * To receive all the trackings updates please setup a Webhook instead."
 * Qui lo usiamo per una sola passata di allineamento iniziale, rispettando
 * il rate limit. A regime non viene mai chiamato: gli aggiornamenti arrivano
 * dal webhook.
 */

const ENDPOINT = process.env.SHIPPYPRO_ENDPOINT || 'https://www.shippypro.com/api';
const TRACK_METHOD = process.env.SHIPPYPRO_TRACK_METHOD || 'GetTracking';

const MAX_CALLS = 20;
const WINDOW_MS = 10_000;
const calls = [];

async function throttle() {
  const now = Date.now();
  while (calls.length && now - calls[0] > WINDOW_MS) calls.shift();
  if (calls.length >= MAX_CALLS) {
    const wait = WINDOW_MS - (now - calls[0]) + 100;
    await new Promise((r) => setTimeout(r, wait));
    return throttle();
  }
  calls.push(Date.now());
}

export async function call(method, params) {
  const key = process.env.SHIPPYPRO_API_KEY;
  if (!key) throw new Error('SHIPPYPRO_API_KEY non configurato');

  await throttle();

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'),
    },
    body: JSON.stringify({ Method: method, Params: params }),
  });

  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000));
    return call(method, params);
  }
  if (!res.ok) throw new Error(`ShippyPro HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Stato corrente di una spedizione, nella forma grezza ShippyPro.
 *
 * ⚠️ Il parametro è `Code` con la C maiuscola. La documentazione lo riporta
 * minuscolo, ma l'API risponde:
 *
 *   { "Error": "Invalid tracking code",
 *     "ValidationErrors": "Params.Code: The property Code is required" }
 *
 * Verificato sul campo, non dedotto dalla documentazione.
 */
export async function getTracking(trackingNumber) {
  return call(TRACK_METHOD, { Code: trackingNumber });
}

/**
 * Estrae lo stato dalla risposta di GetTracking.
 *
 * Forma reale, verificata sul campo:
 *
 *   {
 *     "Details": [],                    <- cronologia eventi del vettore
 *     "StatusCode": 5,
 *     "ExtendedStatusCode": null,
 *     "Carrier": "PosteDeliveryBusiness",
 *     "Completed": false,
 *     "EstimatedDeliveryDate": "0",     <- "0" = non disponibile
 *     "FirstStatusDate": "0",
 *     "Late": false,
 *     "ExternalLink": "https://www.poste.it/...",
 *     "AdditionalTrackingNumbers": []
 *   }
 *
 * Lo stato corrente sta al primo livello. Da `Details`, quando è popolato,
 * si recupera la descrizione dell'ultimo evento, che il primo livello non ha.
 */
export function unwrapTracking(raw) {
  if (!raw || typeof raw !== 'object') return {};

  const dettagli = Array.isArray(raw.Details) ? raw.Details : [];
  if (!dettagli.length) return raw;

  const recente = dettagli.reduce((a, b) =>
    Number(a?.date ?? a?.Date ?? a?.StatusDate ?? 0) >= Number(b?.date ?? b?.Date ?? b?.StatusDate ?? 0) ? a : b
  );

  // Il primo livello vince: è lo stato corrente consolidato.
  return { ...(recente && typeof recente === 'object' ? recente : {}), ...raw };
}

/**
 * La spedizione ha almeno un evento reale del vettore?
 *
 * ⚠️ Serve a evitare un errore grave. Su una LDV appena creata, quando il
 * corriere non ha ancora scansionato nulla, GetTracking risponde
 * `StatusCode: 5` con `Details: []` e `FirstStatusDate: "0"`.
 *
 * Nella scala ShippyPro il 5 è "Exception": mapparlo alla lettera direbbe al
 * cliente "Spedizione in ritardo" su un pacco appena etichettato. Il 5 qui non
 * indica un problema, indica assenza di dati.
 *
 * Senza eventi non si scrive nulla: la pagina mostra "Ordine in lavorazione",
 * che è esattamente ciò che questa app deve comunicare in quella fase.
 */
export function trackingHasEvents(raw) {
  if (Array.isArray(raw?.Details) && raw.Details.length) return true;
  const prima = raw?.FirstStatusDate;
  return Boolean(prima && prima !== '0' && Number(prima) > 0);
}

/**
 * Marketplace collegati all'account, con ID ed etichetta.
 * Serve a ricavare gli ID dei canali Shopify: l'account ShippyPro è condiviso
 * fra più business e solo una parte del traffico ci riguarda.
 *
 * @param {1|0|null} active 1 = solo attivi, 0 = solo inattivi, null = tutti
 */
export async function getMarketplaces(active = 1) {
  return call('GetMarketplaces', active == null ? {} : { Active: active });
}
