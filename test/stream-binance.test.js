'use strict';

// El WebSocket de Binance, contra un servidor local que habla su protocolo.
//
// El precio en vivo es la pieza con más cosas que pueden salir mal —un socket
// que se cae, un mensaje a medias, el otro extremo que no acepta— y hasta
// ahora sólo se probaba la fuente demo. Aquí se levanta un servidor WebSocket
// de verdad (apretón de manos RFC 6455 incluido, sin dependencias) que emite
// el mensaje `kline` con la forma documentada.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Node no trae WebSocket global hasta la 22. En Node 20 —que el proyecto
// soporta— el hub lo detecta y se va directo a sondeo, así que aquí no hay
// nada que probar contra un servidor WebSocket: se prueba la degradación.
const SIN_WS = typeof WebSocket !== 'function';
const soloConWs = SIN_WS && 'este Node no trae WebSocket global: el hub usa sondeo';
const soloSinWs = !SIN_WS && 'este Node trae WebSocket global';

// Trama de texto del servidor: sin máscara, que es lo que manda el estándar
// para el lado servidor. Con esto basta para emitir; lo que llegue del cliente
// se ignora, que en este flujo no manda nada.
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// El endpoint combinado envuelve cada mensaje en {stream, data}.
function envuelto(stream, data) {
  return JSON.stringify({ stream, data });
}

// Mensaje tal y como lo publica Binance en <par>@aggTrade.
function aggTradeMessage({ symbol = 'BTCUSDT', price, cantidad = '0.015' }) {
  return envuelto(`${symbol.toLowerCase()}@aggTrade`, {
    e: 'aggTrade', E: Date.now(), s: symbol, a: 123,
    p: price.toFixed(8), q: cantidad, f: 1, l: 2, T: Date.now(), m: false, M: true,
  });
}

// Mensaje tal y como lo publica Binance en <par>@kline_<intervalo>.
function klineMessage({ symbol = 'BTCUSDT', interval = '1h', t, close, cerrada = false }) {
  const step = 3_600_000;
  return envuelto(`${symbol.toLowerCase()}@kline_${interval}`, {
    e: 'kline',
    E: Date.now(),
    s: symbol,
    k: {
      t, T: t + step - 1, s: symbol, i: interval, f: 100, L: 200,
      o: '64000.00000000',
      c: close.toFixed(8),
      h: (close + 50).toFixed(8),
      l: (close - 80).toFixed(8),
      v: '812.40000000',
      n: 4210,
      x: cerrada,
      q: '52000000.00', V: '400.0', Q: '26000000.0', B: '0',
    },
  });
}

// `sockets` son los del test en curso; `todos` acumula cada socket que se ha
// abierto en el archivo. Sin esa segunda lista, al cerrar quedaban vivos los
// de tests anteriores y `server.close()` esperaba por ellos para siempre.
const ws = { conexiones: [], rutas: [], cerrarAlConectar: false, sockets: [], todos: [] };
let wsServer;
let restServer;
let stream;

function arrancarWebSocket() {
  wsServer = http.createServer();

  wsServer.on('upgrade', (req, socket) => {
    ws.conexiones.push(Date.now());
    ws.rutas.push(req.url);

    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    if (ws.cerrarAlConectar) {
      socket.destroy();
      return;
    }

    ws.sockets.push(socket);
    ws.todos.push(socket);
    socket.on('error', () => {});

    // Apretón de manos de cierre: el cliente manda una trama de cierre y espera
    // la del servidor. Sin responderla, su socket se queda colgado.
    socket.on('data', (buf) => {
      if ((buf[0] & 0x0f) === 0x8) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.destroy();
      }
    });
  });

  return new Promise((resolve) => wsServer.listen(0, resolve));
}

function emitir(mensaje) {
  for (const socket of ws.sockets) {
    if (!socket.destroyed) socket.write(textFrame(mensaje));
  }
}

function fakeClient() {
  const events = [];
  return { events, send(event, data) { events.push({ event, data }); }, close() { this.closed = true; } };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasta(condicion, limite = 4000) {
  const fin = Date.now() + limite;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await esperar(25);
  }
  return false;
}

