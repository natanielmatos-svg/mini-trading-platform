'use strict';

// Rutas HTTP contra un servidor de verdad en un puerto efímero, en modo demo:
// sin red y sin tocar Binance. Antes de esto no había ni un test de servidor.

process.env.DEMO = '1';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

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

test('el motor de señales que recibe el navegador es el mismo que usa Node', async () => {
  const código = await (await fetch(`${base}/lib/signals.js`)).text();
  assert.match(código, /globalThis\.Signals/);
  assert.match(código, /function evaluateSignals/);
  assert.match(código, /CIERRA al otro lado del nivel y con volumen/, 'la regla de confirmación viaja con el módulo');
});

test('el código se revalida siempre: el HTML y también el JavaScript', async () => {
  // Cachear app.js una hora significaba que tras desplegar un arreglo el
  // navegador seguía ejecutando la versión anterior. Pasó de verdad.
  for (const ruta of ['/index.html', '/app.js', '/lib/indicators.js', '/lib/signals.js', '/lib/format.js']) {
    const res = await fetch(`${base}${ruta}`);
    assert.strictEqual(res.headers.get('cache-control'), 'no-cache', `${ruta} se estaba cacheando`);
    await res.arrayBuffer();
  }
});

test('revalidar es barato: con ETag responde 304 sin cuerpo', async () => {
  const primera = await fetch(`${base}/app.js`);
  const etag = primera.headers.get('etag');
  await primera.arrayBuffer();
  assert.ok(etag, 'sin ETag, "no-cache" obligaría a reenviar el archivo entero');

  // Con `fetch` no se puede comprobar esto: undici añade por su cuenta
  // `cache-control: no-cache` y `pragma: no-cache` a la petición, y ante eso
  // Express hace lo correcto —devolver el archivo entero, porque el cliente
  // ha pedido explícitamente no usar copia— así que nunca se vería un 304.
  // Un navegador normal no manda esas cabeceras. Se usa http directamente.
  const { status, cuerpo } = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: '/app.js', headers: { 'if-none-match': etag } },
      (res) => {
        let datos = '';
        res.on('data', (c) => { datos += c; });
        res.on('end', () => resolve({ status: res.statusCode, cuerpo: datos }));
      }
    );
    req.on('error', reject);
    req.end();
  });

  assert.strictEqual(status, 304);
  assert.strictEqual(cuerpo.length, 0);
});

test('el HTML lleva cabeceras de seguridad', async () => {
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

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

test('/api/stocks/symbols no sale a la red y dice si hay clave', async () => {
  const { status, body } = await getJson('/api/stocks/symbols');
  assert.strictEqual(status, 200);
  assert.strictEqual(typeof body.conClave, 'boolean');
  assert.ok(body.count > 20);
  assert.ok(Array.isArray(body.groups) && body.groups.length >= 4);
  assert.ok(body.intervals.includes('1h'));

  // La interfaz tiene que poder pintar el desplegable sin clave: es
  // justamente cuando hay que explicar qué falta.
  for (const g of body.groups) assert.ok(g.symbols.length > 0);
});

test('/api/stocks/clock dice si el mercado está abierto y cuándo cambia', async () => {
  const { status, body } = await getJson('/api/stocks/clock');
  assert.strictEqual(status, 200);
  assert.strictEqual(typeof body.isOpen, 'boolean');
  // Uno de los dos siempre: si está abierto, cuándo cierra; si no, cuándo abre.
  assert.ok(Number.isFinite(body.isOpen ? body.nextClose : body.nextOpen));
  assert.ok((body.isOpen ? body.nextClose : body.nextOpen) > Date.now());
});

test('/api/stocks/candles devuelve velas de bolsa con la misma forma', async () => {
  const { status, body } = await getJson('/api/stocks/candles?symbol=nvda&interval=1h&limit=12');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.symbol, 'NVDA');
  assert.strictEqual(body.interval, '1h');
  assert.strictEqual(body.count, 12);

  const c = body.candles[0];
  for (const campo of ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime', 'closed']) {
    assert.ok(campo in c, `falta ${campo}`);
  }
  assert.ok(c.high >= c.low);
});

test('/api/stocks/candles rechaza un ticker que no está en el catálogo', async () => {
  // No es paranoia con Alpaca: un ticker inventado gasta una llamada y
  // devuelve un error críptico.
  const { body } = await getJson('/api/stocks/candles?symbol=ZZZZ&limit=3');
  assert.strictEqual(body.symbol, 'AAPL');
});

test('/api/stocks/quote da un precio y de qué feed viene', async () => {
  const { status, body } = await getJson('/api/stocks/quote?symbol=SPY');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.symbol, 'SPY');
  assert.ok(body.price > 0, 'incluso con el mercado cerrado hay un último precio');
  assert.ok(body.feed, 'siempre se dice de dónde sale el precio');
});

test('/api/stocks/breakout analiza velas de bolsa y adjunta el reloj', async () => {
  const { status, body } = await getJson('/api/stocks/breakout?symbol=AAPL&interval=1h');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.symbol, 'AAPL');
  assert.strictEqual(body.ok, true);

  // El reloj va en la respuesta porque sin él la interfaz enseñaría una cuenta
  // atrás hacia el cierre de una vela que no se va a mover hasta el lunes.
  assert.ok(body.clock);
  assert.strictEqual(typeof body.clock.isOpen, 'boolean');

  // Y el análisis es el mismo que en cripto: mismos campos, misma explicación.
  assert.ok(Number.isFinite(body.atr) && body.atr > 0);
  assert.ok(Array.isArray(body.explanation) && body.explanation.length);
  assert.ok(Array.isArray(body.context));
  assert.ok(body.sample && Array.isArray(body.sample.up));
  assert.ok(body.disclaimer);
});

