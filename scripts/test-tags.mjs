#!/usr/bin/env node
/**
 * Verifica che nessun tag ordine finisca nella risposta pubblica.
 *
 * `soc_atleta` e `soc_nome` contengono nomi di persone e società: la pagina
 * tracking è raggiungibile con un link condivisibile, quindi questi valori
 * non devono uscire dall'API in nessun caso.
 *
 * Da rilanciare dopo ogni modifica a toPublicShape().
 *
 *   node scripts/test-tags.mjs
 */

process.env.TRACKING_TOKEN_SECRET ||= 'test';
process.env.TRACKING_PAGE_URL ||= 'https://example.invalid/pages/tracking-area';
process.env.SHOP_TIMEZONE ||= 'Europe/Rome';

const { toPublicShape } = await import('../lib/orders.js');
const { todayInShopTz } = await import('../lib/eta.js');

const SEGRETI = ['CKP0912', 'Rossi Matteo', 'Under 15 Regionale', 'ASD Virtus Calcio'];
const domani = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);

const base = (tags, fulfillments = []) => ({
  id: 'gid://shopify/Order/1',
  name: '26CKPT0001',
  tags,
  displayFulfillmentStatus: 'UNFULFILLED',
  fulfillments,
});

const TAGS_COMPLETI = [
  `spedizione_prevista=${domani}`,
  'codice_soc=CKP0912',
  'soc_atleta=Rossi Matteo',
  'soc_categoria=Under 15 Regionale',
  'soc_nome=ASD Virtus Calcio',
  'exported=1',
];

let ko = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) ko++;
};

console.log('\nTag ordine — nessuna fuga verso il browser\n');

const out = toPublicShape(base(TAGS_COMPLETI));
const json = JSON.stringify(out);

check('la risposta non contiene la chiave "tags"', !('tags' in out));
for (const s of SEGRETI) check(`la risposta non contiene "${s}"`, !json.includes(s));
check('la data prevista è esposta solo come etichetta', out.eta && !json.includes(domani));

console.log('\nFlag alert\n');

const conAlert = toPublicShape(base([...TAGS_COMPLETI, 'alert']));
check('con `alert` la data prevista non viene mostrata', conAlert.eta === null);
check('senza `alert` la data prevista viene mostrata', out.eta !== null);

console.log('\nData prevista\n');

const ieri = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
check('data superata: nascosta', toPublicShape(base([`spedizione_prevista=${ieri}`])).eta === null);
check('data di oggi: ancora mostrata', toPublicShape(base([`spedizione_prevista=${todayInShopTz()}`])).eta !== null);
check('formato non valido: ignorato', toPublicShape(base(['spedizione_prevista=25/08/2026'])).eta === null);
check('tag assente: nessuna data', toPublicShape(base(['codice_soc=CKP0912'])).eta === null);

console.log('\nFase 2: la data sparisce anche se il tag resta\n');

const spedito = toPublicShape(
  base([`spedizione_prevista=${domani}`], [{
    id: 'gid://shopify/Fulfillment/1',
    status: 'SUCCESS',
    displayStatus: 'IN_TRANSIT',
    trackingInfo: [{ company: 'Poste Italiane', number: 'AAA1' }],
    events: { nodes: [{ status: 'IN_TRANSIT', happenedAt: new Date().toISOString() }] },
  }])
);
check('spedizione in transito: nessuna data prevista', spedito.eta === null);
check('spedizione in transito: link corriere presente', !!spedito.parcels[0].carrierUrl);

console.log(ko === 0 ? '\nTutti i controlli superati.\n' : `\n${ko} CONTROLLI FALLITI.\n`);
process.exit(ko === 0 ? 0 : 1);
