/**
 * Normalizzazione stati: ShippyPro -> Shopify FulfillmentEventStatus -> fase cliente.
 * Unica fonte di verità del progetto. Sia il modulo di sincronizzazione
 * sia la pagina tracking leggono da qui.
 */

/** Gli 11 stati scrivibili via fulfillmentEventCreate. */
export const SHOPIFY_STATUSES = [
  'CONFIRMED',
  'LABEL_PURCHASED',
  'LABEL_PRINTED',
  'CARRIER_PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'READY_FOR_PICKUP',
  'ATTEMPTED_DELIVERY',
  'DELAYED',
  'DELIVERED',
  'FAILURE',
];

/**
 * Codici ShippyPro (Tracking Mapping System) -> stato Shopify.
 * I sotto-stati vengono collassati: la granularità persa finisce nel campo `message`.
 */
const BY_CODE = {
  1000: 'CONFIRMED',

  2000: 'IN_TRANSIT',
  2100: 'IN_TRANSIT',
  2200: 'CARRIER_PICKED_UP',
  2300: 'IN_TRANSIT',
  2310: 'IN_TRANSIT',
  2320: 'IN_TRANSIT',
  2330: 'IN_TRANSIT',
  2400: 'IN_TRANSIT',
  2500: 'IN_TRANSIT',

  3000: 'OUT_FOR_DELIVERY',
  3100: 'OUT_FOR_DELIVERY',
  3200: 'READY_FOR_PICKUP',

  4000: 'ATTEMPTED_DELIVERY',

  5000: 'DELAYED',
  5100: 'DELAYED',
  5110: 'DELAYED',
  5120: 'DELAYED',
  5200: 'DELAYED',
  5210: 'DELAYED',
  5220: 'DELAYED',
  5230: 'DELAYED',
  5300: 'FAILURE',
  5310: 'FAILURE',
  5320: 'FAILURE',
  5330: 'FAILURE',
  5340: 'FAILURE',
  5400: 'ATTEMPTED_DELIVERY',
  5410: 'ATTEMPTED_DELIVERY',
  5420: 'ATTEMPTED_DELIVERY',
  5500: 'DELAYED',
  5510: 'DELAYED',
  5520: 'DELAYED',
  5600: 'DELAYED',
  5610: 'ATTEMPTED_DELIVERY',
  5620: 'DELAYED',
  5630: 'FAILURE', // Returning to Sender: nessun equivalente Shopify, vedi ORDER_TAGS
  5700: 'DELAYED',
  5710: 'DELAYED',
  5720: 'DELAYED',
  5730: 'DELAYED',

  6000: 'DELIVERED',
  6900: 'DELIVERED',

  // 9999 = "Not mapped": ShippyPro non è riuscita a interpretare l'evento del
  // vettore. Non inventiamo uno stato, si ignora.
  9999: null,
};

/**
 * Stati semplici ShippyPro (`code` nel webhook, `StatusCode` in GetTracking).
 * Usati quando l'evento non porta il codice esteso, che può arrivare null.
 *
 * Lo 0 esiste solo nella tabella del webhook, non in quella di GetTracking:
 * è proprio il caso "LDV creata ma pacco non ancora affidato al vettore",
 * il problema che questa app deve rendere visibile al cliente.
 */
const BY_SIMPLE = {
  0: 'CONFIRMED',          // Order In Preparation
  1: 'CONFIRMED',          // Info Received
  2: 'IN_TRANSIT',         // In Transit
  3: 'OUT_FOR_DELIVERY',   // Out for Delivery
  4: 'ATTEMPTED_DELIVERY', // Missed Delivery
  5: 'DELAYED',            // Exception
  6: 'DELIVERED',          // Delivered
};

/** Fallback testuale, se il payload ShippyPro arriva senza codice numerico. */
const BY_TEXT = {
  'information received': 'CONFIRMED',
  'in transit': 'IN_TRANSIT',
  'collected by carrier': 'CARRIER_PICKED_UP',
  'carrier handling': 'IN_TRANSIT',
  'customs clearance': 'IN_TRANSIT',
  'delivery planned': 'IN_TRANSIT',
  'out for delivery': 'OUT_FOR_DELIVERY',
  'delivery in progress': 'OUT_FOR_DELIVERY',
  'available for pickup': 'READY_FOR_PICKUP',
  'failed attempt': 'ATTEMPTED_DELIVERY',
  exception: 'DELAYED',
  delayed: 'DELAYED',
  'returning to sender': 'FAILURE',
  lost: 'FAILURE',
  damaged: 'FAILURE',
  destroyed: 'FAILURE',
  delivered: 'DELIVERED',
};