test('los módulos compartidos con el navegador se publican y nada más', async () => {
  for (const archivo of ['indicators.js', 'format.js', 'signals.js', 'chart.js', 'panel-ruptura.js', 'avisos.js', 'tabla-mtf.js']) {
    const res = await fetch(`${base}/lib/${archivo}`);
    assert.strictEqual(res.status, 200, `/lib/${archivo}`);
    assert.match(res.headers.get('content-type') || '', /javascript/, `${archivo}: tipo servible`);
  }

  // Dentro de src/ están también los proveedores y la orquestación.
  for (const fuera of ['api.js', 'providers.js', 'venues.js', 'alpaca.js', 'stocks.js', '../package.json']) {
    const res = await fetch(`${base}/lib/${encodeURIComponent(fuera)}`);
    assert.strictEqual(res.status, 404, `/lib/${fuera} no debería servirse`);
  }
});

test('las dos páginas cargan los módulos que usan', async () => {
  const necesarios = {
    '/index.html': ['indicators.js', 'format.js', 'signals.js', 'chart.js', 'panel-ruptura.js', 'avisos.js', 'tabla-mtf.js'],
    '/acciones.html': ['indicators.js', 'format.js', 'signals.js', 'chart.js', 'panel-ruptura.js', 'avisos.js', 'tabla-mtf.js'],
  };

  for (const [pagina, modulos] of Object.entries(necesarios)) {
    const html = await (await fetch(`${base}${pagina}`)).text();
    for (const m of modulos) {
      assert.match(html, new RegExp(`/lib/${m.replace('.', '\\.')}`), `${pagina} no carga ${m}`);
    }
    assert.match(html, /\/estilo\.css/, `${pagina} no carga la hoja común`);
  }
});

test('/api/forecast manda la distribución empaquetada, no sólo las bandas', async () => {
  // Sin la rejilla el navegador no podría responder por un precio cualquiera:
  // tendría que preguntar al servidor en cada tick, diez veces por segundo.
  const { status, body } = await getJson('/api/forecast?symbol=btcusdt&interval=1h');
  assert.strictEqual(status, 200);

  const h = body.horizontes.find((x) => x.ok);
  assert.ok(h, 'algún horizonte tiene que salir en modo demo');
  assert.ok(h.rejilla && Array.isArray(h.rejilla.z), 'falta la rejilla');
  assert.ok(h.rejilla.z.length >= 20 && h.rejilla.z.length <= 128, `${h.rejilla.z.length} puntos`);
  assert.ok(h.rejilla.n <= h.rejilla.muestra, 'nunca más puntos que observaciones');
  assert.ok(h.sigmaHorizonte > 0, 'y la sigma del plazo, que es la otra mitad de la cuenta');
});

test('/api/forecast responde por un nivel concreto si se le pide', async () => {
  const sin = await getJson('/api/forecast?symbol=btcusdt&interval=1h');
  const primero = sin.body.horizontes.find((h) => h.ok);
  assert.ok(!primero.probabilidad, 'sin nivel no se calcula');

  // El nivel es el precio en el que ESE horizonte está centrado, no el del
  // encabezado: los plazos cortos se miden con velas de un minuto y los largos
  // con las del gráfico, así que cada uno parte de la última vela de su serie.
  // Con datos de verdad las dos coinciden —ambas acaban en el precio de ahora—;
  // en modo demo las series se generan aparte y no tienen por qué.
  const { body } = await getJson(`/api/forecast?symbol=btcusdt&interval=1h&nivel=${primero.precio}`);
  const h = body.horizontes.find((x) => x.ok && x.ms === primero.ms);

  assert.ok(h.probabilidad, 'con nivel sí');
  assert.ok(Math.abs(h.probabilidad.encima - 0.5) < 0.05, `en su propio precio, la mitad: ${h.probabilidad.encima}`);
  assert.ok(Math.abs(h.probabilidad.encima + h.probabilidad.debajo - 1) < 1e-9);
});

test('/api/forecast y la probabilidad no se contradicen', async () => {
  // La banda del 90% acaba en un precio; la probabilidad de acabar por encima
  // de ese precio tiene que ser el 5%. Si no, dos filas de la misma tarjeta
  // dicen cosas distintas y no hay forma de saber cuál creer.
  const primera = await getJson('/api/forecast?symbol=btcusdt&interval=1h');
  const h0 = primera.body.horizontes.find((x) => x.ok);
  const borde = h0.bandas.find((b) => b.q === 0.95).price;

  const { body } = await getJson(`/api/forecast?symbol=btcusdt&interval=1h&nivel=${borde}`);
  const h = body.horizontes.find((x) => x.ok && x.ms === h0.ms);
  assert.ok(Math.abs(h.probabilidad.encima - 0.05) < 0.02, `salió ${h.probabilidad.encima}`);
});

test('/api/forecast ignora un nivel que no es un precio', async () => {
  for (const nivel of ['0', '-5', 'hola', '']) {
    const { status, body } = await getJson(`/api/forecast?symbol=btcusdt&interval=1h&nivel=${nivel}`);
    assert.strictEqual(status, 200, `nivel=${nivel}`);
    assert.ok(!body.horizontes.find((h) => h.ok).probabilidad, `nivel=${nivel} no debería calcular nada`);
  }
});

test('/lib/panel-probabilidad.js se publica al navegador', async () => {
  const res = await fetch(`${base}/lib/panel-probabilidad.js`);
  assert.strictEqual(res.status, 200);
  const cuerpo = await res.text();
  assert.match(cuerpo, /globalThis\.PanelProbabilidad/);
});
