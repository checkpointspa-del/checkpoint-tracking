/**
 * Convenzione tag ordine Check Point.
 *
 * Tag scritti dall'ERP / dal ramo società (l'app li legge, non li tocca mai):
 *
 *   spedizione_prevista=AAAA-MM-GG   sempre, se una data è stata calcolata
 *   codice_soc=…                     ramo società, copiato dal cliente
 *   soc_atleta=…                     ramo società, copiato dal cliente
 *   soc_categoria=…                  ramo società, copiato dal cliente
 *   soc_nome=…                       ramo società, copiato dal cliente
 *   alert                            manca un dato necessario
 *
 * Tag scritti da questa app (stile allineato: minuscolo, underscore,
 * flag nudo come `alert` quando non c'è un valore):
 *
 *   consegnato                       ordine completo e tutte le spedizioni consegnate
 *   spedizione_problema              pacco danneggiato, smarrito o distrutto
 *   reso_in_rientro                  spedizione in rientro al mittente
 */

export const APP_TAGS = {
  DELIVERED: 'consegnato',
  PROBLEM: 'spedizione_problema',
  RETURNING: 'reso_in_rientro',
};

/** Tag scritti da altri: l'app non deve mai crearli, modificarli o rimuoverli. */
export const FOREIGN_TAG_PREFIXES = ['spedizione_prevista=', 'codice_soc=', 'soc_', 'exported=', 'igu=', 'alert'];

/**
 * Tag che possono uscire verso il browser: NESSUNO.
 *
 * `soc_atleta`, `soc_nome` e `codice_soc` contengono dati di persone e società.
 * La pagina tracking è raggiungibile con un link condivisibile, quindi i tag
 * non escono mai dall'API: viene esposta solo la data prevista, già
 * trasformata in un'etichetta ("25 agosto").
 *
 * Questa funzione esiste per rendere l'omissione esplicita e verificabile
 * da un test, invece di dipendere dal fatto che nessuno aggiunga `tags`
 * alla risposta per distrazione.
 */
export function stripTags(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { tags, ...rest } = obj;
  return rest;
}

/** L'ordine ha il flag `alert`: manca un dato necessario a monte. */
export function hasAlert(tags = []) {
  return tags.some((t) => String(t).trim().toLowerCase() === 'alert');
}
