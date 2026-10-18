'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const neural = require('../src/forecast-neural');

const step = 900000;
const start = 1700000000000;
function fixture() {
  const candles = Array.from({ length: 125 }, (_, i) => ({
    openTime: start + i * step, closeTime: start + (i + 1) * step - 1,
    close: 100 + i, closed: i < 124,
  }));
  return { symbol: 'BTCUSDT', interval: '15m', source: 'consolidado', candles };
}
const now = start + 124 * step + step / 2;
function result() {
  return { estimatedClose: 225, quantiles: [215, 218, 220, 222, 225, 228, 230, 232, 235],
    validation: { samples: 24, mae: 1, baselineMae: 2, directionAccuracy: .9, coverage80: .8 } };
}

test('neural identifies exact candle target and keeps intrablock baseline separate from forecast', async () => {
  neural.cache.clear();
  const data = fixture();
  data.fetchedAt = now - 1000;
  data.candles.at(-1).close = 400;
  let inputs;
  const prediction = await neural.forecast(data, { now, predict: async values => { inputs = values; return result(); } });
  assert.equal(prediction.ok, true);
  assert.equal(inputs.length, 124);
  assert.equal(inputs.at(-1), 223);
  assert.equal(prediction.anchorAt, start + 124 * step);
  assert.equal(prediction.target.closesAt, start + 125 * step);
  assert.equal(prediction.target.unit, 'USD');
  assert.equal(prediction.target.source, 'consolidado');
  assert.equal(prediction.target.settlementEquivalent, false);
  assert.equal(prediction.horizon.stepMs, step);
  assert.equal(prediction.horizon.steps, 1);
  assert.ok(prediction.horizon.remainingMs <= step / 2 && prediction.horizon.remainingMs > 0);
  assert.equal(prediction.baseline.price, 400);
  assert.equal(prediction.baseline.observedAt, null);
  assert.equal(prediction.baseline.snapshotAt, now - 1000);
  assert.equal(prediction.estimatedClose, 225);
  assert.equal(prediction.rawEstimatedClose, 225);
  assert.equal(prediction.intrablockConditioned, false);
  assert.equal(prediction.historicalCheckPassed, false);
  assert.equal(prediction.validationStatus.status, 'insufficient-sample');
  assert.equal(prediction.validationStatus.requiredSamples, 100);
});

test('intrabar price changes update baseline without fabricating a new neural forecast or observation timestamp', async () => {
  neural.cache.clear();
  const data = fixture();
  let calls = 0;
  const predict = async () => { calls++; return result(); };
  const first = await neural.forecast(data, { now, predict });
  data.candles.at(-1).close = 500;
  data.candles.at(-1).observedAt = now + 1;
  const second = await neural.forecast(data, { now, predict });
  assert.equal(calls, 1);
  assert.equal(first.estimatedClose, second.estimatedClose);
  assert.deepEqual(first.quantiles, second.quantiles);
  assert.notEqual(first.baseline.price, second.baseline.price);
  assert.equal(second.baseline.observedAt, null);
  data.candles.at(-1).observedAt = now - 500;
  const third = await neural.forecast(data, { now, predict });
  assert.equal(third.baseline.observedAt, now - 500);
});

test('fallback USDT is not mislabeled USD and unknown quote timestamps remain unknown', async () => {
  neural.cache.clear();
  const data = fixture(); data.source = 'binance';
  const prediction = await neural.forecast(data, { now, predict: async () => result() });
  assert.equal(prediction.referenceUnit, 'USDT');
  assert.equal(prediction.target.unit, 'USDT');
  assert.equal(prediction.baseline.unit, 'USDT');
  assert.equal(prediction.baseline.snapshotAt, null);
  assert.equal(prediction.baseline.observedAt, null);
});

test('neural abstains on history gaps, expired candle and unverified stock session', () => {
  const data = fixture();
  data.candles[80].openTime += 1;
  assert.equal(neural.prepare(data.candles, { now }).ok, false);
  assert.equal(neural.prepare(fixture().candles, { now: start + 126 * step }).ok, false);
  assert.equal(neural.prepare(fixture().candles, { now, market: 'stocks' }).ok, false);
});
