/**
 * Verifica del riassunto delle tappe.
 * Nessuna rete: componiSnapshot e daCronologia sono pure.
 *
 *   npm run test:snapshot
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  provaUscitaMagazzino, applicaEvento, daCronologia, componiSnapshot, leggiSnapshot,
} from '../lib/snapshot.js';

const ff = (id, numero, opts = {}) => ({
  id, status: opts.status || 'SUCCESS', displayStatus: opts.displayStatus || null,
  createdAt: opts.createdAt || '2026-08-28T10:00:00.000Z',
  trackingInfo: [{ company: 'BRT', number: numero, url: null }],
});
const ordine = (fulfillments, snapshotValue = null) => ({
  id: 'gid://shopify/Order/1', name: '26CKPT9001', tags: [],
  snapshot: snapshotValue ? { value: JSON.stringify(snapshotValue) } : null,
  fulfillments,
});
const ev = (status, happenedAt, message = '') => ({ status, happenedAt, message });

test('la LDV creata non è una presa in carico', () => {
  for (const s of ['CONFIRMED', 'LABEL_PURCHASED', 'LABEL_PRINTED', 'DELAYED']) {
    assert.equal(provaUscitaMagazzino(s), false, `${s} non deve provare l'uscita`);
  }
  for (const s of ['CARRIER_PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    assert.equal(provaUscitaMagazzino(s), true, `${s} deve provare l'uscita`);
  }
});

test('presaAt si valorizza una sola volta e non si sposta più', () => {
  let v = { presaAt: null, presaStatus: null, presaApprossimata: false, numeroEventi: 0 };
  v = applicaEvento(v, ev('LABEL_PURCHASED', '2026-08-28T10:00:00.000Z', 'Etichetta creata'));
  assert.equal(v.presaAt, null, 'l\'etichetta non apre i tempi');

  v = applicaEvento(v, ev('CARRIER_PICKED_UP', '2026-08-28T17:30:00.000Z', 'Ritirata'));
  assert.equal(v.presaAt, '2026-08-28T17:30:00.000Z');
  assert.equal(v.presaApprossimata, false);

  v = applicaEvento(v, ev('IN_TRANSIT', '2026-08-29T06:00:00.000Z', 'In transito'));
  assert.equal(v.presaAt, '2026-08-28T17:30:00.000Z', 'la presa in carico non deve muoversi');
  assert.equal(v.ultimoEventoStatus, 'IN_TRANSIT');
  assert.equal(v.numeroEventi, 3);
});

test('se il ritiro non è mai stato notificato, la presa in carico è dichiarata stimata', () => {
  let v = { presaAt: null, presaStatus: null, presaApprossimata: false, numeroEventi: 0 };
  v = applicaEvento(v, ev('IN_TRANSIT', '2026-08-29T06:00:00.000Z', 'In transito'));
  assert.equal(v.presaAt, '2026-08-29T06:00:00.000Z');
  assert.equal(v.presaApprossimata, true, 'va marcata: il ritiro è avvenuto prima e non lo abbiamo visto');
});

test('un evento fuori ordine non sovrascrive l\'ultimo evento ma può colmare un buco', () => {
  let v = { presaAt: null, presaStatus: null, presaApprossimata: false, numeroEventi: 0 };
  v = applicaEvento(v, ev('OUT_FOR_DELIVERY', '2026-08-30T08:00:00.000Z', 'In consegna'));
  const ultimoPrima = v.ultimoEventoAt;
  v = applicaEvento(v, ev('CARRIER_PICKED_UP', '2026-08-28T17:00:00.000Z', 'Ritirata'));
  assert.equal(v.ultimoEventoAt, ultimoPrima, 'l\'ultimo evento resta quello più recente');
  assert.equal(v.ultimoEventoStatus, 'OUT_FOR_DELIVERY');
  assert.equal(v.presaAt, '2026-08-30T08:00:00.000Z', 'presaAt era già valorizzato e non si muove');
});

test('dalla cronologia completa la presa in carico è il PRIMO evento di uscita', () => {
  const v = daCronologia(ff('gid://f1', 'ABC'), [
    ev('CONFIRMED', '2026-08-28T09:00:00.000Z', 'Informazioni ricevute'),
    ev('LABEL_PURCHASED', '2026-08-28T10:00:00.000Z', 'Etichetta creata'),
    ev('CARRIER_PICKED_UP', '2026-08-28T17:30:00.000Z', 'Ritirata dal corriere'),
    ev('IN_TRANSIT', '2026-08-29T06:00:00.000Z', 'In transito'),
    ev('DELIVERED', '2026-08-30T11:00:00.000Z', 'Consegnata'),
  ]);
  assert.equal(v.presaAt, '2026-08-28T17:30:00.000Z');
  assert.equal(v.presaApprossimata, false);
  assert.equal(v.consegnaAt, '2026-08-30T11:00:00.000Z');
  assert.equal(v.ultimoEventoStatus, 'DELIVERED');
  assert.equal(v.numeroEventi, 5);
  assert.equal(v.trackAt, '2026-08-28T09:00:00.000Z');
});

test('la cronologia disordinata viene comunque letta in ordine', () => {
  const v = daCronologia(ff('gid://f1', 'ABC'), [
    ev('DELIVERED', '2026-08-30T11:00:00.000Z', 'Consegnata'),
    ev('CARRIER_PICKED_UP', '2026-08-28T17:30:00.000Z', 'Ritirata'),
    ev('IN_TRANSIT', '2026-08-29T06:00:00.000Z', 'In transito'),
  ]);
  assert.equal(v.presaAt, '2026-08-28T17:30:00.000Z');
  assert.equal(v.ultimoEventoStatus, 'DELIVERED');
});

test('senza eventi restano solo i fatti certi: codice, corriere e data della LDV', () => {
  const { snapshot } = componiSnapshot(ordine([ff('gid://f1', 'ABC')]), [], 'creazione');
  const s = snapshot.spedizioni[0];
  assert.equal(s.tracking, 'ABC');
  assert.equal(s.corriere, 'BRT');
  assert.equal(s.trackAt, '2026-08-28T10:00:00.000Z');
  assert.equal(s.presaAt, null, 'nessuna data di ritiro inventata');
  assert.equal(s.consegnaAt, null);
});

test('un riassunto identico non viene riscritto', () => {
  const o1 = ordine([ff('gid://f1', 'ABC')]);
  const primo = componiSnapshot(o1, [ev2('gid://f1', 'CARRIER_PICKED_UP', '2026-08-28T17:00:00.000Z')]);
  assert.equal(primo.cambiato, true);

  const o2 = ordine([ff('gid://f1', 'ABC')], primo.snapshot);
  const secondo = componiSnapshot(o2, []);
  assert.equal(secondo.cambiato, false, 'senza nuovi eventi non si tocca il metafield');
});
function ev2(fulfillmentId, status, happenedAt, message = '') {
  return { fulfillmentId, status, happenedAt, message };
}

test('le spedizioni annullate restano fuori dal riassunto', () => {
  const o = ordine([ff('gid://f1', 'ABC'), ff('gid://f2', 'DEF', { status: 'CANCELLED' })]);
  const { snapshot } = componiSnapshot(o, []);
  assert.equal(snapshot.spedizioni.length, 1);
  assert.equal(snapshot.spedizioni[0].fulfillmentId, 'gid://f1');
});

test('due spedizioni sullo stesso ordine restano separate', () => {
  const o = ordine([ff('gid://f1', 'ABC'), ff('gid://f2', 'DEF')]);
  const { snapshot } = componiSnapshot(o, [
    ev2('gid://f1', 'CARRIER_PICKED_UP', '2026-08-28T17:00:00.000Z'),
    ev2('gid://f2', 'CARRIER_PICKED_UP', '2026-08-31T17:00:00.000Z'),
  ]);
  assert.equal(snapshot.spedizioni.length, 2);
  assert.equal(snapshot.spedizioni[0].presaAt, '2026-08-28T17:00:00.000Z');
  assert.equal(snapshot.spedizioni[1].presaAt, '2026-08-31T17:00:00.000Z');
});

test('Shopify dice consegnata ma la data non è passata da qui: si dichiara la consegna', () => {
  const o = ordine([ff('gid://f1', 'ABC', { displayStatus: 'DELIVERED' })]);
  const { snapshot } = componiSnapshot(o, [ev2('gid://f1', 'IN_TRANSIT', '2026-08-29T06:00:00.000Z')]);
  assert.equal(snapshot.spedizioni[0].consegnaAt, '2026-08-29T06:00:00.000Z');
});

test('un metafield corrotto o di versione ignota vale come assente', () => {
  assert.equal(leggiSnapshot('non-json'), null);
  assert.equal(leggiSnapshot(JSON.stringify({ v: 99, spedizioni: [] })), null);
  assert.equal(leggiSnapshot(JSON.stringify({ v: 1, spedizioni: 'no' })), null);
  assert.notEqual(leggiSnapshot(JSON.stringify({ v: 1, spedizioni: [] })), null);
});

/* ---------- regola terminale ---------- */

