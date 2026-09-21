'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CATALOG, listSymbols, isKnown, groups, verifySymbols } = require('../src/symbols');

test('el catálogo son pares de Binance bien formados y sin repetir', () => {
  assert.ok(CATALOG.length >= 20, 'una lista corta no sirve de desplegable');
  const vistos = new Set();
  for (const s of CATALOG) {
    assert.match(s.symbol, /^[A-Z0-9]+USDT$/, `${s.symbol} no parece un par contra USDT`);
    assert.ok(s.name && s.name.length > 1, `${s.symbol} sin nombre legible`);
    assert.ok(s.group, `${s.symbol} sin grupo`);
    assert.ok(!vistos.has(s.symbol), `${s.symbol} repetido`);
    vistos.add(s.symbol);
  }
});

test('las grandes están y encabezan la lista', () => {
  for (const esperado of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
    assert.ok(isKnown(esperado), `falta ${esperado}`);
  }
  assert.strictEqual(CATALOG[0].symbol, 'BTCUSDT');
});

test('los grupos cubren todo el catálogo sin dejarse nada', () => {
  const total = groups().reduce((acc, g) => acc + g.symbols.length, 0);
  assert.strictEqual(total, CATALOG.length);
  assert.ok(groups().length >= 3);
});

test('listSymbols devuelve copias: nadie puede mutar el catálogo', () => {
  const lista = listSymbols();
  lista[0].name = 'Roto';
  assert.strictEqual(CATALOG[0].name, 'Bitcoin');
});

test('en modo demo no se llama a Binance y se dice que no está verificado', async () => {
  const out = await verifySymbols({ demo: true });
  assert.strictEqual(out.verified, false);
  assert.strictEqual(out.reason, 'modo demo');
  assert.strictEqual(out.symbols.length, CATALOG.length);
});
