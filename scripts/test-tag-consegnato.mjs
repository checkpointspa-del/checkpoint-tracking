/**
 * Verifica di valutaConsegnato: decide quando un ordine è terminale.
 * Nessuna rete.
 *   npm run test:tag
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { valutaConsegnato } from '../lib/orders.js';

const ff = (displayStatus, tracking = 'ABC', status = 'SUCCESS') => ({
  id: 'gid://f' + Math.random(), status, displayStatus,
  trackingInfo: tracking ? [{ number: tracking }] : [],
});
const ord = (displayFulfillmentStatus, fulfillments, tags = []) =>
  ({ id: 'gid://o1', name: '26CKPT1', tags, displayFulfillmentStatus, fulfillments });

test('ordine non completamente evaso: resta aperto', () => {
  const e = valutaConsegnato(ord('PARTIALLY_FULFILLED', [ff('DELIVERED')]));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /non completamente evaso/);
});

test('spedizione unica consegnata: si tagga', () => {
  const e = valutaConsegnato(ord('FULFILLED', [ff('DELIVERED')]));
  assert.equal(e.tagged, true);
});

test('due spedizioni tracciate, una sola consegnata: resta aperto', () => {
  const e = valutaConsegnato(ord('FULFILLED', [ff('DELIVERED', 'A'), ff('IN_TRANSIT', 'B')]));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /non tutte le spedizioni tracciate/);
});

test('spedizione senza tracking accanto a una consegnata: la merce viaggia con quel tracking', () => {
  // Decisione Checkpoint 31/08: sono evasioni parziali per errore, poi chiuse.
  // Se l'ordine e' FULFILLED e c'e' un tracking, tutto viaggia con quel tracking.
  const e = valutaConsegnato(ord('FULFILLED', [ff('FULFILLED', null), ff('DELIVERED', 'A')]));
  assert.equal(e.tagged, true);
  assert.match(e.motivo, /senza tracking/);
  assert.equal(e.senzaTracking, 1);
});

test('con piu tracking, il senza-tracking non chiude un ordine ancora in viaggio', () => {
  // Il fulfillment senza codice si accorpa al primo tracking, ma l'ordine
  // resta aperto finche' TUTTE le spedizioni tracciate non sono consegnate.
  const e = valutaConsegnato(
    ord('FULFILLED', [ff('FULFILLED', null), ff('DELIVERED', 'A'), ff('IN_TRANSIT', 'B')]),
  );
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /non tutte le spedizioni tracciate/);
});

test('escape hatch: ignoraSenzaTracking=false rimette il comportamento prudente', () => {
  const e = valutaConsegnato(
    ord('FULFILLED', [ff('FULFILLED', null), ff('DELIVERED', 'A')]),
    { ignoraSenzaTracking: false },
  );
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /senza tracking/);
});

test('nessuna spedizione tracciata: non si decide nulla', () => {
  const e = valutaConsegnato(ord('FULFILLED', [ff('FULFILLED', null)]));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /nessuna spedizione con tracking/);
});

test('le spedizioni annullate non contano', () => {
  const e = valutaConsegnato(ord('FULFILLED', [ff('DELIVERED', 'A'), ff('CANCELED', 'B', 'CANCELLED')]));
  assert.equal(e.tagged, true);
});

test('un ordine già taggato non si ritagga', () => {
  const e = valutaConsegnato(ord('FULFILLED', [ff('DELIVERED')], ['consegnato']));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /già presente/);
});

test('ordine senza spedizioni attive: resta aperto', () => {
  const e = valutaConsegnato(ord('FULFILLED', [ff('CANCELED', 'A', 'CANCELLED')]));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /nessuna spedizione attiva/);
});

/* ---------- ritiro in negozio ----------
 * Il ritiro e' escluso dal perimetro del cruscotto alla sorgente
 * (`NOT delivery_method:pick-up`), quindi qui non serve alcuna regola nuova.
 * Questi test bloccano il comportamento che rende sicura quella scelta:
 * un ritiro puro non viene mai taggato e non blocca nulla, un ritiro che e'
 * stato spedito davvero si comporta come qualunque altra spedizione.
 * Se qualcuno aggiungesse `NOT delivery_method:pick-up` anche a riallinea o a
 * snapshot, sarebbero proprio questi ordini a sparire: e' il motivo per cui
 * quei due script NON filtrano per metodo di consegna.
 */
test('ritiro in negozio senza spedizione: non si tagga e non resta bloccato', () => {
  // Merce consegnata allo sportello: un fulfillment evaso, nessun tracking.
  // Non ricevera' mai eventi, quindi non puo' diventare DELIVERED. Il tag non
  // arriva, ed e' corretto: dire "consegnato" qui sporcherebbe il dato.
  // Non blocca le liste perche' il cruscotto non lo carica proprio.
  const e = valutaConsegnato(ord('FULFILLED', [ff('FULFILLED', null)]));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /nessuna spedizione con tracking/);
});

test('ritiro in negozio poi spedito: si comporta come una spedizione normale', () => {
  // ~20% dei ritiri di questo store finisce spedito. Deve chiudersi da solo,
  // altrimenti il recupero del cruscotto lo ripescherebbe per sempre.
  const e = valutaConsegnato(ord('FULFILLED', [ff('FULFILLED', null), ff('DELIVERED', '3UW1JS2030781')]));
  assert.equal(e.tagged, true);
});

test('ritiro spedito con piu LDV: resta aperto finche non sono tutte consegnate', () => {
  const e = valutaConsegnato(ord('FULFILLED', [
    ff('DELIVERED', '3UW1JS2029862'), ff('DELIVERED', '3UW1JS2029864'), ff('IN_TRANSIT', '3UW1JS2029866'),
  ]));
  assert.equal(e.tagged, undefined);
  assert.match(e.skipped, /non tutte le spedizioni tracciate/);
});
