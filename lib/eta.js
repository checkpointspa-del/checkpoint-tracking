/**
 * Data prevista di spedizione.
 *
 * Formato tag concordato, allineato alla convenzione ERP già in uso
 * sugli ordini (`exported=1`, `igu=...`):
 *
 *     spedizione_prevista=YYYY-MM-DD
 *
 * Regole:
 *  - solo ISO, nessun formato locale: niente ambiguità giorno/mese;
 *  - un tag non conforme viene ignorato in silenzio, mai mostrato a metà;
 *  - con più tag validi vince la data più lontana, la meno rischiosa da promettere;
 *  - il confronto avviene sulla data civile in Europe/Rome;
 *  - il testo è sempre "Spedizione prevista", mai "Consegna prevista",
 *    e non va presentato come una data certa.
 */

const TZ = process.env.SHOP_TIMEZONE || 'Europe/Rome';
const RE = /^spedizione_prevista\s*=\s*(\d{4})-(\d{2})-(\d{2})$/i;

const MESI = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];

/** @returns {string|null} la data ISO, o null se nessun tag valido */
export function parseEtaTag(tags = []) {
  const found = [];
  for (const tag of tags) {
    const m = RE.exec(String(tag).trim());
    if (!m) continue;
    const [, y, mo, d] = m;
    const iso = `${y}-${mo}-${d}`;
    if (!isRealDate(Number(y), Number(mo), Number(d))) continue;
    found.push(iso);
  }
  if (!found.length) return null;
  return found.sort().pop(); // la più lontana
}

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Data civile di oggi nel fuso dello store, come 'YYYY-MM-DD'. */
export function todayInShopTz(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** La data è ancora valida finché non viene superata. Il 25 si mostra ancora il 25. */
export function etaIsStillRelevant(iso, now = new Date()) {
  return iso >= todayInShopTz(now);
}

/** "25 agosto" — anno omesso se è l'anno corrente. */
export function formatEtaLabel(iso, now = new Date()) {
  const [y, m, d] = iso.split('-').map(Number);
  const currentYear = Number(todayInShopTz(now).slice(0, 4));
  const base = `${d} ${MESI[m - 1]}`;
  return y === currentYear ? base : `${base} ${y}`;
}