test.before(async () => {
  await arrancarWebSocket();

  // El sondeo de respaldo tira de /api/v3/klines, así que hace falta también
  // el lado REST para poder comprobar la degradación de verdad.
  restServer = http.createServer((req, res) => {
    const step = 3_600_000;
    const ahora = Math.floor(Date.now() / step) * step;
    const fila = (t, close) => [t, '64000.0', '64100.0', '63900.0', String(close), '500.0', t + step - 1, '1', 10, '1', '1', '0'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([fila(ahora - step, 63950), fila(ahora, 64444)]));
  });
  await new Promise((resolve) => restServer.listen(0, resolve));

  process.env.BINANCE_WS = `ws://127.0.0.1:${wsServer.address().port}`;
  process.env.BINANCE_API = `http://127.0.0.1:${restServer.address().port}`;
  stream = require('../src/stream');
});

test.after(() => {
  for (const s of ws.todos) s.destroy();
  // undici reutiliza conexiones: sin cerrarlas a mano, el servidor REST se
  // queda esperando a sus keep-alive y el proceso no termina.
  restServer.closeAllConnections?.();
  wsServer.closeAllConnections?.();
  wsServer.close();
  restServer.close();
});

test.beforeEach(() => {
  ws.conexiones = [];
  ws.rutas = [];
  ws.sockets = [];
  ws.cerrarAlConectar = false;
});

test('se suscribe a la ruta que documenta Binance', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  hub.subscribe('BTCUSDT', '1h', fakeClient());

  assert.ok(await hasta(() => ws.rutas.length > 0), 'no llegó a conectar');
  assert.strictEqual(
    ws.rutas[0],
    '/stream?streams=btcusdt@kline_1h/btcusdt@aggTrade',
    'los dos flujos en una sola conexión: velas y operaciones'
  );
  hub.closeAll();
});

test('un mensaje kline real se convierte en tick y llega al cliente', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  const t = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  emitir(klineMessage({ t, close: 64180.5 }));

  assert.ok(await hasta(() => client.events.some((e) => e.event === 'kline')), 'no llegó ningún tick');
  const tick = client.events.find((e) => e.event === 'kline').data;

  assert.strictEqual(tick.symbol, 'BTCUSDT');
  assert.strictEqual(tick.interval, '1h');
  assert.strictEqual(tick.source, 'ws');
  assert.strictEqual(tick.close, 64180.5, 'los precios llegan como texto y salen como número');
  assert.strictEqual(tick.high, 64230.5);
  assert.strictEqual(tick.volume, 812.4);
  assert.strictEqual(tick.trades, 4210);
  assert.strictEqual(tick.closed, false);
  hub.closeAll();
});

test('una operación agregada mueve el precio sin esperar a la vela', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  emitir(aggTradeMessage({ price: 86640.64 }));

  assert.ok(await hasta(() => client.events.some((e) => e.event === 'price')), 'no llegó ningún precio');
  const precio = client.events.find((e) => e.event === 'price').data;

  assert.strictEqual(precio.price, 86640.64);
  assert.strictEqual(precio.quantity, 0.015);
  assert.strictEqual(precio.symbol, 'BTCUSDT');
  assert.ok(precio.at > 0);
  hub.closeAll();
});

test('el precio va por su propio evento y no como una vela', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  emitir(aggTradeMessage({ price: 86000 }));

  assert.ok(await hasta(() => client.events.some((e) => e.event === 'price')));
  assert.strictEqual(client.events.filter((e) => e.event === 'kline').length, 0, 'una operación no es una vela');
  hub.closeAll();
});

test('una ráfaga de operaciones se agrupa, pero el último precio siempre llega', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));

  // Cuarenta operaciones seguidas, como BTCUSDT en un minuto movido.
  for (let i = 0; i < 40; i++) emitir(aggTradeMessage({ price: 86000 + i }));

  // El último precio tiene que acabar llegando, aunque los intermedios no.
  assert.ok(
    await hasta(() => client.events.some((e) => e.event === 'price' && e.data.price === 86039)),
    'el precio más reciente no llegó'
  );

  const enviados = client.events.filter((e) => e.event === 'price').length;
  assert.ok(enviados < 40, `se retransmitieron ${enviados} de 40: no se está agrupando`);
  assert.ok(hub.rooms.get('BTCUSDT|1h').lastPrice.price === 86039, 'se guarda el último, no el último enviado');
  hub.closeAll();
});

