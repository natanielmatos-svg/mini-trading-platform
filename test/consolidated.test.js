'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { consolidate, median } = require('../src/consolidated');

const ahora = 1_700_000_000_000;
const cita = (id, price, extra = {}) => ({ id, label: id, quote: 'USD', pair: `${id}-pair`, price, at: ahora, ok: true, ...extra });

test('la mediana ignora el valor de en medio impar y promedia el par', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(median([]), null);
});

test('tres mercados de acuerdo dan su precio y se declaran alineados', () => {
  const out = consolidate([cita('binance', 86600), cita('kraken', 86610), cita('coinbase', 86605)], { now: ahora });

  assert.strictEqual(out.price, 86605);
  assert.strictEqual(out.method, 'mediana');
  assert.strictEqual(out.used, 3);
  assert.strictEqual(out.spread, 10);
  assert.ok(out.spreadPct < 0.05);
  assert.strictEqual(out.agreement, 'alineados');
});

test('un mercado disparatado no arrastra el precio: para eso está la mediana', () => {
  const sano = consolidate([cita('binance', 86600), cita('kraken', 86610), cita('coinbase', 86605)], { now: ahora });
  const roto = consolidate([cita('binance', 86600), cita('kraken', 86610), cita('coinbase', 120000)], { now: ahora });

  assert.strictEqual(roto.price, 86610, 'la mediana se queda con el del medio');
  assert.ok(Math.abs(roto.price - sano.price) < 20, 'una media habría subido más de diez mil');
  assert.strictEqual(roto.agreement, 'discrepan', 'pero se avisa de que uno se fue');
});

test('cada mercado publica su diferencia con el consolidado', () => {
  const out = consolidate([cita('binance', 86600), cita('kraken', 86610), cita('coinbase', 86605)], { now: ahora });
  const porId = Object.fromEntries(out.venues.map((v) => [v.id, v]));

  assert.strictEqual(porId.binance.diff, -5);
  assert.strictEqual(porId.kraken.diff, 5);
  assert.strictEqual(porId.coinbase.diff, 0);
  assert.ok(Math.abs(porId.kraken.diffPct - 0.0058) < 0.001);
});

test('un precio viejo se enseña pero no cuenta', () => {
  const out = consolidate(
    [cita('binance', 86600), cita('kraken', 86610), cita('coinbase', 90000, { at: ahora - 60_000 })],
    { now: ahora, staleMs: 10_000 }
  );

  assert.strictEqual(out.used, 2);
  assert.strictEqual(out.price, 86605, 'media de los dos frescos');
  assert.strictEqual(out.method, 'media de dos');

  const viejo = out.venues.find((v) => v.id === 'coinbase');
  assert.strictEqual(viejo.usable, false);
  assert.strictEqual(viejo.ageMs, 60_000);
  assert.strictEqual(viejo.price, 90000, 'se sigue enseñando para que se vea que está colgado');
});

test('un mercado caído no rompe la consolidación', () => {
  const out = consolidate(
    [cita('binance', 86600), cita('kraken', 86610), { id: 'coinbase', ok: false, price: null, error: 'HTTP 503' }],
    { now: ahora }
  );

  assert.strictEqual(out.used, 2);
  assert.strictEqual(out.price, 86605);
  assert.strictEqual(out.venues.find((v) => v.id === 'coinbase').diff, null);
});

test('con un solo mercado se dice que es uno solo, no se finge consenso', () => {
  const out = consolidate([cita('binance', 86600)], { now: ahora });
  assert.strictEqual(out.price, 86600);
  assert.strictEqual(out.method, 'único mercado');
  assert.strictEqual(out.spread, 0);
  // "alineados · 0%" sugeriría que algo lo confirma, y no hay nada.
  assert.strictEqual(out.agreement, 'sin comparación');
});

test('sin ningún precio utilizable se devuelve null, no un cero', () => {
  const out = consolidate([{ id: 'binance', ok: false, price: null }], { now: ahora });
  assert.strictEqual(out.price, null);
  assert.strictEqual(out.agreement, 'sin precio');
  assert.strictEqual(out.used, 0);
});

test('la etiqueta de acuerdo escala con la diferencia', () => {
  const con = (a, b, c) => consolidate([cita('binance', a), cita('kraken', b), cita('coinbase', c)], { now: ahora }).agreement;
  assert.strictEqual(con(86600, 86605, 86610), 'alineados');
  assert.strictEqual(con(86600, 86660, 86700), 'ligera diferencia');
  assert.strictEqual(con(86600, 87000, 87400), 'discrepan');
});
