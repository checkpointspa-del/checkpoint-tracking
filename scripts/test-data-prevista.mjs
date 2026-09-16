/**
 * Verifica della regola sulla data prevista.
 * Nessuna rete: si testa il calcolo, non Shopify.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggiungiGiorniLavorativi, eNonLavorativo, dataEOraShop,
         calcolaDataPrevista, categoriaDaTag } from '../lib/eta.js';

test('i giorni lavorativi saltano il fine settimana', () => {
  // venerdì 4 settembre 2026 + 1 giorno lavorativo -> lunedì 7
  assert.equal(aggiungiGiorniLavorativi('2026-09-04', 1), '2026-09-07');
});

test('i giorni lavorativi saltano i festivi italiani', () => {
  // venerdì 14 agosto + 1: il 15 è festivo E sabato -> lunedì 17
  assert.equal(aggiungiGiorniLavorativi('2026-08-14', 1), '2026-08-17');
});

test('il risultato non cade mai su un giorno non lavorativo', () => {
  for (let g = 1; g <= 30; g++) {
    const d = aggiungiGiorniLavorativi('2026-08-03', g);
    assert.equal(eNonLavorativo(d), false, `${g} giorni -> ${d} non è lavorativo`);
  }
});

test('l’ora è quella di Roma, non UTC — è il punto in cui si sbaglia', () => {
  // 06:30 UTC in agosto = 08:30 a Roma: è DOPO le 08:00, non prima.
  const { ora } = dataEOraShop('2026-08-20T06:30:00Z');
  assert.equal(ora, 8);
});

test('la mezzanotte italiana non sposta il giorno indietro', () => {
  // 22:30 UTC del 20 = 00:30 del 21 a Roma
  const { data } = dataEOraShop('2026-08-20T22:30:00Z');
  assert.equal(data, '2026-08-21');
});

test('categoria Scuola Calcio: data fissa, qualunque sia l’ora', () => {
  const a = calcolaDataPrevista('2026-08-10T20:51:32Z', 'SCUOLACALCIO2020/2021/2022');
  assert.equal(a.data, '2026-09-04');
  const b = calcolaDataPrevista('2026-07-01T05:00:00Z', 'Scuola Calcio 2020 2021 2022');
  assert.equal(b.data, '2026-09-04', 'il confronto deve reggere spazi e maiuscole diverse');
});

test('ordine entro le 08:00 di Roma: +10 giorni lavorativi', () => {
  // Categoria NON coperta dalle regole speciali: Pulcini e Primi Calci hanno la loro.
  // 05:00 UTC = 07:00 a Roma, mercoledì 5 agosto -> +10 gg lav. = 19 agosto
  const r = calcolaDataPrevista('2026-08-05T05:00:00Z', 'UNDER 14/15/16/17/18');
  assert.equal(r.data, '2026-08-19');
  assert.match(r.motivo, /entro le 08:00/);
});

test('ordine dopo le 08:00 di Roma: +11 giorni lavorativi', () => {
  // 08:00 UTC = 10:00 a Roma, stesso mercoledì -> +11 gg lav. = 20 agosto
  const r = calcolaDataPrevista('2026-08-05T08:00:00Z', 'UNDER 14/15/16/17/18');
  assert.equal(r.data, '2026-08-20');
  assert.match(r.motivo, /dopo le 08:00/);
});

test('le 08:00 in punto contano come DOPO, non come entro', () => {
  // 06:00 UTC = 08:00 esatte a Roma
  const r = calcolaDataPrevista('2026-08-05T06:00:00Z', 'UNDER 14/15/16/17/18');
  assert.match(r.motivo, /dopo le 08:00/, 'la soglia è "entro le 8", quindi alle 8 in punto si è fuori');
});

test('una categoria mancante non manda in errore: vale la regola generale', () => {
  const r = calcolaDataPrevista('2026-08-05T05:00:00Z', '');
  assert.equal(r.data, '2026-08-19');
});

test('la categoria si legge dai tag anche con spazi attorno all\u2019uguale', () => {
  assert.equal(categoriaDaTag(['soc_categoria = PULCINI 2016', 'exported=1']), 'PULCINI 2016');
  assert.equal(categoriaDaTag(['exported=1']), '');
});

/* ---------- Pulcini e Primi Calci: regola del 27 agosto ---------- */

test('Pulcini ordinato prima del 27/08 08:00: partenza unica il 27/08', () => {
  // 26CKPT2332 sui dati reali: PULCINI 2017, ordinato il 24 luglio
  const r = calcolaDataPrevista('2026-07-24T13:55:08Z', 'PULCINI 2017');
  assert.equal(r.data, '2026-08-27');
  assert.match(r.motivo, /partenza unica/);
});

test('Primi Calci prima del taglio: stessa regola dei Pulcini', () => {
  assert.equal(calcolaDataPrevista('2026-08-05T09:00:00Z', 'PRIMI CALCI 2018').data, '2026-08-27');
  assert.equal(calcolaDataPrevista('2026-08-05T09:00:00Z', 'PRIMI CALCI 2019').data, '2026-08-27');
});

test('la categoria composta PULCINI 2016/2017 rientra nella regola', () => {
  assert.equal(calcolaDataPrevista('2026-08-05T09:00:00Z', 'PULCINI 2016/2017').data, '2026-08-27');
});

test('il taglio \u00e8 alle 08:00 del 27, non a mezzanotte', () => {
  // 05:00 UTC = 07:00 a Roma del 27 -> ancora PRIMA del taglio
  assert.equal(calcolaDataPrevista('2026-08-27T05:00:00Z', 'PULCINI 2016').data, '2026-08-27');
  // 07:00 UTC = 09:00 a Roma del 27 -> DOPO: +10 gg lavorativi dal 27/08
  const dopo = calcolaDataPrevista('2026-08-27T07:00:00Z', 'PULCINI 2016');
  assert.equal(dopo.data, '2026-09-10');
  assert.match(dopo.motivo, /dopo il taglio/);
});

test('le 08:00 in punto del 27 sono DOPO il taglio', () => {
  // 06:00 UTC = 08:00 esatte a Roma
  const r = calcolaDataPrevista('2026-08-27T06:00:00Z', 'PULCINI 2017');
  assert.match(r.motivo, /dopo il taglio/);
});

test('Pulcini dopo il taglio: sempre +10, mai +11 anche di pomeriggio', () => {
  const pomeriggio = calcolaDataPrevista('2026-08-31T14:00:00Z', 'PULCINI 2017');
  assert.match(pomeriggio.motivo, /\+10 gg lavorativi/);
  // stesso istante, categoria diversa: torna la variante a 11
  const altra = calcolaDataPrevista('2026-08-31T14:00:00Z', 'UNDER 14/15/16/17/18');
  assert.match(altra.motivo, /\+11 gg lavorativi/);
});

test('Scuola Calcio vince anche sulla regola Pulcini', () => {
  assert.equal(calcolaDataPrevista('2026-07-01T05:00:00Z', 'SCUOLACALCIO2020/2021/2022').data, '2026-09-04');
});

test('le altre categorie non sono toccate dalla regola del 27 agosto', () => {
  // UNDER ordinato a luglio: resta la regola generale, non il 27/08
  const r = calcolaDataPrevista('2026-07-24T14:36:13Z', 'UNDER 14/15/16/17/18');
  assert.notEqual(r.data, '2026-08-27');
  assert.match(r.motivo, /gg lavorativi/);
});
