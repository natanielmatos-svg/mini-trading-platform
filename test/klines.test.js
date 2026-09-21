'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseSymbol, parseInterval, parseLimit, buildDemoCandles, intervalMs, ttlFor, FETCH_LIMIT } = require('../src/klines');
const { TtlCache } = require('../src/cache');

test('el símbolo se sanea a mayúsculas alfanuméricas', () => {
  assert.strictEqual(parseSymbol('btcusdt'), 'BTCUSDT');
  assert.strictEqual(parseSymbol('BTC-USDT'), 'BTCUSDT');
  assert.strictEqual(parseSymbol('../../etc/passwd'), 'ETCPASSWD');
  assert.strictEqual(parseSymbol(''), 'BTCUSDT');
  assert.strictEqual(parseSymbol('A'.repeat(50)).length, 20);
});

test('el timeframe sale de una lista blanca', () => {
  assert.strictEqual(parseInterval('4h'), '4h');
  assert.strictEqual(parseInterval('7h'), '1h');
  assert.strictEqual(parseInterval(undefined), '1h');
});

test('el limit del cliente no puede superar lo que se pide a Binance', () => {
  assert.strictEqual(parseLimit('50'), 50);
  assert.strictEqual(parseLimit('99999'), FETCH_LIMIT);
  assert.strictEqual(parseLimit('-3'), 300);
  assert.strictEqual(parseLimit('hola'), 300);
});

test('la caché se ajusta al timeframe pero nunca pasa de un minuto', () => {
  assert.ok(ttlFor('1m') >= 5000);
  assert.ok(ttlFor('1d') <= 60000);
  assert.ok(ttlFor('1h') >= ttlFor('5m'));
});

test('las velas demo son deterministas para el mismo instante', () => {
  const now = 1_700_000_000_000;
  const a = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 50, now });
  const b = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 50, now });
  assert.deepStrictEqual(a, b);
});

test('el histórico demo no se reescribe al avanzar el reloj', () => {
  const now = 1_700_000_000_000;
  const antes = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 50, now });
  const despues = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 50, now: now + 20 * 60_000 });
  // La vela en curso cambia; las cerradas tienen que seguir siendo las mismas.
  assert.deepStrictEqual(antes.slice(0, -1), despues.slice(0, -1));
  assert.notDeepStrictEqual(antes.at(-1), despues.at(-1));
});

test('el cierre de cada vela demo es la apertura de la siguiente', () => {
  const candles = buildDemoCandles({ symbol: 'ETHUSDT', interval: '15m', limit: 30, now: 1_700_000_000_000 });
  for (let i = 1; i < candles.length; i++) {
    assert.ok(Math.abs(candles[i - 1].close - candles[i].open) < 1e-6, `salto en la vela ${i}`);
  }
});

test('las velas demo son coherentes: máximo arriba, mínimo abajo, sólo la última abierta', () => {
  const candles = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 40, now: Date.now() });
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close), 'el máximo contiene el cuerpo');
    assert.ok(c.low <= Math.min(c.open, c.close), 'el mínimo contiene el cuerpo');
    assert.ok(c.volume >= 0);
    assert.strictEqual(c.closeTime - c.openTime + 1, intervalMs('1h'));
  }
  assert.ok(candles.slice(0, -1).every((c) => c.closed));
  assert.strictEqual(candles.at(-1).closed, false);
});

test('los timeframes demo coinciden en precio a la misma hora', () => {
  const now = 1_700_000_000_000;
  const unaHora = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 2, now }).at(-1);
  const unMinuto = buildDemoCandles({ symbol: 'BTCUSDT', interval: '1m', limit: 2, now }).at(-1);
  const diferencia = Math.abs(unaHora.close - unMinuto.close) / unaHora.close;
  assert.ok(diferencia < 0.02, `1h y 1m difieren un ${(diferencia * 100).toFixed(2)}%`);
});

test('una vela de un día se mueve más que una de un minuto', () => {
  const now = 1_700_000_000_000;
  const cuerpo = (interval) => {
    const c = buildDemoCandles({ symbol: 'BTCUSDT', interval, limit: 60, now }).slice(0, -1);
    return c.reduce((acc, k) => acc + Math.abs(k.close - k.open) / k.open, 0) / c.length;
  };
  assert.ok(cuerpo('1d') > cuerpo('1h'));
  assert.ok(cuerpo('1h') > cuerpo('1m'));
});

test('la caché agrupa las peticiones simultáneas en una sola llamada', async () => {
  const cache = new TtlCache({ ttlMs: 1000 });
  let llamadas = 0;
  const producer = async () => {
    llamadas++;
    await new Promise((r) => setTimeout(r, 10));
    return 'velas';
  };
  const resultados = await Promise.all([1, 2, 3, 4, 5].map(() => cache.wrap('k', producer)));
  assert.deepStrictEqual(resultados, ['velas', 'velas', 'velas', 'velas', 'velas']);
  assert.strictEqual(llamadas, 1);
});

test('con serveStaleOnError un fallo devuelve el valor viejo en vez de romper', async () => {
  const cache = new TtlCache({ ttlMs: 10 });
  await cache.wrap('k', async () => 'precio bueno');
  await new Promise((r) => setTimeout(r, 25));

  const conStale = await cache.wrap('k', async () => { throw new Error('Binance caído'); }, 10, { serveStaleOnError: true });
  assert.strictEqual(conStale, 'precio bueno');

  await assert.rejects(
    () => cache.wrap('k', async () => { throw new Error('Binance caído'); }),
    /Binance caído/,
    'sin la opción, el error se propaga'
  );
});

test('la caché no crece sin límite', () => {
  const cache = new TtlCache({ ttlMs: 1000, maxEntries: 3 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) cache.set(key, key);
  assert.strictEqual(cache.entries.size, 3);
  assert.strictEqual(cache.get('a'), undefined, 'se desalojan las más antiguas');
  assert.strictEqual(cache.get('e'), 'e');
});
