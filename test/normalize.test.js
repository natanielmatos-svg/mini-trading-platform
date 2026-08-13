'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  midPrice,
  devig,
  logit,
  sigmoid,
  canonicalLabelKey,
  textSimilarity,
  normalizeText,
} = require('../src/normalize');

test('midPrice usa el punto medio del libro cuando hay bid y ask', () => {
  const { price, spread, source } = midPrice({ bid: 0.44, ask: 0.46 });
  assert.equal(price, 0.45);
  assert.ok(Math.abs(spread - 0.02) < 1e-9);
  assert.equal(source, 'book');
});

test('midPrice cae al último precio si no hay libro, y marca spread desconocido', () => {
  const { price, spread, source } = midPrice({ last: 0.62 });
  assert.equal(price, 0.62);
  assert.equal(spread, null);
  assert.equal(source, 'last');
});

test('midPrice descarta precios imposibles', () => {
  assert.equal(midPrice({ bid: 0, ask: 0 }).price, null);
  assert.equal(midPrice({ last: 1.4 }).price, null);
  assert.equal(midPrice({}).price, null);
});

test('devig reparte el sobre-redondeo y deja las probabilidades sumando 1', () => {
  const { probabilities, overround } = devig([0.45, 0.38, 0.2]);
  const total = probabilities.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(overround - 0.03) < 1e-9);
  // El orden relativo no cambia: sólo se reescala.
  assert.ok(probabilities[0] > probabilities[1] && probabilities[1] > probabilities[2]);
});

test('devig tolera eventos sin precios válidos', () => {
  const { probabilities, overround } = devig([null, 0, NaN]);
  assert.deepEqual(probabilities, [null, null, null]);
  assert.equal(overround, null);
});

test('logit y sigmoid son inversos', () => {
  for (const p of [0.05, 0.5, 0.93]) {
    assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-9);
  }
});

test('canonicalLabelKey unifica Sí/Yes/True entre plataformas', () => {
  assert.equal(canonicalLabelKey('Yes'), 'yes');
  assert.equal(canonicalLabelKey('Sí'), 'yes');
  assert.equal(canonicalLabelKey('True'), 'yes');
  assert.equal(canonicalLabelKey('No'), 'no');
  assert.equal(canonicalLabelKey('Gavin Newsom'), 'gavin newsom');
});

test('normalizeText quita acentos, mayúsculas y puntuación', () => {
  assert.equal(normalizeText('¿Ganará Perú la Copa América?'), 'ganara peru la copa america');
});

test('textSimilarity reconoce la misma pregunta redactada distinto', () => {
  const score = textSimilarity(
    'Presidential Election Winner 2028',
    'Who will win the 2028 presidential election?'
  );
  assert.ok(score > 0.5, `similitud demasiado baja: ${score}`);
  assert.ok(textSimilarity('Fed cuts rates in December', 'Will it rain in Miami tomorrow?') < 0.2);
});