test('una spedizione consegnata diventa terminale', () => {
  const v = daCronologia(ff('gid://f1', 'ABC'), [
    ev('CARRIER_PICKED_UP', '2026-08-28T17:30:00.000Z', 'Ritirata'),
    ev('DELIVERED', '2026-08-30T11:00:00.000Z', 'Consegnata'),
  ]);
  assert.equal(v.terminale, true);
});

test('un webhook tardivo non riapre una spedizione consegnata', () => {
  let v = daCronologia(ff('gid://f1', 'ABC'), [
    ev('CARRIER_PICKED_UP', '2026-08-28T17:30:00.000Z', 'Ritirata'),
    ev('DELIVERED', '2026-08-30T11:00:00.000Z', 'Consegnata'),
  ]);
  const prima = JSON.stringify(v);
  v = applicaEvento(v, ev('IN_TRANSIT', '2026-08-31T09:00:00.000Z', 'In transito'));
  assert.equal(JSON.stringify(v), prima, 'la voce non deve cambiare di una virgola');
  assert.equal(v.consegnaAt, '2026-08-30T11:00:00.000Z', 'la consegna registrata non si tocca');
});

test('un DELIVERED duplicato è idempotente', () => {
  let v = daCronologia(ff('gid://f1', 'ABC'), [ev('DELIVERED', '2026-08-30T11:00:00.000Z', 'Consegnata')]);
  const prima = JSON.stringify(v);
  v = applicaEvento(v, ev('DELIVERED', '2026-08-30T11:00:00.000Z', 'Consegnata'));
  assert.equal(JSON.stringify(v), prima);
});

