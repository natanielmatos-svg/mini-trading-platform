'use strict';

// El protocolo de Alpaca, contra un servidor local que lo imita.
//
// Mismo motivo que con los exchanges de cripto: desde aquí no hay salida a
// Internet, y además Alpaca exige clave, así que ni con red se podría probar
// sin una cuenta. Esto fija que si responde lo que documenta, se entiende.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const estado = { bars: null, quotes: null, clock: null, peticiones: [] };

// Barras tal y como las publica: marcas ISO y el mapa por símbolo.
function barra(iso, { o, h, l, c, v = 1000, n = 50 }) {
  return { t: iso, o, h, l, c, v, n, vw: (h + l) / 2 };
}

const BARS_OK = {
  body: {
    bars: {
      AAPL: [
        barra('2026-09-21T13:30:00Z', { o: 175.1, h: 175.9, l: 174.8, c: 175.5 }),
        barra('2026-09-21T14:30:00Z', { o: 175.5, h: 176.4, l: 175.2, c: 176.1 }),
        barra('2026-09-21T15:30:00Z', { o: 176.1, h: 176.3, l: 175.0, c: 175.3 }),
      ],
    },
    next_page_token: null,
  },
};

const QUOTES_OK = {
  body: { quotes: { AAPL: { ap: 175.32, as: 3, bp: 175.28, bs: 5, t: '2026-09-21T15:59:58.123Z' } } },
};

const CLOCK_OK = {
  body: {
    timestamp: '2026-09-21T15:45:00Z',
    is_open: true,
    next_open: '2026-09-22T13:30:00Z',
    next_close: '2026-09-21T20:00:00Z',
  },
};

let alpaca;
let servidor;

