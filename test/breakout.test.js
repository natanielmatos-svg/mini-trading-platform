'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { analyzeBreakout, excursionSample, findLevels, MIN_CANDLES } = require('../src/breakout');
const { atrSeries } = require('../src/indicators');

const STEP = 3_600_000;

// Serie que oscila entre `low` y `high` con periodo fijo: produce pivotes
// limpios en los dos extremos, que es lo que el análisis tiene que encontrar.
function oscillating({ count = 200, low = 100, high = 110, period = 20, now = Date.now() } = {}) {
  const startBucket = Math.floor(now / STEP) - count + 1;
  const level = (i) => low + (high - low) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i % period)) / period));

  return Array.from({ length: count }, (_, i) => {
    const openTime = (startBucket + i) * STEP;
    const open = level(i);
    const close = level(i + 1);
    // El giro ocurre dentro de la vela, no en la frontera entre dos: si no, dos
    // velas consecutivas comparten el máximo y ninguna es pivote.
    const esCresta = i % period === Math.floor(period / 2);
    const esValle = i % period === 0;
    return {
      openTime,
      closeTime: openTime + STEP - 1,
      open,
      high: Math.max(open, close) + (esCresta ? 0.6 : 0.1),
      low: Math.min(open, close) - (esValle ? 0.6 : 0.1),
      close,
      volume: 100,
      closed: i < count - 1,
    };
  });
}

test('sin velas suficientes se dice por qué en vez de devolver números inventados', () => {
  const corta = oscillating({ count: MIN_CANDLES - 1 });
  const out = analyzeBreakout(corta, { interval: '1h' });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /al menos 60 velas/);
});

test('velas planas no tienen ATR y el análisis lo dice', () => {
  const planas = Array.from({ length: 100 }, (_, i) => ({
    openTime: i * STEP, closeTime: (i + 1) * STEP - 1, open: 100, high: 100, low: 100, close: 100, volume: 1, closed: true,
  }));
  const out = analyzeBreakout(planas, { interval: '1h' });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /ATR/);
});

test('encuentra la resistencia y el soporte de la oscilación', () => {
  const candles = oscillating();
  const out = analyzeBreakout(candles, { interval: '1h', livePrice: 105 });

  assert.strictEqual(out.ok, true);
  assert.ok(Math.abs(out.up.level - 110.6) < 0.5, `resistencia en ${out.up.level}`);
  assert.ok(Math.abs(out.down.level - 99.4) < 0.5, `soporte en ${out.down.level}`);
  assert.ok(out.up.touches > 3, 'un nivel tocado muchas veces se agrupa en uno solo');
});

test('cuanto más cerca está el nivel, más probable es alcanzarlo', () => {
  const candles = oscillating();
  const now = candles.at(-1).openTime + STEP * 0.1;

  const lejos = analyzeBreakout(candles, { interval: '1h', livePrice: 103, now });
  const cerca = analyzeBreakout(candles, { interval: '1h', livePrice: 109.5, now });

  assert.ok(cerca.up.probability > lejos.up.probability, `${cerca.up.probability} debería superar a ${lejos.up.probability}`);
  assert.ok(cerca.up.distanceAtr < lejos.up.distanceAtr);
});

test('cuanto menos tiempo le queda a la vela, menos probable es que llegue', () => {
  const candles = oscillating();
  const abierta = analyzeBreakout(candles, { interval: '1h', livePrice: 106, now: candles.at(-1).openTime + STEP * 0.05 });
  const agotada = analyzeBreakout(candles, { interval: '1h', livePrice: 106, now: candles.at(-1).openTime + STEP * 0.95 });

  assert.ok(agotada.up.probability <= abierta.up.probability);
  assert.ok(agotada.up.requiredAtr > abierta.up.requiredAtr, 'el listón sube al quedar menos tiempo');
  // La misma distancia con una vela entera por delante no depende del reloj.
  assert.strictEqual(agotada.up.probabilityFullCandle, abierta.up.probabilityFullCandle);
});

test('la probabilidad de la vela en curso nunca supera a la de una vela entera', () => {
  const candles = oscillating();
  const out = analyzeBreakout(candles, { interval: '1h', livePrice: 104, now: candles.at(-1).openTime + STEP * 0.5 });
  for (const side of [out.up, out.down]) {
    assert.ok(side.probability <= side.probabilityFullCandle + 1e-9, `${side.direction}: ${side.probability} vs ${side.probabilityFullCandle}`);
  }
});

