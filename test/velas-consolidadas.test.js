'use strict';

// Velas consolidadas: los adaptadores de cada mercado y su mediana.
//
// Mismo motivo que con los precios al contado: desde aquí no hay salida a
// Internet y son APIs públicas sin contrato de estabilidad. Se levantan
// servidores locales que hablan el formato que documenta cada una —incluidas
// sus rarezas: Kraken manda los errores dentro de un 200 y devuelve el par con
// su nombre interno, Coinbase y Gemini ordenan de la más nueva a la más
// vieja— y se comprueba que si responden lo documentado, se entiende.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const HORA = 3_600_000;
const T0 = Date.UTC(2026, 8, 22, 0, 0, 0);

// Una serie de velas horarias con un precio base, para que cada mercado
// devuelva lo mismo desplazado un poco, como pasa de verdad.
function serie(n, base, desvio = 0) {
  return Array.from({ length: n }, (_, i) => {
    const p = (base + i * 10) * (1 + desvio);
    return { t: T0 + i * HORA, o: p, h: p * 1.003, l: p * 0.997, c: p * 1.001, v: 100 + i };
  });
}

const estado = { binance: null, kraken: null, coinbase: null, gemini: null, peticiones: [] };

function servidor(clave, responder) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    estado.peticiones.push({ clave, path: url.pathname, params: Object.fromEntries(url.searchParams) });
    const r = estado[clave] || responder(url);
    res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
}

let velas;
let consolidadas;
const servidores = {};

test.before(async () => {
  // Cada mercado con su desvío, como en la realidad.
  const b = serie(60, 80_000, -0.0002); // en USDT
  const k = serie(60, 80_000, 0.0001);
  const c = serie(60, 80_000, 0.00005);
  const g = serie(60, 80_000, 0.0003);

  servidores.binance = servidor('binance', () => ({
    body: b.map((x) => [x.t, String(x.o), String(x.h), String(x.l), String(x.c), String(x.v), x.t + HORA - 1]),
  }));

  servidores.kraken = servidor('kraken', (url) => {
    // El cambio USDT/USD se pide al mismo servidor.
    if (url.searchParams.get('pair') === 'USDTZUSD') {
      return { body: { error: [], result: { USDTZUSD: { b: ['1.0002'], a: ['1.0004'] } } } };
    }
    // La clave del resultado es el nombre INTERNO del par, no el que se pidió.
    return { body: { error: [], result: { XXBTZUSD: k.map((x) => [x.t / 1000, String(x.o), String(x.h), String(x.l), String(x.c), '0', String(x.v), 10]), last: 0 } } };
  });

  servidores.coinbase = servidor('coinbase', () => ({
    // De la más nueva a la más vieja, y el tiempo en segundos como texto.
    body: { candles: [...c].reverse().map((x) => ({ start: String(x.t / 1000), open: String(x.o), high: String(x.h), low: String(x.l), close: String(x.c), volume: String(x.v) })) },
  }));

  servidores.gemini = servidor('gemini', () => ({
    body: [...g].reverse().map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]),
  }));

  for (const s of Object.values(servidores)) await new Promise((r) => s.listen(0, r));

  process.env.BINANCE_API = `http://127.0.0.1:${servidores.binance.address().port}`;
  process.env.KRAKEN_API = `http://127.0.0.1:${servidores.kraken.address().port}`;
  process.env.COINBASE_API = `http://127.0.0.1:${servidores.coinbase.address().port}`;
  process.env.GEMINI_API = `http://127.0.0.1:${servidores.gemini.address().port}`;

  velas = require('../src/velas-mercados');
  consolidadas = require('../src/velas-consolidadas');
});

test.after(() => {
  for (const s of Object.values(servidores)) {
    s.closeAllConnections?.();
    s.close();
  }
});

test.beforeEach(() => {
  for (const k of ['binance', 'kraken', 'coinbase', 'gemini']) estado[k] = null;
  estado.peticiones = [];
  consolidadas._cacheCambio.clear();
});

// --- Adaptadores -----------------------------------------------------------

