'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  sma, ema, emaSeries, atr, atrSeries, rsi, trueRange,
  pivots, clusterLevels, shareAtLeast, quantile, requiredExcursion,
} = require('../src/indicators');

const ramp = (n, from = 100, step = 1) => Array.from({ length: n }, (_, i) => from + i * step);
const candle = (open, high, low, close, volume = 1) => ({ open, high, low, close, volume, openTime: 0, closeTime: 1 });

test('una longitud inválida devuelve null y nunca NaN', () => {
  const values = ramp(50);
  for (const bad of [NaN, 0, -3, 1.5, undefined, null, '20']) {
    assert.strictEqual(ema(values, bad), null, `ema con ${bad}`);
    assert.strictEqual(sma(values, bad), null, `sma con ${bad}`);
  }
});

test('el bug de la tabla: con EMA inválida no se puede concluir tendencia', () => {
  // Antes ema() devolvía NaN, `NaN > NaN` era false y la celda decía "Bajista".
  const fast = ema(ramp(300), parseInt('', 10));
  const slow = ema(ramp(300), parseInt('', 10));
  assert.strictEqual(fast, null);
  assert.strictEqual(slow, null);
  assert.ok(!(Number.isFinite(fast) && Number.isFinite(slow)), 'no hay dos números que comparar');
});

test('la EMA arranca con media simple y no arrastra el primer precio', () => {
  const values = ramp(300); // 100..399, pendiente 1
  // Sobre una recta, la EMA(n) va exactamente (n-1)/2 por detrás del último valor.
  assert.ok(Math.abs(ema(values, 200) - (399 - 199 / 2)) < 1e-6);
  assert.ok(Math.abs(ema(values, 20) - (399 - 19 / 2)) < 1e-6);
});

test('la serie de EMA tiene la longitud de la entrada y null antes del arranque', () => {
  const series = emaSeries(ramp(30), 10);
  assert.strictEqual(series.length, 30);
  assert.strictEqual(series[8], null);
  assert.ok(Number.isFinite(series[9]), 'el primer valor cae en el índice length-1');
  assert.strictEqual(series[9], sma(ramp(10), 10));
});

test('una serie con menos velas que el periodo devuelve todo null', () => {
  assert.deepStrictEqual(emaSeries(ramp(5), 20), [null, null, null, null, null]);
  assert.strictEqual(ema(ramp(5), 20), null);
});

test('el rango verdadero cuenta el hueco entre velas', () => {
  const previous = candle(100, 101, 99, 100);
  const gapUp = candle(110, 112, 109, 111);
  assert.strictEqual(trueRange(gapUp, previous), 12); // 112 - 100, no 112 - 109
  assert.strictEqual(trueRange(gapUp, null), 3);
});

test('el ATR de velas de rango constante es ese rango', () => {
  const candles = Array.from({ length: 40 }, () => candle(100, 102, 98, 100));
  assert.ok(Math.abs(atr(candles, 14) - 4) < 1e-9);
  assert.strictEqual(atrSeries(candles, 14)[12], null);
});

test('el RSI marca 100 en una subida sin retrocesos y 50 sin movimiento', () => {
  assert.strictEqual(rsi(ramp(40), 14), 100);
  assert.strictEqual(rsi(new Array(40).fill(100), 14), 50);
});

test('los pivotes encuentran los giros y no los bordes', () => {
  const flat = Array.from({ length: 15 }, () => candle(100, 101, 99, 100));
  flat[7] = candle(100, 110, 99, 100);
  const { highs } = pivots(flat, 3);
  assert.strictEqual(highs.length, 1);
  assert.strictEqual(highs[0].index, 7);
});

test('los pivotes cercanos se agrupan en un nivel con varios toques', () => {
  const points = [
    { price: 100, index: 1, time: 1 },
    { price: 100.4, index: 5, time: 5 },
    { price: 100.2, index: 9, time: 9 },
    { price: 120, index: 12, time: 12 },
  ];
  const levels = clusterLevels(points, 1);
  assert.strictEqual(levels.length, 2);
  assert.strictEqual(levels[0].touches, 3);
  assert.strictEqual(levels[1].touches, 1);
  assert.ok(Math.abs(levels[0].price - 100.2) < 1e-9);
});

test('shareAtLeast es la frecuencia observada', () => {
  const sample = [0, 0.5, 1, 1.5, 2];
  assert.strictEqual(shareAtLeast(sample, 1), 0.6);
  assert.strictEqual(shareAtLeast(sample, 3), 0);
  assert.strictEqual(shareAtLeast(sample, -1), 1);
  assert.strictEqual(shareAtLeast([], 1), null);
});

test('quantile ordena la muestra antes de cortar', () => {
  assert.strictEqual(quantile([3, 1, 2], 0.5), 2);
  assert.strictEqual(quantile([1, 2, 3, 4], 0), 1);
});

test('a media vela se exige raíz de dos veces el recorrido', () => {
  assert.strictEqual(requiredExcursion(1, 1), 1);
  assert.ok(Math.abs(requiredExcursion(1, 0.5) - Math.SQRT2) < 1e-9);
  assert.ok(requiredExcursion(1, 0.1) > requiredExcursion(1, 0.5), 'menos tiempo, más listón');
  assert.strictEqual(requiredExcursion(NaN, 1), null);
});