test('las probabilidades son frecuencias: entre 0 y 1 y con el tamaño de muestra a la vista', () => {
  const out = analyzeBreakout(oscillating(), { interval: '1h', livePrice: 105 });
  for (const side of [out.up, out.down]) {
    assert.ok(side.probability >= 0 && side.probability <= 1);
    assert.ok(side.sampleSize > 100, 'la muestra es el histórico cargado');
  }
});

test('la muestra histórica normaliza con el ATR previo a cada vela, no con el suyo', () => {
  const candles = oscillating({ count: 120 }).map((c) => ({ ...c, closed: true }));
  // Última vela cerrada con un rango enorme: si se normalizara con su propio
  // ATR el valor quedaría cerca de 1; con el ATR anterior se dispara.
  const ultima = candles[candles.length - 1];
  ultima.high = ultima.open + 50;

  const { up } = excursionSample(candles, 14);
  const atrs = atrSeries(candles, 14);
  const esperado = (ultima.high - ultima.open) / atrs[atrs.length - 2];

  assert.ok(Math.abs(up[up.length - 1] - esperado) < 1e-9);
  assert.ok(up[up.length - 1] > 10, 'no se ha usado el ATR contaminado por la propia vela');
});

test('si el precio ya pasó el nivel, la referencia pasa a ser el siguiente de arriba', () => {
  const candles = oscillating();
  const out = analyzeBreakout(candles, { interval: '1h', livePrice: 115 });
  // Por encima de todo el histórico no queda resistencia que medir.
  assert.strictEqual(out.up, null);
  assert.ok(out.down.level <= 115);
});

test('sin pivotes por encima se usa el extremo del rango y se avisa', () => {
  const subida = Array.from({ length: 150 }, (_, i) => {
    const open = 100 + i;
    return { openTime: i * STEP, closeTime: (i + 1) * STEP - 1, open, high: open + 1.5, low: open - 0.5, close: open + 1, volume: 10, closed: i < 149 };
  });
  const out = analyzeBreakout(subida, { interval: '1h', livePrice: 248 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.up.fallback, true, 'en subida libre el techo es el máximo reciente');
  assert.match(out.explanation.join(' '), /máximo de las últimas 60 velas/);
});

test('la explicación dice el nivel, la distancia y de dónde sale el porcentaje', () => {
  const out = analyzeBreakout(oscillating(), { interval: '1h', livePrice: 108 });
  const texto = out.explanation.join(' ');
  assert.match(texto, /Para romper al alza/);
  assert.match(texto, /ATR/);
  assert.match(texto, /velas anteriores de 1h/);
  assert.match(texto, /Ésa es la probabilidad/);
});

test('el contexto trae señales etiquetadas y explicadas', () => {
  const out = analyzeBreakout(oscillating(), { interval: '1h' });
  const claves = out.context.map((f) => f.key);
  for (const esperada of ['compresion', 'posicion', 'tendencia', 'rsi', 'forma']) {
    assert.ok(claves.includes(esperada), `falta la señal ${esperada}`);
  }
  for (const f of out.context) {
    assert.ok(['alza', 'baja', 'neutral'].includes(f.lean));
    assert.ok(f.text.length > 20, 'cada señal se explica, no sólo se puntúa');
  }
});

test('el disparador exige cierre y no un simple toque', () => {
  const out = analyzeBreakout(oscillating(), { interval: '1h', livePrice: 109 });
  assert.match(out.trigger.up.text, /cierre de 1h por encima/);
  assert.match(out.trigger.up.text, /rechazo, no una ruptura/);
  assert.match(out.trigger.up.invalidation, /vuelve por debajo/);
});

test('la muestra viaja al cliente para poder recalcular en vivo', () => {
  const out = analyzeBreakout(oscillating(), { interval: '1h' });
  assert.ok(Array.isArray(out.sample.up) && out.sample.up.length > 100);
  assert.ok(out.sample.up.every((v) => Number.isFinite(v)));
  assert.ok(out.sample.remainingFraction > 0 && out.sample.remainingFraction <= 1);
});

test('el reloj de la vela sale de sus propias marcas de tiempo', () => {
  const candles = oscillating();
  const ultima = candles.at(-1);
  const out = analyzeBreakout(candles, { interval: '1h', now: ultima.openTime + STEP * 0.25 });
  assert.ok(Math.abs(out.candle.elapsed - 0.25) < 0.01);
  assert.ok(Math.abs(out.candle.remainingMs - STEP * 0.75) < 1000);
});

test('findLevels se queda con el nivel más cercano de cada lado', () => {
  const candles = oscillating();
  const { resistance, support } = findLevels(candles, 105, 0.5);
  assert.ok(resistance.price > 105 && resistance.price < 111);
  assert.ok(support.price < 105 && support.price > 99);
});