test.before(async () => {
  servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    estado.peticiones.push({
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      headers: req.headers,
    });

    const cual = url.pathname.includes('/bars') ? 'bars' : url.pathname.includes('/quotes') ? 'quotes' : 'clock';
    const porDefecto = { bars: BARS_OK, quotes: QUOTES_OK, clock: CLOCK_OK }[cual];
    const { status = 200, body } = estado[cual] || porDefecto;

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  await new Promise((r) => servidor.listen(0, r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  process.env.ALPACA_DATA_API = base;
  process.env.ALPACA_API = base;
  process.env.ALPACA_KEY_ID = 'clave-de-prueba';
  process.env.ALPACA_SECRET_KEY = 'secreto-de-prueba';
  alpaca = require('../src/alpaca');
});

test.after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

test.beforeEach(() => {
  estado.bars = null;
  estado.quotes = null;
  estado.clock = null;
  estado.peticiones = [];
  if (alpaca) alpaca._relojCache.clear();
});

// --- Velas -----------------------------------------------------------------

test('las barras de Alpaca se convierten a la forma que usa la aplicación', async () => {
  const { candles, symbol, source } = await alpaca.fetchCandles({ symbol: 'aapl', interval: '1h', now: Date.parse('2026-09-21T16:00:00Z') });

  assert.strictEqual(symbol, 'AAPL');
  assert.match(source, /^alpaca:/);
  assert.strictEqual(candles.length, 3);

  const primera = candles[0];
  assert.strictEqual(primera.openTime, Date.parse('2026-09-21T13:30:00Z'), 'sus marcas son ISO, no milisegundos');
  assert.strictEqual(primera.closeTime, Date.parse('2026-09-21T14:30:00Z') - 1);
  assert.strictEqual(primera.open, 175.1);
  assert.strictEqual(primera.close, 175.5);
  assert.strictEqual(primera.volume, 1000);
  assert.strictEqual(primera.closed, true);
});

test('la vela en curso se distingue igual que en cripto', async () => {
  // A las 16:00 la barra de las 15:30 todavía no ha cerrado.
  const { candles } = await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1h', now: Date.parse('2026-09-21T16:00:00Z') });
  assert.strictEqual(candles[candles.length - 1].closed, false);
  assert.ok(candles.slice(0, -1).every((c) => c.closed));
});

test('se piden los parámetros correctos, y la clave va en cabeceras', async () => {
  await alpaca.fetchCandles({ symbol: 'AAPL', interval: '15m', limit: 100 });

  const { path, params, headers } = estado.peticiones[0];
  assert.strictEqual(path, '/v2/stocks/bars');
  assert.strictEqual(params.symbols, 'AAPL');
  assert.strictEqual(params.timeframe, '15Min', 'su notación, no la nuestra');
  assert.strictEqual(params.feed, alpaca.FEED);
  assert.strictEqual(params.adjustment, 'split', 'sin ajustar por splits el histórico miente');
  assert.ok(params.start, 'hace falta un inicio: la bolsa cierra y un día natural no da un día de barras');

  assert.strictEqual(headers['apca-api-key-id'], 'clave-de-prueba');
  assert.strictEqual(headers['apca-api-secret-key'], 'secreto-de-prueba');
});

test('se pide margen de sobra porque la sesión dura seis horas y media', async () => {
  await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1h', limit: 400, now: Date.parse('2026-09-21T16:00:00Z') });
  const desde = Date.parse(estado.peticiones[0].params.start);
  const dias = (Date.parse('2026-09-21T16:00:00Z') - desde) / 86_400_000;

  // 400 velas de una hora son unos 62 días de bolsa, no 17 naturales.
  assert.ok(dias > 55, `sólo pidió ${Math.round(dias)} días: no llegarían 400 barras`);
});

test('un ticker sin barras se dice, no se devuelve vacío en silencio', async () => {
  estado.bars = { status: 200, body: { bars: {} } };
  await assert.rejects(() => alpaca.fetchCandles({ symbol: 'NOEXISTE' }), /no devolvió barras para NOEXISTE/);
});

test('una barra corrupta se descarta, el resto sirve', async () => {
  estado.bars = {
    status: 200,
    body: { bars: { AAPL: [barra('2026-09-21T13:30:00Z', { o: 175, h: 176, l: 174, c: 175 }),
                          { t: '2026-09-21T14:30:00Z', o: 'x', h: 1, l: 2, c: 3, v: 1 }] } },
  };
  const { candles } = await alpaca.fetchCandles({ symbol: 'AAPL' });
  assert.strictEqual(candles.length, 1);
});

// --- Precio ----------------------------------------------------------------

test('el precio sale del punto medio del libro', async () => {
  const q = await alpaca.fetchQuote({ symbol: 'AAPL' });
  assert.strictEqual(q.price, 175.3, 'medio de 175,28 y 175,32');
  assert.strictEqual(q.bid, 175.28);
  assert.strictEqual(q.ask, 175.32);
  assert.strictEqual(estado.peticiones[0].path, '/v2/stocks/quotes/latest');
});

test('un libro cruzado o vacío no se cuela como precio', async () => {
  estado.quotes = { status: 200, body: { quotes: { AAPL: { ap: 175.0, bp: 175.5 } } } };
  await assert.rejects(() => alpaca.fetchQuote({ symbol: 'AAPL' }), /libro utilizable/);

  estado.quotes = { status: 200, body: { quotes: {} } };
  await assert.rejects(() => alpaca.fetchQuote({ symbol: 'AAPL' }), /libro utilizable/);
});

// --- Reloj del mercado -----------------------------------------------------

test('el reloj dice si la bolsa está abierta y cuándo cierra', async () => {
  const reloj = await alpaca.fetchClock();

  assert.strictEqual(reloj.isOpen, true);
  assert.strictEqual(reloj.nextClose, Date.parse('2026-09-21T20:00:00Z'));
  assert.strictEqual(reloj.nextOpen, Date.parse('2026-09-22T13:30:00Z'));
  assert.strictEqual(estado.peticiones[0].path, '/v2/clock');
});

test('con la bolsa cerrada se sabe cuándo abre', async () => {
  estado.clock = {
    status: 200,
    body: { timestamp: '2026-09-21T23:00:00Z', is_open: false, next_open: '2026-09-22T13:30:00Z', next_close: '2026-09-22T20:00:00Z' },
  };
  const reloj = await alpaca.fetchClock();
  assert.strictEqual(reloj.isOpen, false);
  assert.ok(reloj.nextOpen > reloj.now, 'abre después de ahora');
});

test('el reloj se cachea: no hace falta preguntarlo en cada repintado', async () => {
  await alpaca.fetchClock();
  await alpaca.fetchClock();
  await alpaca.fetchClock();
  assert.strictEqual(estado.peticiones.length, 1);
});

test('si el reloj falla se sirve el último bueno antes que quedarse sin saber', async () => {
  const bueno = await alpaca.fetchClock();
  alpaca._relojCache.entries.get('clock').expiresAt = Date.now() - 1;

  estado.clock = { status: 503, body: { message: 'unavailable' } };
  const viejo = await alpaca.fetchClock();
  assert.deepStrictEqual(viejo, bueno);
});

// --- Libros que no son libros ----------------------------------------------

test('una horquilla imposible no se acepta como precio', () => {
  // Caso real, medido en vivo con la bolsa cerrada: el feed de IEX devolvió
  // para AAPL una horquilla del 10% y un punto medio de 340,04 cuando la
  // última vela había cerrado en 309,27. Eso no es un precio: son dos puntas
  // de sesiones distintas.
  //
  // Importaba porque la resistencia estaba en 309,91, así que el análisis
  // habría cantado "nivel superado" y podido abrir una compra sobre un número
  // que no existió nunca.
  // Estas puntas reproducen la medición: punto medio 340,04 y 10,03%.
  estado.quotes = { body: { quotes: { AAPL: { bp: 322.99, ap: 357.09, bs: 1, as: 1, t: '2026-09-22T02:00:00Z' } } } };

  return assert.rejects(
    () => alpaca.fetchQuote({ symbol: 'AAPL' }),
    (err) => {
      assert.match(err.message, /horquilla del 10,0|horquilla del 10\.0/);
      assert.ok(err.horquilla > 0.09 && err.horquilla < 0.11, `el dato viaja con el error: ${err.horquilla}`);
      assert.match(err.message, /mercado cerrado/, 'y dice la causa más probable');
      return true;
    }
  );
});

test('una horquilla normal sigue pasando', async () => {
  estado.quotes = { body: { quotes: { AAPL: { bp: 309.2, ap: 309.3, bs: 5, as: 5, t: '2026-09-22T15:00:00Z' } } } };
  const q = await alpaca.fetchQuote({ symbol: 'AAPL' });

  assert.ok(Math.abs(q.price - 309.25) < 1e-9);
  assert.ok(q.horquilla < 0.001, `horquilla ${q.horquilla}`);
});

test('el límite de horquilla está donde separa un libro real de uno roto', () => {
  // Un valor del catálogo que cotiza con más de un 2% de horquilla no está
  // cotizando: ni las megacaps ni los ETF de índices se acercan a eso.
  assert.ok(alpaca.HORQUILLA_MAX > 0.001, 'ni tan estrecho que rechace un libro normal');
  assert.ok(alpaca.HORQUILLA_MAX < 0.05, 'ni tan ancho que acepte el de tu caso');
});

test('las barras de horario extendido se pueden recortar a la sesión', async () => {
  // Medido en vivo: 55 de 205 barras de una hora caían fuera de sesión. Un
  // rango ancho con cuatro operaciones infla el ATR y coloca pivotes donde no
  // hubo mercado.
  const dentro = (ms) => new Date(ms).getUTCHours() >= 14 && new Date(ms).getUTCHours() < 20;
  const barra = (iso, p) => ({ t: iso, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000, n: 50 });

  estado.bars = {
    body: {
      bars: {
        AAPL: [
          barra('2026-09-21T09:00:00Z', 300), // premarket
          barra('2026-09-21T14:30:00Z', 301), // sesión
          barra('2026-09-21T15:30:00Z', 302), // sesión
          barra('2026-09-21T23:00:00Z', 303), // after hours
        ],
      },
    },
  };

  const sin = await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1h', limit: 10, now: Date.UTC(2026, 8, 22) });
  assert.equal(sin.candles.length, 4, 'sin filtro vienen todas');
  assert.equal(sin.fueraDeSesion, 0);

  const con = await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1h', limit: 10, now: Date.UTC(2026, 8, 22), soloSesion: dentro });
  assert.equal(con.candles.length, 2, 'con filtro sólo las de sesión');
  assert.equal(con.fueraDeSesion, 2, 'y se dice cuántas se quitaron');
});

test('las velas diarias no se filtran: una sesión entera no está fuera de sesión', async () => {
  const nunca = () => false;
  estado.bars = { body: { bars: { AAPL: [{ t: '2026-09-21T04:00:00Z', o: 300, h: 301, l: 299, c: 300.5, v: 1e6, n: 1e4 }] } } };

  const r = await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1d', limit: 5, now: Date.UTC(2026, 8, 22), soloSesion: nunca });
  assert.equal(r.candles.length, 1, 'el filtro no se aplica a marcos de un día o más');
});

test('se piden las barras MÁS RECIENTES, no las más antiguas del rango', async () => {
  // El fallo: Alpaca devuelve ascendente desde `start`, así que cuando la
  // ventana contiene más barras que el límite se quedaba con las de hace días.
  // Con velas de una hora la ventana cabía entera y no se notaba; con las de
  // un minuto son ~1.950 barras de sesión en el rango y sólo caben 800.
  estado.bars = null;
  estado.peticiones = [];

  await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1m', limit: 240, now: Date.UTC(2026, 8, 22) });
  const p = estado.peticiones.find((x) => x.path.includes('/bars'));
  assert.equal(p.params.sort, 'desc', 'sin esto se traen las viejas');
});

test('las velas salen en orden aunque lleguen del revés', async () => {
  // `sort: desc` las devuelve de la más nueva a la más vieja. Si se dejaran
  // así, el ATR y los niveles se calcularían sobre una serie invertida y nadie
  // se enteraría: los números seguirían saliendo.
  const barra = (iso, p) => ({ t: iso, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000, n: 10 });
  estado.bars = {
    body: {
      bars: {
        AAPL: [
          barra('2026-09-21T17:30:00Z', 303),
          barra('2026-09-21T16:30:00Z', 302),
          barra('2026-09-21T15:30:00Z', 301),
        ],
      },
    },
  };

  const { candles } = await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1h', limit: 10, now: Date.UTC(2026, 8, 22) });
  assert.equal(candles.length, 3);
  for (let i = 1; i < candles.length; i++) {
    assert.ok(candles[i].openTime > candles[i - 1].openTime, 'cronológico');
  }
  assert.equal(candles[candles.length - 1].close, 303, 'la última es la más reciente');
});
