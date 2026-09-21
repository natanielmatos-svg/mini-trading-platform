'use strict';

// Rutas HTTP contra un servidor de verdad en un puerto efímero, en modo demo:
// sin red y sin tocar Binance. Antes de esto no había ni un test de servidor.

process.env.DEMO = '1';

const test = require('node:test');
const assert = require('node:assert');

const app = require('../server');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  app.stream.closeAll();
  server.close();
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('/healthz no sale a Internet y dice en qué modo está', async () => {
  const { status, body } = await getJson('/healthz');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.demo, true);
  assert.ok(Array.isArray(body.streams));
});

test('/api/klines devuelve velas normalizadas', async () => {
  const { status, body } = await getJson('/api/klines?symbol=btcusdt&interval=4h&limit=10');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.symbol, 'BTCUSDT');
  assert.strictEqual(body.interval, '4h');
  assert.strictEqual(body.source, 'demo');
  assert.strictEqual(body.count, 10);

  const c = body.candles[0];
  for (const campo of ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime', 'closed']) {
    assert.ok(campo in c, `falta ${campo}`);
  }
  assert.strictEqual(body.candles.at(-1).closed, false, 'la última vela está en formación');
});

test('/api/klines rechaza lo que no entiende en vez de reenviarlo a Binance', async () => {
  const { body } = await getJson('/api/klines?symbol=../../secret&interval=7h&limit=99999');
  assert.strictEqual(body.symbol, 'SECRET');
  assert.strictEqual(body.interval, '1h');
  assert.ok(body.count <= 500, 'el limit del cliente no puede inflar la petición saliente');
});

test('/api/klines?format=raw mantiene el formato antiguo de Binance', async () => {
  const { body } = await getJson('/api/klines?limit=3&format=raw');
  assert.ok(Array.isArray(body));
  assert.strictEqual(body.length, 3);
  assert.ok(Array.isArray(body[0]));
  assert.strictEqual(typeof body[0][1], 'string', 'Binance manda los precios como texto');
});

test('/api/breakout responde con veredicto, explicación y muestra', async () => {
  const { status, body } = await getJson('/api/breakout?symbol=BTCUSDT&interval=1h');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.ok(body.explanation.length >= 3);
  assert.ok(body.context.length >= 4);
  assert.ok(body.sample.up.length > 100);
  assert.ok(['alza', 'baja', 'equilibrio', 'ninguna'].includes(body.bias));
  assert.match(body.disclaimer, /no una predicción/);
});

test('/api/breakout acepta el precio en vivo del cliente', async () => {
  const normal = (await getJson('/api/breakout?interval=1h')).body;
  const masAlto = normal.price * 1.002;
  const conPrecio = (await getJson(`/api/breakout?interval=1h&price=${masAlto}`)).body;

  assert.ok(conPrecio.price > normal.price, 'el precio del cliente manda sobre el de la vela cacheada');
  // Con el precio más arriba, el soporte queda necesariamente más lejos. Se
  // mira ese lado y no la resistencia: subir el precio puede dejarlo por
  // encima del último techo, y entonces no hay resistencia que medir.
  assert.ok(conPrecio.down, 'subiendo el precio siempre queda soporte por debajo');
  assert.ok(
    conPrecio.down.distance > normal.down.distance,
    `soporte a ${conPrecio.down.distance} debería estar más lejos que ${normal.down.distance}`
  );
});

test('/api/breakout ignora un precio absurdo', async () => {
  const { body } = await getJson('/api/breakout?interval=1h&price=-5');
  assert.ok(body.price > 0);
});

test('los indicadores se sirven al navegador desde el mismo archivo que usa el servidor', async () => {
  const res = await fetch(`${base}/lib/indicators.js`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const code = await res.text();
  assert.match(code, /globalThis\.Indicators/);
  assert.match(code, /function emaSeries/);
});

test('/api/symbols sirve el desplegable agrupado', async () => {
  const { status, body } = await getJson('/api/symbols');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.verified, false, 'en demo no se contrasta con Binance');
  assert.ok(body.groups.length >= 3);

  const todos = body.groups.flatMap((g) => g.symbols);
  assert.ok(todos.length >= 20);
  assert.ok(todos.every((s) => s.symbol && s.name && s.available));
  assert.ok(todos.some((s) => s.symbol === 'BTCUSDT'));
});

test('sólo se publican al navegador los tres módulos compartidos', async () => {
  for (const modulo of ['indicators.js', 'format.js', 'signals.js']) {
    const res = await fetch(`${base}/lib/${modulo}`);
    assert.strictEqual(res.status, 200, `/lib/${modulo}`);
    assert.match(res.headers.get('content-type'), /javascript/);
    await res.text();
  }

  // El resto de src/ no se publica: ahí están los proveedores y la orquestación.
  for (const prohibido of ['api.js', 'providers/index.js', '../package.json', '../server.js']) {
    const res = await fetch(`${base}/lib/${prohibido}`);
    assert.ok(res.status === 404, `/lib/${prohibido} devolvió ${res.status}`);
    await res.arrayBuffer().catch(() => {});
  }
});

test('el motor de señales que recibe el navegador es el mismo que usa Node', async () => {
  const código = await (await fetch(`${base}/lib/signals.js`)).text();
  assert.match(código, /globalThis\.Signals/);
  assert.match(código, /function evaluateSignals/);
  assert.match(código, /cierre, no toque/, 'la regla de confirmación viaja con el módulo');
});

test('el HTML se revalida y lleva cabeceras de seguridad', async () => {
  const res = await fetch(`${base}/index.html`);
  assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  const html = await res.text();
  assert.match(html, /name="viewport"/, 'sin viewport el móvil renderiza a escala de escritorio');
  assert.match(html, /id="symbolSelect"/, 'el desplegable de criptos');
  assert.match(html, /id="alertModal"/, 'la ventana emergente de avisos');
  assert.match(html, /\/lib\/signals\.js/, 'el navegador carga el motor de señales');
});

test('/api/stream entrega ticks por SSE', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream?symbol=BTCUSDT&interval=1m`, { signal: controller.signal });

  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.strictEqual(res.headers.get('x-accel-buffering'), 'no', 'sin esto Nginx bufferiza el stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const limite = Date.now() + 8000;

  while (!buffer.includes('event: kline') && Date.now() < limite) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  controller.abort();

  assert.match(buffer, /event: kline/);
  const linea = buffer.split('\n').find((l) => l.startsWith('data: {"symbol"'));
  const tick = JSON.parse(linea.slice(6));
  assert.strictEqual(tick.symbol, 'BTCUSDT');
  assert.strictEqual(tick.interval, '1m');
  assert.strictEqual(tick.source, 'demo');
  assert.ok(tick.close > 0);
});
