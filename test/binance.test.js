'use strict';

// El protocolo de Binance, contra un servidor local que lo imita.
//
// Por qué existe este archivo: hasta ahora todo se probaba en modo demo, que
// se salta justo la parte que puede romperse sola —el formato que devuelve
// Binance— y que además es la que no controlamos. Aquí se ejercita el camino
// real: fetchJson con sus timeouts y reintentos, el parseo del array
// posicional, la caché, y el análisis encima.
//
// Lo que ESTO prueba: que si Binance responde lo que su documentación dice,
// la aplicación lo entiende y no se rompe con sus errores.
// Lo que NO prueba: que Binance siga respondiendo eso. Para eso está
// `npm run smoke`, que llama a la API de verdad.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// --- Servidor que habla como Binance ---------------------------------------

const estado = {
  peticiones: [],
  responder: null, // (req, res, url) => bool  si devuelve true, ya respondió
};

// Formato documentado: doce campos por vela, los precios como texto.
function klineRow(t, { open, high, low, close, volume, trades = 100 }) {
  const step = 3_600_000;
  return [
    t,
    open.toFixed(8),
    high.toFixed(8),
    low.toFixed(8),
    close.toFixed(8),
    volume.toFixed(8),
    t + step - 1,
    (volume * close).toFixed(8),
    trades,
    (volume * 0.55).toFixed(8),
    (volume * close * 0.55).toFixed(8),
    '0', // campo sin uso que Binance manda igualmente
  ];
}

// Serie con forma de mercado: rango con pivotes claros y una ruptura al final.
function serieBinance({ velas = 300, hasta = Date.now(), romper = false } = {}) {
  const step = 3_600_000;
  const primera = Math.floor(hasta / step) * step - (velas - 1) * step;
  const nivel = (i) => 100 + 10 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i % 20)) / 20));

  const filas = [];
  for (let i = 0; i < velas; i++) {
    const t = primera + i * step;
    const open = nivel(i);
    const close = nivel(i + 1);
    const ultima = i === velas - 1;
    const cresta = i % 20 === 10;

    if (ultima && romper) {
      filas.push(klineRow(t, { open: 110, high: 115.4, low: 109.7, close: 115.2, volume: 900 }));
      continue;
    }
    filas.push(
      klineRow(t, {
        open,
        high: Math.max(open, close) + (cresta ? 0.6 : 0.1),
        low: Math.min(open, close) - (i % 20 === 0 ? 0.6 : 0.1),
        close,
        volume: 300,
      })
    );
  }
  return filas;
}

let server;
let klines;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://binance.local');
    estado.peticiones.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });

    if (estado.responder && estado.responder(req, res, url)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(serieBinance({ velas: Number(url.searchParams.get('limit')) || 300 })));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  process.env.BINANCE_API = `http://127.0.0.1:${server.address().port}`;
  // Se requiere después de fijar la variable: el módulo la lee al cargarse.
  klines = require('../src/klines');
});

test.after(() => server.close());

test.beforeEach(() => {
  estado.peticiones = [];
  estado.responder = null;
  if (klines) klines._cache.clear();
});

// --- Parseo ----------------------------------------------------------------

test('el array posicional de Binance se convierte en velas utilizables', async () => {
  const { candles, source, symbol } = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 10 });

  assert.strictEqual(source, 'binance');
  assert.strictEqual(symbol, 'BTCUSDT');
  assert.strictEqual(candles.length, 10);

  const c = candles[0];
  assert.strictEqual(typeof c.open, 'number', 'los precios llegan como texto y tienen que salir como número');
  assert.strictEqual(typeof c.volume, 'number');
  assert.ok(Number.isFinite(c.openTime) && Number.isFinite(c.closeTime));
  assert.ok(c.high >= c.low);
  assert.strictEqual(typeof c.trades, 'number');
});

test('se piden a Binance los parámetros correctos', async () => {
  await klines.getKlines({ symbol: 'ethusdt', interval: '4h', limit: 5 });

  assert.strictEqual(estado.peticiones.length, 1);
  const { path, params } = estado.peticiones[0];
  assert.strictEqual(path, '/api/v3/klines');
  assert.strictEqual(params.symbol, 'ETHUSDT');
  assert.strictEqual(params.interval, '4h');
  assert.strictEqual(params.limit, String(klines.FETCH_LIMIT), 'el tamaño lo fija el servidor, no el cliente');
});

test('la vela en curso se distingue de las cerradas por su hora de cierre', async () => {
  const { candles } = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 50 });
  assert.strictEqual(candles[candles.length - 1].closed, false);
  assert.ok(candles.slice(0, -1).every((c) => c.closed));
});

