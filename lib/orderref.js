/**
 * Riferimento ordine ShippyPro -> numero ordine Shopify.
 *
 * Con le spedizioni multiple sullo stesso ordine, ShippyPro riceve un
 * `TransactionID` derivato dal numero d'ordine con un suffisso:
 *
 *   26CKPT2661        ordine singolo
 *   26CKPT2661_       suffisso vuoto
 *   26CKPT2661_1      seconda spedizione
 *   26CKPT2661#1      altra convenzione di suffisso
 *   26CKPT2661#2
 *
 * Su Shopify il numero d'ordine è sempre e solo `26CKPT2661`: le spedizioni
 * multiple sono più fulfillment dello stesso ordine.
 *
 * Regola: tenere la parte alfanumerica iniziale e scartare il primo carattere
 * speciale e tutto ciò che segue. Non elenchiamo i separatori conosciuti
 * perché domani potrebbe comparirne un altro.
 *
 * ⚠️ Attenzione: gli ordini importati con PutOrder subiscono una
 * trasformazione da parte di ShippyPro — punti e spazi diventano underscore,
 * le barre diventano trattini, i cancelletti e le virgolette vengono
 * ELIMINATI. Quindi 26CKPT2661#1 può arrivare come 26CKPT26611, che questa
 * funzione non può più separare.
 *
 * Non è un problema per la sincronizzazione: l'aggancio avviene sul codice
 * spedizione, non sul riferimento ordine. Il riferimento serve solo per i log
 * e per il filtro di forma, e 26CKPT26611 supera comunque il pattern.
 */

/** @returns {string} numero ordine normalizzato, o '' se non ricavabile */
export function normalizeOrderRef(value) {
  const s = String(value ?? '').trim().replace(/^#/, '');
  const m = /^[A-Za-z0-9]+/.exec(s);
  return m ? m[0] : '';
}

/**
 * Il riferimento somiglia a un numero d'ordine del nostro store?
 *
 * Serve a distinguere gli eventi nostri da quelli degli altri business che
 * condividono l'account ShippyPro, senza interrogare Shopify. I loro
 * riferimenti hanno forme completamente diverse: 10906161897093,
 * 305-0729732-2887568, C000D9FWH7, NL5TNYGFWCQZ-A.
 *
 * Il pattern è configurabile: se non impostato, non si filtra nulla.
 */
export function matchesOrderPattern(ref) {
  const raw = process.env.SHOPIFY_ORDER_PATTERN;
  if (!raw) return true;
  try {
    return new RegExp(raw, 'i').test(ref);
  } catch {
    // Un pattern scritto male non deve far perdere eventi: si lascia passare.
    console.warn('[orderref] SHOPIFY_ORDER_PATTERN non è una regex valida, filtro ignorato');
    return true;
  }
}