/**
 * Codici che meritano un tag ordine, perché richiedono azione operativa.
 * I nomi seguono la convenzione tag di Check Point: vedi lib/tags.js.
 */
import { APP_TAGS } from './tags.js';

export const ORDER_TAGS = {
  5320: APP_TAGS.PROBLEM,   // Damaged
  5330: APP_TAGS.PROBLEM,   // Lost
  5340: APP_TAGS.PROBLEM,   // Destroyed
  5630: APP_TAGS.RETURNING, // Returning to Sender
};

/**
 * Ordine di progressione. Serve a scartare eventi che tornano indietro.
 * ATTEMPTED_DELIVERY e DELAYED sono eccezioni fuori scala: legittime in
 * qualsiasi momento, quindi sempre accettate se più recenti.
 */
const RANK = {
  CONFIRMED: 10,
  LABEL_PURCHASED: 15,
  LABEL_PRINTED: 15,
  CARRIER_PICKED_UP: 20,
  IN_TRANSIT: 30,
  OUT_FOR_DELIVERY: 40,
  READY_FOR_PICKUP: 45,
  DELIVERED: 100,
  FAILURE: 100,
};
const OUT_OF_SCALE = new Set(['ATTEMPTED_DELIVERY', 'DELAYED']);

export const isTerminal = (s) => s === 'DELIVERED';
export const rankOf = (s) => RANK[s] ?? 0;
export const isOutOfScale = (s) => OUT_OF_SCALE.has(s);

/**
 * Estrae lo stato Shopify da un payload ShippyPro.
 *
 * Ordine di preferenza:
 *   1. ExtendedStatusCode (1000-9999), il più granulare
 *   2. StatusCode (1-6), la scala semplice
 *   3. descrizione testuale, come ultima risorsa
 *
 * @returns {{status: string|null, code: number|null, message: string}}
 */
export function mapShippyProStatus(raw) {
  const code = pickExtendedCode(raw);
  const simple = pickSimpleCode(raw);
  const text = pickText(raw);

  let status = null;

  if (code != null) {
    // I sotto-stati non elencati risalgono al livello superiore:
    // 2315 -> 2300 -> 2000. Un valore esplicitamente null (9999) resta null.
    status = code in BY_CODE
      ? BY_CODE[code]
      : BY_CODE[Math.floor(code / 100) * 100] ?? BY_CODE[Math.floor(code / 1000) * 1000] ?? null;
  }
  // Se l'esteso non dà un risultato — perché è 9999 "Not mapped" o perché
  // manca — si ripiega sulla scala semplice. Uno stato grossolano ma vero
  // è meglio di un evento buttato via.
  if (!status && simple != null) status = BY_SIMPLE[simple] ?? null;
  if (!status && text) {
    const t = text.toLowerCase().trim();

    if (BY_TEXT[t]) {
      status = BY_TEXT[t];
    } else {
      // Il match per sottostringa e' pericoloso proprio sul caso piu' delicato:
      // "not delivered", "undelivered", "delivery failed — undelivered"
      // contengono tutti "delivered" e diventerebbero una CONSEGNA, che e'
      // terminale. Le negazioni vanno riconosciute prima.
      const negato = /\b(not|non|no|failed|unsuccessful|attempted|refused)\b|undeliver|non consegnat|mancata consegna/.test(t);

      // Chiavi piu' lunghe per prime: "out for delivery" deve battere "delivery".
      const chiave = Object.keys(BY_TEXT)
        .sort((a, b) => b.length - a.length)
        .find((k) => t.includes(k));

      // Su una negazione non si ripiega su uno stato "quasi giusto": si lascia
      // null e l'evento non viene scritto. Meglio nessuno stato che una
      // consegna inventata e irreversibile.
      if (chiave && !(negato && BY_TEXT[chiave] === 'DELIVERED')) status = BY_TEXT[chiave];
    }
  }

  // `AtPudo` è un attributo booleano del webhook: il pacco è fisicamente a un
  // punto di ritiro. È più preciso di "in transito" o "in consegna" per chi
  // legge la pagina, e va detto perché richiede un'azione del cliente.
  if (raw?.AtPudo === true && (status === 'IN_TRANSIT' || status === 'OUT_FOR_DELIVERY')) {
    status = 'READY_FOR_PICKUP';
  }

  return { status, code: code ?? simple, message: text || '' };
}

/**
 * `IsReturning`: la spedizione in uscita ha avuto un'eccezione e sta tornando
 * al mittente. Da non confondere con `IsReturn`, che indica un ordine di reso.
 * Non cambia lo stato mostrato al cliente, ma va segnalato al customer service.
 */