test('una vela corrupta se descarta en vez de envenenar el análisis', async () => {
  estado.responder = (req, res) => {
    const filas = serieBinance({ velas: 100 });
    filas[40][2] = 'no-es-un-numero';   // máximo ilegible
    filas[60][1] = '0';                 // apertura a cero
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filas));
    return true;
  };

  const { candles } = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 100 });
  assert.strictEqual(candles.length, 98, 'dos fuera, el resto sirve');
  assert.ok(candles.every((c) => Number.isFinite(c.open) && Number.isFinite(c.high)));
});

// --- Errores de Binance ----------------------------------------------------

test('un símbolo inválido devuelve el error de Binance, no una serie vacía', async () => {
  estado.responder = (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }));
    return true;
  };

  await assert.rejects(() => klines.getKlines({ symbol: 'NOEXISTE', interval: '1h' }), /HTTP 400/);
  assert.strictEqual(estado.peticiones.length, 1, 'un 400 no se reintenta: repetirlo no lo arregla');
});

test('un 429 se reintenta con espera creciente', async () => {
  let intentos = 0;
  estado.responder = (req, res) => {
    intentos++;
    if (intentos < 3) {
      res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: -1003, msg: 'Too many requests.' }));
      return true;
    }
    return false; // a la tercera, responde bien
  };

  const { candles } = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 10 });
  assert.strictEqual(intentos, 3);
  assert.strictEqual(candles.length, 10);
});

test('si Binance se cae, se sirve lo último bueno en vez de romper la vista', async () => {
  const bueno = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 10 });
  await new Promise((r) => setTimeout(r, klines.ttlFor('1h') > 50 ? 60 : 10));

  // Se fuerza la caducidad y se tira la fuente.
  klines._cache.entries.get('klines:BTCUSDT:1h').expiresAt = Date.now() - 1;
  estado.responder = (req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1001, msg: 'Internal error.' }));
    return true;
  };

  const viejo = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 10 });
  assert.deepStrictEqual(viejo.candles, bueno.candles, 'mejor un precio viejo, etiquetado, que un error');
});

test('una respuesta que no es una lista de velas se rechaza con un mensaje claro', async () => {
  estado.responder = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mensaje: 'Binance cambió el formato' }));
    return true;
  };

  await assert.rejects(() => klines.getKlines({ symbol: 'BTCUSDT', interval: '1h' }), /no es una lista de velas/);
});

// --- Caché -----------------------------------------------------------------

test('cien peticiones a la vez son una sola llamada a Binance', async () => {
  const todas = await Promise.all(
    Array.from({ length: 100 }, () => klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 10 }))
  );

  assert.strictEqual(estado.peticiones.length, 1, `salieron ${estado.peticiones.length} llamadas`);
  assert.ok(todas.every((r) => r.candles.length === 10));
});

test('pedir distintos tamaños no multiplica las llamadas salientes', async () => {
  for (const limit of [10, 50, 100, 300, 500]) {
    await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit });
  }
  assert.strictEqual(estado.peticiones.length, 1, 'el limit recorta la respuesta, no abre otra clave de caché');
});

// --- El análisis encima de datos con forma de Binance ----------------------

test('el análisis de ruptura funciona sobre lo que devuelve Binance', async () => {
  const { analyzeBreakout } = require('../src/breakout');
  const { candles } = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 400 });
  const out = analyzeBreakout(candles, { interval: '1h' });

  assert.strictEqual(out.ok, true);
  assert.ok(out.atr > 0);
  assert.ok(out.explanation.length >= 3);
  assert.ok(out.up || out.down, 'tiene que encontrar algún nivel');
  for (const lado of [out.up, out.down].filter(Boolean)) {
    assert.ok(lado.probability >= 0 && lado.probability <= 1);
  }
});

test('una ruptura en datos con formato Binance dispara la señal de compra', async () => {
  const { evaluateSignals } = require('../src/signals');
  estado.responder = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(serieBinance({ velas: 300, romper: true })));
    return true;
  };

  const { candles } = await klines.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 300 });
  // La última vela de Binance está en curso; para que la ruptura cuente tiene
  // que estar cerrada, así que se evalúa como lo haría la interfaz al abrirse
  // la siguiente.
  const cerrada = candles.map((c, i) => (i === candles.length - 1 ? { ...c, closed: true } : c));
  const enCurso = { ...cerrada[cerrada.length - 1], openTime: cerrada[cerrada.length - 1].closeTime + 1, closed: false };

  const out = evaluateSignals({ candles: [...cerrada, enCurso], symbol: 'BTCUSDT', interval: '1h' });
  assert.strictEqual(out.signals[0].type, 'compra');
  assert.match(out.signals[0].title, /^Comprar BTCUSDT/);
  assert.ok(out.position.stop < out.position.entry);
});
