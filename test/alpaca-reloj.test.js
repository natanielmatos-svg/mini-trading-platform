'use strict';

// El reloj del mercado, cuando la clave es de papel y no de la cuenta real.
//
// Alpaca tiene dos cuentas con claves distintas y no son intercambiables: una
// clave de papel contra el host real devuelve un 403 idéntico al de no mandar
// credenciales. Como de la API de trading sólo se usa el reloj —que es el
// mismo mercado para las dos— se prueban los dos hosts en vez de obligar a
// adivinar cuál toca. Esto fija ese comportamiento.
//
// Va en un archivo aparte de alpaca.test.js porque necesita DOS servidores y
// un `ALPACA_API` con los dos, y esas variables se leen al cargar el módulo.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const CLOCK_OK = {
  timestamp: '2026-09-21T15:45:00Z',
  is_open: true,
  next_open: '2026-09-22T13:30:00Z',
  next_close: '2026-09-21T20:00:00Z',
};

const estado = { real: null, papel: null, peticiones: [] };

function servidor(cual) {
  return http.createServer((req, res) => {
    estado.peticiones.push({ cual, path: new URL(req.url, 'http://x').pathname, headers: req.headers });
    const { status = 200, body } = estado[cual] || { status: 200, body: CLOCK_OK };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

// Lo que devuelve Alpaca a una clave que no es de esa cuenta: un 403 seco.
const PROHIBIDO = { status: 403, body: { message: 'forbidden.' } };

let alpaca;
let real;
let papel;

test.before(async () => {
  real = servidor('real');
  papel = servidor('papel');
  await new Promise((r) => real.listen(0, r));
  await new Promise((r) => papel.listen(0, r));

  const urlReal = `http://127.0.0.1:${real.address().port}`;
  const urlPapel = `http://127.0.0.1:${papel.address().port}`;

  process.env.ALPACA_API = `${urlReal},${urlPapel}`;
  process.env.ALPACA_KEY_ID = 'clave-de-prueba';
  process.env.ALPACA_SECRET_KEY = 'secreto-de-prueba';

  delete require.cache[require.resolve('../src/alpaca')];
  alpaca = require('../src/alpaca');
});

test.after(() => {
  for (const s of [real, papel]) {
    s.closeAllConnections?.();
    s.close();
  }
  delete require.cache[require.resolve('../src/alpaca')];
});

test.beforeEach(() => {
  estado.real = null;
  estado.papel = null;
  estado.peticiones = [];
  alpaca._relojCache.clear();
  alpaca._olvidarTradingApi();
});

test('con una clave de papel el reloj cae al host de papel', async () => {
  estado.real = PROHIBIDO;

  const reloj = await alpaca.fetchClock();
  assert.equal(reloj.isOpen, true);
  assert.equal(reloj.nextClose, Date.parse('2026-09-21T20:00:00Z'));
  assert.equal(reloj.api, alpaca.TRADING_APIS[1], 'respondió el segundo host');

  // Y la clave viajó a los dos, no se probó a ciegas sin credenciales.
  assert.equal(estado.peticiones.length, 2);
  for (const p of estado.peticiones) {
    assert.equal(p.path, '/v2/clock');
    assert.equal(p.headers['apca-api-key-id'], 'clave-de-prueba');
    assert.equal(p.headers['apca-api-secret-key'], 'secreto-de-prueba');
  }
});

test('el host que funcionó se recuerda: no se paga el 403 en cada consulta', async () => {
  estado.real = PROHIBIDO;
  await alpaca.fetchClock();
  assert.equal(estado.peticiones.length, 2);

  // Segunda consulta, con la caché vencida: sólo el que sirve.
  alpaca._relojCache.clear();
  estado.peticiones = [];
  await alpaca.fetchClock();
  assert.equal(estado.peticiones.length, 1);
  assert.equal(estado.peticiones[0].cual, 'papel');
});

test('con una clave real no se molesta al host de papel', async () => {
  await alpaca.fetchClock();
  assert.equal(estado.peticiones.length, 1);
  assert.equal(estado.peticiones[0].cual, 'real');
});

test('un fallo que no es de credenciales no se reintenta en el otro host', async () => {
  // Un 500 no significa que la clave sea del otro tipo, y repetir la petición
  // contra otro sitio sólo añade espera.
  estado.real = { status: 500, body: { message: 'boom' } };

  await assert.rejects(() => alpaca.fetchClock(), /HTTP 500/);
  // El reintento interno de fetchJson cuenta, pero ninguno va a papel.
  assert.ok(estado.peticiones.every((p) => p.cual === 'real'), 'no se tocó el host de papel');
});

test('si los dos rechazan la clave, el error dice exactamente eso', async () => {
  estado.real = PROHIBIDO;
  estado.papel = PROHIBIDO;

  await assert.rejects(
    () => alpaca.fetchClock(),
    (err) => {
      assert.match(err.message, /las de papel y las reales son distintas/);
      assert.match(err.message, /ALPACA_KEY_ID/);
      return true;
    }
  );
});
