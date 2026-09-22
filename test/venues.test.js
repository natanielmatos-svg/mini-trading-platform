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

const estado = { kraken: null, coinbase: null, binance: null, gemini: null, peticiones: [] };

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
const BINANCE_OK = {
  body: { symbol: 'BTCUSDT', bidPrice: '86620.00000000', bidQty: '1.5', askPrice: '86620.20000000', askQty: '0.9' },
};
const GEMINI_OK = {
  body: { bid: '86647.00', ask: '86647.40', last: '86640.00', volume: { BTC: '1200', USD: '104000000', timestamp: 1790000000000 } },
};

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
  process.env.GEMINI_API = await arrancar('gemini', GEMINI_OK);

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
  estado.gemini = null;
  estado.peticiones = [];
});

// --- Mapeo de pares --------------------------------------------------------

test('cada casa recibe el par en su propia notación', () => {
  assert.strictEqual(venues.binance.pairFor('BTCUSDT'), 'BTCUSDT');
  assert.strictEqual(venues.kraken.pairFor('BTCUSDT'), 'BTCUSD');
  assert.strictEqual(venues.coinbase.pairFor('BTCUSDT'), 'BTC-USD');
  assert.strictEqual(venues.coinbase.pairFor('ETHUSDT'), 'ETH-USD');
  assert.strictEqual(venues.gemini.pairFor('BTCUSDT'), 'btcusd', 'Gemini los nombra en minúsculas y sin separador');
  assert.strictEqual(venues.gemini.pairFor('ETHUSDT'), 'ethusd');
});

// --- Kraken ----------------------------------------------------------------

test('Kraken: el precio sale del libro, aunque la clave del par sea la interna', async () => {
  const { price, pair, source } = await venues.kraken.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86650, 'punto medio de 86649,9 y 86650,1');
  assert.strictEqual(source, 'libro');
  assert.strictEqual(pair, 'BTCUSD');
  assert.strictEqual(estado.peticiones[0].path, '/0/public/Ticker');
  assert.strictEqual(estado.peticiones[0].params.pair, 'BTCUSD');
});

test('Kraken: un error suyo viene con un 200 y el fallo dentro; no puede colarse', async () => {
  estado.kraken = { status: 200, body: { error: ['EQuery:Unknown asset pair'], result: {} } };
  await assert.rejects(() => venues.kraken.fetchPrice({ symbol: 'NOEXISTE' }), /Unknown asset pair/);
});

test('Kraken: sin libro se cae a la última operación y se dice', async () => {
  estado.kraken = { status: 200, body: { error: [], result: { XXBTZUSD: { c: ['86500', '0.1'] } } } };
  const { price, source } = await venues.kraken.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86500);
  assert.strictEqual(source, 'última operación');
});

// --- Coinbase --------------------------------------------------------------

test('Coinbase: manda el libro sobre la última operación', async () => {
  // La respuesta trae las dos cosas: 86644,32 operado y 86644,00/86644,60 en
  // el libro. Gana el libro, porque la operación puede ser de hace minutos.
  const { price, pair, source } = await venues.coinbase.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86644.3);
  assert.strictEqual(source, 'libro');
  assert.strictEqual(pair, 'BTC-USD');
  assert.match(estado.peticiones[0].path, /\/api\/v3\/brokerage\/market\/products\/BTC-USD\/ticker$/);
});

test('Coinbase: sin libro se cae a la última operación', async () => {
  estado.coinbase = { status: 200, body: { trades: [{ price: '86644.32' }] } };
  const { price, source } = await venues.coinbase.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86644.32);
  assert.strictEqual(source, 'última operación');
});

test('un libro cruzado no se usa: algo va mal en esa respuesta', () => {
  const { price, source } = venues.midOrLast({ bid: '86651', ask: '86649', last: '86500' });
  assert.strictEqual(price, 86500, 'con la venta por debajo de la compra, mejor la operación');
  assert.strictEqual(source, 'última operación');
});

test('Binance: se pregunta al libro, no al último precio', async () => {
  const { price, source } = await venues.binance.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86620.1);
  assert.strictEqual(source, 'libro');
  assert.strictEqual(estado.peticiones[0].path, '/api/v3/ticker/bookTicker');
});

test('Coinbase: un 404 se propaga como error, no como precio cero', async () => {
  estado.coinbase = { status: 404, body: { error: 'NOT_FOUND', message: 'product not found' } };
  await assert.rejects(() => venues.coinbase.fetchPrice({ symbol: 'NOEXISTE' }), /HTTP 404/);
});

// --- Gemini ----------------------------------------------------------------

test('Gemini: el precio sale del libro de su pubticker', async () => {
  const { price, pair, source } = await venues.gemini.fetchPrice({ symbol: 'BTCUSDT' });
  assert.strictEqual(price, 86647.2, 'punto medio de 86647,00 y 86647,40');
  assert.strictEqual(source, 'libro');
  assert.strictEqual(pair, 'btcusd');
  assert.strictEqual(estado.peticiones[0].path, '/v1/pubticker/btcusd');
});