test('quien llega tarde recibe el último precio sin esperar a la siguiente operación', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  hub.subscribe('BTCUSDT', '1h', fakeClient());
  assert.ok(await hasta(() => ws.sockets.length > 0));
  emitir(aggTradeMessage({ price: 86500 }));
  await hasta(() => hub.rooms.get('BTCUSDT|1h').lastPrice);

  const tarde = fakeClient();
  hub.subscribe('BTCUSDT', '1h', tarde);
  const precio = tarde.events.find((e) => e.event === 'price');
  assert.ok(precio, 'la vista debería pintar el precio al instante');
  assert.strictEqual(precio.data.price, 86500);
  hub.closeAll();
});

test('la marca x del mensaje distingue la vela cerrada', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('ETHUSDT', '15m', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  emitir(klineMessage({ symbol: 'ETHUSDT', interval: '15m', t: Date.now(), close: 3200, cerrada: true }));

  assert.ok(await hasta(() => client.events.some((e) => e.event === 'kline' && e.data.closed)));
  hub.closeAll();
});

test('un mensaje ilegible no tumba el stream', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  emitir('esto no es JSON');
  emitir(JSON.stringify({ e: 'otraCosa', sin: 'k' }));
  emitir(klineMessage({ t: Date.now(), close: 64200 }));

  assert.ok(await hasta(() => client.events.some((e) => e.event === 'kline')), 'el tick bueno tiene que llegar igual');
  hub.closeAll();
});

test('cien pestañas del mismo par son una sola conexión con Binance', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const clientes = Array.from({ length: 100 }, () => fakeClient());
  for (const c of clientes) hub.subscribe('BTCUSDT', '1h', c);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  await esperar(150);
  assert.strictEqual(ws.conexiones.length, 1, `se abrieron ${ws.conexiones.length} conexiones`);

  emitir(klineMessage({ t: Date.now(), close: 64321 }));
  assert.ok(await hasta(() => clientes.every((c) => c.events.some((e) => e.event === 'kline'))), 'el tick va a todos');
  hub.closeAll();
});

test('si el socket se cae, se reconecta', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => ws.sockets.length > 0));
  for (const s of ws.sockets) s.destroy();
  ws.sockets = [];

  assert.ok(await hasta(() => ws.conexiones.length >= 2, 4000), 'no reintentó');
  assert.ok(client.events.some((e) => e.event === 'status' && e.data.state === 'reconnecting'));
  hub.closeAll();
});

test('si el WebSocket no levanta, se degrada a sondeo y sigue habiendo precio', { skip: soloConWs }, async () => {
  ws.cerrarAlConectar = true;
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  const degradado = await hasta(
    () => client.events.some((e) => e.event === 'status' && e.data.state === 'degraded'),
    8000
  );
  assert.ok(degradado, 'nunca se rindió con el WebSocket');

  // Y lo importante: degradado no significa mudo.
  assert.ok(
    await hasta(() => client.events.some((e) => e.event === 'kline' && e.data.source === 'poll')),
    'sin WebSocket debería seguir llegando precio por sondeo'
  );
  const tick = client.events.filter((e) => e.event === 'kline').pop().data;
  assert.strictEqual(tick.close, 64444, 'el precio viene del REST de respaldo');
  hub.closeAll();
});

test('en un Node sin WebSocket global se va directo a sondeo, sin intentarlo', { skip: soloSinWs }, async () => {
  const hub = new stream.MarketStream();
  const client = fakeClient();
  hub.subscribe('BTCUSDT', '1h', client);

  assert.ok(await hasta(() => client.events.some((e) => e.event === 'kline')), 'sin WebSocket debería sondear');
  assert.strictEqual(hub.stats()[0].source, 'poll');
  assert.strictEqual(ws.conexiones.length, 0, 'ni siquiera intenta abrir el WebSocket');
  hub.closeAll();
});

test('closeAll cierra la conexión con Binance', { skip: soloConWs }, async () => {
  const hub = new stream.MarketStream();
  hub.subscribe('BTCUSDT', '1h', fakeClient());
  assert.ok(await hasta(() => ws.sockets.length > 0));

  hub.closeAll();
  assert.ok(await hasta(() => ws.sockets.every((s) => s.destroyed || !s.writable)), 'el socket sigue abierto');
  assert.strictEqual(hub.stats().length, 0);
});