test('cada mercado devuelve sus velas en la forma que usa la aplicación', async () => {
  const pares = { binance: 'BTCUSDT', kraken: 'BTCUSD', coinbase: 'BTC-USD', gemini: 'btcusd' };

  for (const [id, pair] of Object.entries(pares)) {
    const r = await velas.fetchVelas({ venueId: id, pair, interval: '1h', limit: 50, now: T0 + 60 * HORA });
    assert.equal(r.ok, true, `${id}: ${r.error}`);
    assert.equal(r.candles.length, 50, `${id}: se recorta a lo pedido`);

    for (const c of r.candles) {
      assert.ok(velas.usable(c), `${id}: vela incoherente`);
      assert.equal(c.closeTime, c.openTime + HORA - 1, `${id}: cierre mal calculado`);
    }
    // Y en orden, que Coinbase y Gemini las mandan al revés.
    for (let i = 1; i < r.candles.length; i++) {
      assert.ok(r.candles[i].openTime > r.candles[i - 1].openTime, `${id}: desordenadas`);
    }
  }
});

test('un mercado que no publica ese intervalo lo dice, no falla en silencio', async () => {
  // 12h no lo tienen ni Kraken ni Coinbase ni Gemini.
  for (const id of ['kraken', 'coinbase', 'gemini']) {
    assert.equal(velas.soporta(id, '12h'), false, `${id} no debería soportar 12h`);
    const r = await velas.fetchVelas({ venueId: id, pair: 'X', interval: '12h' });
    assert.equal(r.ok, false);
    assert.match(r.error, /no publica velas de 12h/);
  }
  assert.equal(velas.soporta('binance', '12h'), true, 'Binance sí');
});

test('un error de Kraken dentro de un 200 no se cuela como velas', async () => {
  estado.kraken = { body: { error: ['EQuery:Unknown asset pair'], result: {} } };
  const r = await velas.fetchVelas({ venueId: 'kraken', pair: 'XXX', interval: '1h' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown asset pair/);
  assert.deepEqual(r.candles, []);
});

test('una vela corrupta se descarta y el resto sirve', async () => {
  estado.binance = {
    body: [
      [T0, '100', '101', '99', '100.5', '10', T0 + HORA - 1],
      [T0 + HORA, '100', '90', '99', '100.5', '10', 0],        // máximo por debajo del mínimo
      [T0 + 2 * HORA, '100', 'x', '99', '100.5', '10', 0],     // no numérico
      [T0 + 3 * HORA, '101', '102', '100', '101.5', '10', 0],
    ],
  };
  const r = await velas.fetchVelas({ venueId: 'binance', pair: 'BTCUSDT', interval: '1h', now: T0 + 10 * HORA });
  assert.equal(r.ok, true);
  assert.equal(r.candles.length, 2, 'sólo las dos buenas');
});

test('un mercado caído no lanza: devuelve el motivo', async () => {
  estado.gemini = { status: 500, body: { message: 'boom' } };
  const r = await velas.fetchVelas({ venueId: 'gemini', pair: 'btcusd', interval: '1h' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.deepEqual(r.candles, []);
});

// --- Consolidación ---------------------------------------------------------

test('la mediana se toma vela a vela y se dice con cuántos mercados', async () => {
  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 50, now: T0 + 60 * HORA });

  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.usados, 4, 'los cuatro respondieron');
  assert.equal(r.candles.length, 50);

  for (const c of r.candles) {
    assert.equal(c.mercados, 4);
    assert.ok(c.high >= c.low);
    assert.ok(c.high >= Math.max(c.open, c.close));
    assert.ok(c.low <= Math.min(c.open, c.close));
  }

  // El volumen se suma entre casas.
  assert.ok(r.candles[0].volume > 100, 'el volumen suma el de cada mercado');
});

test('las velas de Binance se convierten de USDT a dólares', async () => {
  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 10, now: T0 + 60 * HORA });
  const binance = r.venues.find((v) => v.id === 'binance');

  assert.equal(binance.usado, true);
  assert.equal(binance.convertido, true, 'se marca que hubo conversión');
  assert.ok(r.stable && r.stable.rate > 0.99 && r.stable.rate < 1.01);
});