export const isReturningToSender = (raw) =>
  raw?.IsReturning === true || raw?.IsReturning === 'true';

/**
 * Stato esteso, 1000-9999.
 * Nel webhook si chiama `extendedCode` ed è una STRINGA; nella risposta di
 * GetTracking la documentazione lo chiama `ExtendedStatusCode`.
 */
function pickExtendedCode(raw) {
  const candidates = [
    raw?.extendedCode, raw?.ExtendedStatusCode, raw?.extended_status_code, raw?.extendedStatusCode,
    // Alcuni payload possono portare l'esteso dentro il campo dello stato
    // semplice: si riconosce dall'ordine di grandezza.
    raw?.StatusCode, raw?.status_code, raw?.code,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 1000 && n <= 9999) return n;
  }
  return null;
}

/**
 * Stato semplice, 0-6.
 * Nel webhook si chiama `code`; in GetTracking `StatusCode`.
 * Lo 0 è valido: "Order In Preparation".
 */
function pickSimpleCode(raw) {
  for (const c of [raw?.code, raw?.StatusCode, raw?.status_code, raw?.statusCode, raw?.Status]) {
    if (c === null || c === undefined || c === '') continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0 && n <= 6) return n;
  }
  return null;
}

/** Descrizione leggibile: nel webhook è `message`. */
function pickText(raw) {
  const candidates = [
    raw?.message, raw?.StatusDescription, raw?.status_description,
    raw?.StatusName, raw?.Status, raw?.status, raw?.TrackingStatus, raw?.Description,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}

/* ------------------------------------------------------------------ *
 * Presentazione lato cliente: 3 fasi, testi in italiano.
 * FASE 1  nessun link al corriere
 * FASE 2  link al corriere visibile
 * FASE 3  terminale, link nascosto
 * ------------------------------------------------------------------ */
export const PRESENTATION = {
  NONE:               { phase: 1, step: 0, tone: 'idle', title: 'Ordine in lavorazione',     sub: 'Stiamo preparando il tuo pacco.',                                  pill: 'In preparazione' },
  CONFIRMED:          { phase: 1, step: 0, tone: 'idle', title: 'Ordine in lavorazione',     sub: 'Stiamo preparando il tuo pacco.',                                  pill: 'In preparazione' },
  LABEL_PURCHASED:    { phase: 1, step: 0, tone: 'idle', title: 'Ordine in lavorazione',     sub: 'Stiamo preparando il tuo pacco.',                                  pill: 'In preparazione' },
  LABEL_PRINTED:      { phase: 1, step: 0, tone: 'idle', title: 'Ordine in lavorazione',     sub: 'Stiamo preparando il tuo pacco.',                                  pill: 'In preparazione' },
  CARRIER_PICKED_UP:  { phase: 2, step: 1, tone: 'live', title: 'Spedizione in viaggio',     sub: 'Il corriere ha preso in carico il pacco.',                          pill: 'In viaggio' },
  IN_TRANSIT:         { phase: 2, step: 1, tone: 'live', title: 'Spedizione in viaggio',     sub: 'Il pacco è in transito verso di te.',                              pill: 'In viaggio' },
  OUT_FOR_DELIVERY:   { phase: 2, step: 2, tone: 'live', title: 'In consegna oggi',          sub: 'Il pacco è sul mezzo del corriere.',                               pill: 'In consegna' },
  READY_FOR_PICKUP:   { phase: 2, step: 2, tone: 'live', title: 'Disponibile per il ritiro', sub: 'Il pacco ti aspetta al punto di ritiro.',                           pill: 'Da ritirare' },
  ATTEMPTED_DELIVERY: { phase: 2, step: 2, tone: 'warn', title: 'Consegna non riuscita',     sub: 'Il corriere ci riproverà nei prossimi giorni.',                    pill: 'Da riconsegnare' },
  DELAYED:            { phase: 2, step: 1, tone: 'warn', title: 'Spedizione in ritardo',     sub: 'Il corriere segnala un ritardo. Il pacco è comunque in viaggio.',   pill: 'In ritardo' },
  FAILURE:            { phase: 2, step: 1, tone: 'warn', title: 'Problema di spedizione',    sub: 'Il corriere segnala un problema sulla spedizione.',                 pill: 'Da verificare' },
  DELIVERED:          { phase: 3, step: 3, tone: 'done', title: 'Ordine consegnato',         sub: '',                                                                 pill: 'Consegnato', parcelTitle: 'Spedizione consegnata' },
};

export const present = (status) => PRESENTATION[status] || PRESENTATION.NONE;
