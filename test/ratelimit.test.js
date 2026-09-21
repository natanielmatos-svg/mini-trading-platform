'use strict';

// El limitador se configura por entorno al cargar el módulo, así que va en su
// propio archivo: node --test da un proceso a cada uno.

process.env.DEMO = '1';
process.env.RATE_MAX = '5';
process.env.RATE_WINDOW_MS = '60000';
process.env.MAX_STREAMS_PER_IP = '2';

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

test('pasado el límite por IP se responde 429 con Retry-After', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const res = await fetch(`${base}/api/klines?limit=1`);
    codes.push(res.status);
    if (res.status === 429) {
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      const body = await res.json();
      assert.match(body.details, /Máximo 5/);
    }
    await res.arrayBuffer().catch(() => {});
  }
  assert.deepStrictEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.ok(codes.slice(5).every((c) => c === 429), `códigos: ${codes}`);
});

test('/healthz queda fuera del límite: es la sonda del supervisor', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/healthz`);
    assert.strictEqual(res.status, 200);
    await res.arrayBuffer();
  }
});