test('sin cambio USDT/USD, Binance queda fuera en vez de mezclar unidades', async () => {
  // El cambio se pide a Kraken y a Coinbase; si los dos fallan en ese par
  // concreto, no hay conversión posible.
  estado.kraken = { body: { error: ['EService:Unavailable'], result: {} } };
  estado.coinbase = { status: 500, body: {} };
  consolidadas._cacheCambio.clear();

  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 10, now: T0 + 60 * HORA });
  const binance = r.venues.find((v) => v.id === 'binance');

  assert.equal(binance.usado, false);
  assert.match(binance.motivo, /sin cambio USDT\/USD/);
});

test('el cambio USDT/USD se cachea: no se pide una vez por vela', async () => {
  await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 10, now: T0 + 60 * HORA });
  const primera = estado.peticiones.filter((p) => p.params.pair === 'USDTZUSD').length;

  estado.peticiones = [];
  await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 10, now: T0 + 60 * HORA });
  const segunda = estado.peticiones.filter((p) => p.params.pair === 'USDTZUSD').length;

  assert.equal(primera, 1);
  assert.equal(segunda, 0, 'la segunda vez sale de la caché');
});

test('con un solo mercado no hay consolidado: eso no es una mediana', async () => {
  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', venues: ['gemini'], limit: 10, now: T0 + 60 * HORA });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /al menos 2 mercados/);
  assert.deepEqual(r.candles, []);
});

test('un intervalo que sólo tiene Binance tampoco se consolida', async () => {
  // 12h: los otros tres no lo publican, así que queda uno solo.
  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '12h', limit: 10, now: T0 + 60 * HORA });
  assert.equal(r.ok, false);
  for (const id of ['kraken', 'coinbase', 'gemini']) {
    assert.match(r.venues.find((v) => v.id === id).motivo, /no publica velas de 12h/);
  }
});

test('una casa caída no impide consolidar con las demás', async () => {
  estado.gemini = { status: 503, body: {} };
  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 10, now: T0 + 60 * HORA });

  assert.equal(r.ok, true);
  assert.equal(r.usados, 3);
  assert.equal(r.venues.find((v) => v.id === 'gemini').usado, false);
  for (const c of r.candles) assert.equal(c.mercados, 3);
});

test('CF Benchmarks no entra: es un índice y no publica velas', async () => {
  const r = await consolidadas.getVelasConsolidadas({
    symbol: 'BTCUSDT', interval: '1h', venues: ['binance', 'kraken', 'cfbenchmarks'], limit: 10, now: T0 + 60 * HORA,
  });
  assert.equal(r.venues.some((v) => v.id === 'cfbenchmarks'), false);
  assert.equal(r.ok, true);
});

test('la mediana consolidada cae entre los mercados, no fuera', async () => {
  const r = await consolidadas.getVelasConsolidadas({ symbol: 'BTCUSDT', interval: '1h', limit: 5, now: T0 + 60 * HORA });
  const sueltas = await Promise.all(
    [['binance', 'BTCUSDT'], ['kraken', 'BTCUSD'], ['coinbase', 'BTC-USD'], ['gemini', 'btcusd']]
      .map(([id, pair]) => velas.fetchVelas({ venueId: id, pair, interval: '1h', limit: 5, now: T0 + 60 * HORA }))
  );

  for (const c of r.candles) {
    const cierres = sueltas
      .map((s) => s.candles.find((x) => x.openTime === c.openTime))
      .filter(Boolean)
      .map((x) => x.close);
    // Binance va en USDT y el consolidado en dólares, así que se compara con
    // holgura: lo que se comprueba es que no se va por ningún lado.
    assert.ok(c.close >= Math.min(...cierres) * 0.99, 'por debajo de todos');
    assert.ok(c.close <= Math.max(...cierres) * 1.01, 'por encima de todos');
  }
});
