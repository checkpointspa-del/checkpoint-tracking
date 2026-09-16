/**
 * Ricostruzione dell'URL di tracking del corriere.
 *
 * Serve perché sovrascriviamo `trackingInfo.url` con la nostra pagina:
 * l'URL originale del vettore non è più leggibile da Shopify e va ricostruito
 * da nome corriere + codice spedizione.
 *
 * Se il corriere non è in mappa la pagina non mostra il pulsante e lascia
 * solo il codice copiabile: meglio nessun link che un link rotto.
 */

const TEMPLATES = [
  [/poste/i,               (n) => `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${n}`],
  [/^sda|sda express/i,    (n) => `https://www.sda.it/wps/portal/Servizi_online/ricerca_spedizioni?locale=it&tracing.letteraVettura=${n}`],
  [/brt|bartolini/i,       (n) => `https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=${n}`],
  [/gls/i,                 (n) => `https://www.gls-italy.com/?option=com_gls&view=track_e_trace&mode=search&numero_spedizione=${n}`],
  [/dhl/i,                 (n) => `https://www.dhl.com/it-it/home/tracciabilita.html?tracking-id=${n}&submit=1`],
  [/ups/i,                 (n) => `https://www.ups.com/track?loc=it_IT&tracknum=${n}`],
  [/fedex/i,               (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`],
  [/tnt/i,                 (n) => `https://www.tnt.it/tracking/Tracking.do?ConsigmentNumber=${n}`],
  [/inpost/i,              (n) => `https://inpost.it/tracking?number=${n}`],
  [/ipsen|nexive/i,        (n) => `https://www.nexive.it/track-and-trace?code=${n}`],
  [/dpd/i,                 (n) => `https://tracking.dpd.de/status/it_IT/parcel/${n}`],
];

/**
 * @param {string} company nome corriere come salvato su Shopify
 * @param {string} number  codice spedizione
 * @returns {string|null}  URL del vettore, o null se il corriere non è mappato
 */
export function carrierUrl(company, number) {
  if (!company || !number) return null;
  const hit = TEMPLATES.find(([re]) => re.test(company));
  return hit ? hit[1](encodeURIComponent(number)) : null;
}
