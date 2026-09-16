#!/usr/bin/env node
/**
 * Elenca i marketplace collegati all'account ShippyPro.
 *
 * L'account è condiviso fra più business: solo una parte degli eventi riguarda
 * gli ordini Shopify. Questo script ricava gli ID da mettere in
 * SHIPPYPRO_MARKETPLACE_IDS, così il webhook scarta subito il resto senza
 * interrogare Shopify.
 *
 *   node scripts/marketplaces.mjs
 *   node scripts/marketplaces.mjs --all     # include gli inattivi
 *   node scripts/marketplaces.mjs --json    # risposta grezza, per intero
 *
 * Forma reale della risposta: un oggetto raggruppato per piattaforma,
 * non un array piatto.
 *
 *   { "Marketplaces": { "Shopify": [ { MarketplaceID, Label } ], ... } }
 */

import { pathToFileURL } from 'node:url';

/** Normalizza una voce, qualunque sia il nome dei campi. */
function normalizza(m, piattaforma) {
  return {
    id: String(m.MarketplaceID ?? m.ID ?? m.Id ?? m.id ?? '').trim(),
    label: String(m.Label ?? m.label ?? m.Name ?? '').trim(),
    piattaforma: String(piattaforma || '').trim(),
  };
}

/**
 * Appiattisce { Piattaforma: [ {...}, ... ] } in una lista.
 * Regge anche un array piatto, se un domani la forma cambiasse.
 */
export function flatten(r) {
  const root = r?.Marketplaces ?? r?.marketplaces ?? r?.Result ?? r?.result ?? r;
  if (Array.isArray(root)) {
    return root.map((m) => normalizza(m, m.Platform ?? m.platform ?? ''));
  }
  if (!root || typeof root !== 'object') return [];

  const out = [];
  for (const [piattaforma, voci] of Object.entries(root)) {
    for (const m of Array.isArray(voci) ? voci : [voci]) {
      if (m && typeof m === 'object') out.push(normalizza(m, piattaforma));
    }
  }
  return out;
}

export function stampa(list, { all = false } = {}) {
  if (!list.length) {
    console.log('\nNessun marketplace riconosciuto nella risposta.');
    console.log('Rilancia con --json per vederla per intero.\n');
    return 1;
  }

  console.log(`\n${list.length} marketplace${all ? '' : ' attivi'}\n`);

  const perPiattaforma = new Map();
  for (const m of list) {
    if (!perPiattaforma.has(m.piattaforma)) perPiattaforma.set(m.piattaforma, []);
    perPiattaforma.get(m.piattaforma).push(m);
  }

  const certi = [];

  for (const [piattaforma, voci] of perPiattaforma) {
    console.log(`  ${piattaforma || '(senza piattaforma)'}`);
    for (const m of voci) {
      // Solo la piattaforma "Shopify" è un canale nostro con certezza.
      // Gli altri vanno riconosciuti dall'etichetta, a occhio.
      const nostro = /^shopify$/i.test(piattaforma);
      if (nostro) certi.push(m.id);
      console.log(`   ${nostro ? '►' : ' '} ${m.id.padEnd(8)} ${m.label}`);
    }
    console.log('');
  }

  if (certi.length) {
    console.log('Canale Shopify diretto:\n');
    console.log(`  SHIPPYPRO_MARKETPLACE_IDS=${certi.join(',')}\n`);
  }

  console.log('⚠️  Gli ordini che passano da Beestore possono arrivare come');
  console.log('    "APIOrders" invece che come "Shopify". Se un canale APIOrders');
  console.log('    contiene ordini del vostro store, il suo ID va aggiunto a mano,');
  console.log('    separato da virgola. Un ID mancante = eventi scartati in silenzio.\n');
  return 0;
}

/* Eseguito da riga di comando, non quando importato da un test. */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await import('../lib/env.js');
  const { getMarketplaces } = await import('../lib/shippypro.js');

  const all = process.argv.includes('--all');
  const raw = await getMarketplaces(all ? null : 1);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(raw, null, 2));
  } else {
    process.exitCode = stampa(flatten(raw), { all });
  }
}