test('Gemini: un par que no existe se propaga como error', async () => {
  estado.gemini = { status: 400, body: { result: 'error', reason: 'InvalidSymbol', message: 'Invalid symbol' } };
  await assert.rejects(() => venues.gemini.fetchPrice({ symbol: 'NOEXISTE' }), /HTTP 400/);
});

test('Gemini: un error con 200 tampoco se cuela como precio', async () => {
  estado.gemini = { status: 200, body: { result: 'error', reason: 'RateLimit', message: 'slow down' } };
  await assert.rejects(() => venues.gemini.fetchPrice({ symbol: 'BTCUSDT' }), /RateLimit/);
});

// --- Las cuatro juntas -----------------------------------------------------

test('se pregunta a las cuatro casas y se consolida', async () => {
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', now: 1_000 });
  assert.strictEqual(quotes.length, 4);
  assert.ok(quotes.every((q) => q.ok && q.price > 0));

  const out = consolidated.consolidate(quotes, { now: 1_000 });
  assert.strictEqual(out.used, 4);
  // 86620,10 / 86644,30 / 86647,20 / 86650 -> media de los dos de en medio
  assert.strictEqual(out.price, 86645.75);
  assert.ok(out.spread > 0 && out.spreadPct < 0.1);
});

// --- Elegir mercados -------------------------------------------------------

test('se puede pedir sólo algunos mercados', async () => {
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', venues: ['kraken', 'gemini'], now: 1_000 });

  assert.deepStrictEqual(quotes.map((q) => q.id).sort(), ['gemini', 'kraken']);
  assert.ok(!estado.peticiones.some((p) => p.clave === 'binance'), 'no se molesta a los que no se piden');
  assert.ok(!estado.peticiones.some((p) => p.clave === 'coinbase'));

  const out = consolidated.consolidate(quotes, { now: 1_000 });
  assert.strictEqual(out.used, 2);
  assert.strictEqual(out.method, 'media de dos');
});

test('un solo mercado elegido se consolida consigo mismo y lo dice', async () => {
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', venues: ['gemini'], now: 1_000 });
  const out = consolidated.consolidate(quotes, { now: 1_000 });

  assert.strictEqual(out.used, 1);
  assert.strictEqual(out.price, 86647.2);
  assert.strictEqual(out.method, 'único mercado');
});

test('la lista de mercados pedida se sanea', () => {
  assert.deepStrictEqual(venues.parseVenues('kraken,GEMINI'), ['kraken', 'gemini']);
  assert.deepStrictEqual(venues.parseVenues(' coinbase , coinbase '), ['coinbase'], 'sin repetidos');
  assert.strictEqual(venues.parseVenues('inventado'), null, 'mejor todos que ninguno');
  assert.strictEqual(venues.parseVenues(''), null);
  assert.strictEqual(venues.parseVenues(undefined), null);
});

test('en demo también se respeta la elección', async () => {
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', demo: true, venues: ['binance', 'gemini'] });
  assert.deepStrictEqual(quotes.map((q) => q.id), ['binance', 'gemini']);
});

test('una casa caída no deja sin precio a las demás', async () => {
  estado.kraken = { status: 503, body: { error: ['EService:Unavailable'] } };

  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', now: 1_000 });
  const caida = quotes.find((q) => q.id === 'kraken');

  assert.strictEqual(caida.ok, false);
  assert.match(caida.error, /HTTP 503/);
  assert.strictEqual(caida.pair, 'BTCUSD', 'se dice qué par se intentó');

  const out = consolidated.consolidate(quotes, { now: 1_000 });
  assert.strictEqual(out.used, 3, 'siguen las otras tres');
  assert.ok(out.price > 0);
});

test('una respuesta sin precio utilizable cuenta como caída, no como cero', async () => {
  estado.binance = { status: 200, body: { symbol: 'BTCUSDT', bidPrice: 'no-es-un-numero', askPrice: '' } };
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', now: 1_000 });
  const rota = quotes.find((q) => q.id === 'binance');
  assert.strictEqual(rota.ok, false);
  assert.match(rota.error, /sin precio utilizable/);
});

test('en demo no se llama a ninguna casa y difieren un poco entre ellas', async () => {
  estado.peticiones = [];
  const quotes = await venues.fetchAllPrices({ symbol: 'BTCUSDT', demo: true, now: Date.now() });

  assert.strictEqual(estado.peticiones.length, 0, 'demo no sale a Internet');
  assert.strictEqual(quotes.length, 4);
  assert.ok(quotes.every((q) => q.price > 0 && q.demo && q.source === 'libro'));

  const out = consolidated.consolidate(quotes);
  assert.ok(out.spreadPct > 0, 'tienen que diferir: si no, el panel no enseñaría nada');
  assert.ok(out.spreadPct < 0.2, `diferencia irreal: ${out.spreadPct}%`);
});
