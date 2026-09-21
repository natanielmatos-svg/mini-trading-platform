'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MarketStream, tickFromKline, tickFromCandle } = require('../src/stream');

function fakeClient() {
  const events = [];
  return {
    events,
    send(event, data) { events.push({ event, data }); },
    close() { this.closed = true; },
  };
}

test('el mensaje de Binance se traduce a un tick', () => {
  const tick = tickFromKline({ t: 1000, T: 1999, o: '10.5', h: '11', l: '10', c: '10.8', v: '123', n: 7, x: false });
  assert.deepStrictEqual(tick, {
    openTime: 1000, closeTime: 1999, open: 10.5, high: 11, low: 10, close: 10.8, volume: 123, trades: 7, closed: false,
  });
});

test('una vela demo se traduce al mismo formato de tick', () => {
  const tick = tickFromCandle({ openTime: 1, closeTime: 2, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, closed: true });
  assert.strictEqual(tick.closed, true);
  assert.strictEqual(tick.close, 1.5);
});

test('en modo demo el hub emite ticks sin salir a Internet', async () => {
  const stream = new MarketStream({ demo: true });
  const client = fakeClient();
  stream.subscribe('BTCUSDT', '1m', client);

  const klines = client.events.filter((e) => e.event === 'kline');
  assert.ok(klines.length >= 1, 'el primer tick sale inmediatamente');
  assert.strictEqual(klines[0].data.symbol, 'BTCUSDT');
  assert.strictEqual(klines[0].data.source, 'demo');
  stream.closeAll();
});

test('varios clientes del mismo símbolo comparten una sola sala', () => {
  const stream = new MarketStream({ demo: true });
  const a = fakeClient();
  const b = fakeClient();
  stream.subscribe('BTCUSDT', '1h', a);
  stream.subscribe('BTCUSDT', '1h', b);
  stream.subscribe('ETHUSDT', '1h', fakeClient());

  const stats = stream.stats();
  assert.strictEqual(stats.length, 2, 'una sala por símbolo+timeframe');
  assert.strictEqual(stats.find((s) => s.symbol === 'BTCUSDT').clients, 2);
  stream.closeAll();
});

test('el recién llegado recibe el último tick conocido sin esperar al siguiente', () => {
  const stream = new MarketStream({ demo: true });
  stream.subscribe('BTCUSDT', '1h', fakeClient());

  const tarde = fakeClient();
  stream.subscribe('BTCUSDT', '1h', tarde);
  assert.ok(tarde.events.some((e) => e.event === 'kline'), 'la vista se pinta al instante');
  stream.closeAll();
});

test('el upstream no se cierra en cuanto se va el último cliente', () => {
  const stream = new MarketStream({ demo: true });
  const client = fakeClient();
  const unsubscribe = stream.subscribe('BTCUSDT', '1h', client);

  unsubscribe();
  assert.strictEqual(stream.stats().length, 1, 'hay margen para una recarga de página');
  stream.closeAll();
});

test('un cliente que falla al recibir se descarta y no tumba la sala', () => {
  const stream = new MarketStream({ demo: true });
  const roto = { send() { throw new Error('socket cerrado'); }, close() {} };
  const sano = fakeClient();
  stream.subscribe('BTCUSDT', '1h', roto);
  stream.subscribe('BTCUSDT', '1h', sano);

  const room = stream.rooms.get('BTCUSDT|1h');
  stream.broadcast(room, { openTime: 1, closeTime: 2, open: 1, high: 1, low: 1, close: 1, volume: 0, closed: false });

  assert.ok(!room.clients.has(roto), 'el cliente roto se va');
  assert.ok(room.clients.has(sano));
  stream.closeAll();
});

test('closeAll deja el hub vacío para que el proceso pueda salir', () => {
  const stream = new MarketStream({ demo: true });
  const client = fakeClient();
  stream.subscribe('BTCUSDT', '1h', client);
  stream.closeAll();
  assert.strictEqual(stream.stats().length, 0);
  assert.strictEqual(client.closed, true);
});