test('in un ordine con due spedizioni, la consegna di una non chiude l\'altra', () => {
  const o = ordine([ff('gid://f1', 'A'), ff('gid://f2', 'B')]);
  const { snapshot } = componiSnapshot(o, [
    { fulfillmentId: 'gid://f1', status: 'DELIVERED', happenedAt: '2026-08-30T11:00:00.000Z' },
    { fulfillmentId: 'gid://f2', status: 'IN_TRANSIT', happenedAt: '2026-08-30T08:00:00.000Z' },
  ]);
  assert.equal(snapshot.spedizioni[0].terminale, true);
  assert.equal(snapshot.spedizioni[1].terminale, false,
    'la seconda spedizione resta in monitoraggio');
});

test('un evento su una spedizione già terminale non provoca riscrittura', () => {
  const o1 = ordine([ff('gid://f1', 'A')]);
  const primo = componiSnapshot(o1, [
    { fulfillmentId: 'gid://f1', status: 'DELIVERED', happenedAt: '2026-08-30T11:00:00.000Z' },
  ]);
  const o2 = ordine([ff('gid://f1', 'A')], primo.snapshot);
  const secondo = componiSnapshot(o2, [
    { fulfillmentId: 'gid://f1', status: 'IN_TRANSIT', happenedAt: '2026-08-31T09:00:00.000Z' },
  ]);
  assert.equal(secondo.cambiato, false, 'niente da scrivere: nessuna chiamata sprecata');
});
