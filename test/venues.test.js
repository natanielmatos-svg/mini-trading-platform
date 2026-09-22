'use strict';

// Los formatos de Kraken y Coinbase, contra servidores locales que los imitan.
//
// Mismo motivo que con Binance: son APIs públicas sin contrato de estabilidad
// y desde aquí no hay salida a Internet. Esto prueba que si responden lo que
// documentan, se entiende; y que sus errores —que en Kraken vienen con un 200
// y el fallo dentro del cuerpo— no se cuelan como precios.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const estado = { kraken: null, coinbase: null, binance: null, peticiones: [] };

function servidor(clave, porDefecto) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    estado.peticiones.push({ clave, path: url.pathname, params: Object.fromEntries(url.searchParams) });

    const respuesta = estado[clave] || porDefecto;
    const { status = 200, body } = typeof respuesta === 'function' ? respuesta(url) : respuesta;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

// Formas documentadas de cada casa.
const KRAKEN_OK = {
  body: {
    error: [],
    // La clave es el nombre interno del par, no lo que se pidió.
    result: { XXBTZUSD: { a: ['86650.1', '1', '1.000'], b: ['86649.9', '2', '2.000'], c: ['86650.0', '0.00512'], v: ['1234', '5678'] } },
  },
};
const COINBASE_OK = {
  body: {
    trades: [{ trade_id: '1', product_id: 'BTC-USD', price: '86644.32', size: '0.01', time: '2026-09-22T00:00:00Z', side: 'BUY' }],
    best_bid: '86644.00',
    best_ask: '86644.60',
  },
};
const BINANCE_OK = { body: { symbol: 'BTCUSDT', price: '86620.10000000' } };

let venues;
let consolidated;
const servidores = [];

test.before(async () => {
  const arrancar = async (clave, porDefecto) => {
    const s = servidor(clave, porDefecto);
    await new Promise((r) => s.listen(0, r));
    servidores.push(s);
    return `http://127.0.0.1:${s.address().port}`;
  };

  process.env.KRAKEN_API = await arrancar('kraken', KRAKEN_OK);
  process.env.COINBASE_API = await arrancar('coinbase', COINBASE_OK);
  process.env.BINANCE_API = await arrancar('binance', BINANCE_OK);

  venues = require('../src/venues');
  consolidated = require('../src/consolidated');
});

test.after(() => {
  for (const s of servidores) {
    s.closeAllConnections?.();
    s.close();
  }
});

test.beforeEach(() => {
  estado.kraken = null;
  estado.coinbase = null;
  estado.binance = null;
  estado.peticiones = [];
});

// --- Mapeo de pares --------------------------------------------------------

test('cada casa recibe el par en su propia notación', () => {
  assert.strictEqual(venues.binance.pairFor('BTCUSDT'), 'BTCUSDT');
  assert.strictEqual(venues.kraken.pairFor('BTCUSDT'), 'BTCUSD');
  assert.strictEqual(venues.coinbase.pairFor('BTCUSDT'), 'BTC-USD');
  assert.strictEqual(venues.coinbase.pairFor('ETHUSDT'), 'ETH-USD');
});

// --- Kraken ----------------------------------------------------------------

test('Kraken: el precio sale de `c`, aunque la clave del par sea la interna', async () => {
  const { price, pair } = await venues.kraken.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86650);
  assert.strictEqual(pair, 'BTCUSD');
  assert.strictEqual(estado.peticiones[0].path, '/0/public/Ticker');
  assert.strictEqual(estado.peticiones[0].params.pair, 'BTCUSD');
});

test('Kraken: un error suyo viene con un 200 y el fallo dentro; no puede colarse', async () => {
  estado.kraken = { status: 200, body: { error: ['EQuery:Unknown asset pair'], result: {} } };
  await assert.rejects(() => venues.kraken.fetchPrice({ symbol: 'NOEXISTE' }), /Unknown asset pair/);
});

test('Kraken: sin último operado se usa el punto medio del libro', async () => {
  estado.kraken = { status: 200, body: { error: [], result: { XXBTZUSD: { a: ['86651'], b: ['86649'] } } } };
  const { price } = await venues.kraken.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86650);
});

// --- Coinbase --------------------------------------------------------------

test('Coinbase: el precio sale de la última operación', async () => {
  const { price, pair } = await venues.coinbase.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86644.32);
  assert.strictEqual(pair, 'BTC-USD');
  assert.match(estado.peticiones[0].path, /\/api\/v3\/brokerage\/market\/products\/BTC-USD\/ticker$/);
});

test('Coinbase: sin operaciones se usa el punto medio del libro', async () => {
  estado.coinbase = { status: 200, body: { trades: [], best_bid: '86644.00', best_ask: '86644.60' } };
  const { price } = await venues.coinbase.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86644.3);
});

test('Coinbase: un 404 se propaga como error, no como precio cero', async () => {
  estado.coinbase = { status: 404, body: { error: 'NOT_FOUND', message: 'product not found' } };
  await assert.rejects(() => venues.coinbase.fetchPrice({ symbol: 'NOEXISTE' }), /HTTP 404/);
});

// --- Los tres juntos -------------------------------------------------------

test('se pregunta a las tres casas y se consolida', async () => {
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', now: 1_000 });
  assert.strictEqual(quotes.length, 3);
  assert.ok(quotes.every((q) => q.ok && q.price > 0));

  const out = consolidated.consolidate(quotes, { now: 1_000 });
  assert.strictEqual(out.used, 3);
  assert.strictEqual(out.price, 86644.32, 'la mediana de 86620,10 / 86644,32 / 86650');
  assert.ok(out.spread > 0 && out.spreadPct < 0.1);
});

test('una casa caída no deja sin precio a las otras dos', async () => {
  estado.kraken = { status: 503, body: { error: ['EService:Unavailable'] } };

  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', now: 1_000 });
  const caida = quotes.find((q) => q.id === 'kraken');

  assert.strictEqual(caida.ok, false);
  assert.match(caida.error, /HTTP 503/);
  assert.strictEqual(caida.pair, 'BTCUSD', 'se dice qué par se intentó');

  const out = consolidated.consolidate(quotes, { now: 1_000 });
  assert.strictEqual(out.used, 2);
  assert.ok(out.price > 0);
});

test('una respuesta sin precio utilizable cuenta como caída, no como cero', async () => {
  estado.binance = { status: 200, body: { symbol: 'BTCUSDT', price: 'no-es-un-numero' } };
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', now: 1_000 });
  const rota = quotes.find((q) => q.id === 'binance');
  assert.strictEqual(rota.ok, false);
  assert.match(rota.error, /sin precio utilizable/);
});

test('en demo no se llama a ninguna casa y las tres difieren un poco', async () => {
  estado.peticiones = [];
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', demo: true, now: Date.now() });

  assert.strictEqual(estado.peticiones.length, 0, 'demo no sale a Internet');
  assert.strictEqual(quotes.length, 3);
  assert.ok(quotes.every((q) => q.price > 0 && q.demo));

  const out = consolidated.consolidate(quotes);
  assert.ok(out.spreadPct > 0, 'tienen que diferir: si no, el panel no enseñaría nada');
  assert.ok(out.spreadPct < 0.2, `diferencia irreal: ${out.spreadPct}%`);
});
