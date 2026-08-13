'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const polymarket = require('../src/providers/polymarket');
const kalshi = require('../src/providers/kalshi');
const manifold = require('../src/providers/manifold');

const DEMO_DIR = path.join(__dirname, '..', 'data', 'demo');
const read = (name) => JSON.parse(fs.readFileSync(path.join(DEMO_DIR, name), 'utf8'));

const pmRaw = read('polymarket-events.json');
const kalshiRaw = read('kalshi-events.json');
const manifoldRaw = read('manifold-markets.json');

test('Polymarket: un evento negRisk se convierte en una opción por mercado', () => {
  const event = polymarket.mapEvent(pmRaw[0]);
  assert.equal(event.platform, 'polymarket');
  assert.equal(event.options.length, 3);
  assert.equal(event.mutuallyExclusive, true);
  assert.deepEqual(event.options.map((o) => o.label), ['Gavin Newsom', 'JD Vance', 'Josh Shapiro']);

  // Precio crudo = punto medio del libro (0.44 / 0.46)
  assert.equal(event.options[0].price, 0.45);
  // Sin vig, las tres suman 1
  const total = event.options.reduce((acc, o) => acc + o.impliedProb, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(event.options[0].impliedProb < event.options[0].price, 'el devig debe recortar el precio crudo');
});

test('Polymarket: en un binario, la pata No se deriva por complemento del libro', () => {
  const event = polymarket.mapEvent(pmRaw[1]);
  assert.equal(event.options.length, 2);

  const [yes, no] = event.options;
  assert.equal(yes.label, 'Yes');
  assert.equal(yes.price, 0.63); // (0.62 + 0.64) / 2

  // Comprar "No" a X equivale a vender "Yes" a 1-X: bid/ask se invierten.
  assert.ok(Math.abs(no.bid - 0.36) < 1e-9);
  assert.ok(Math.abs(no.ask - 0.38) < 1e-9);
  assert.ok(Math.abs(yes.price + no.price - 1) < 1e-9);
});

test('Polymarket: parsea los campos que llegan como JSON dentro de un string', () => {
  const options = polymarket.optionsFromEvent(pmRaw[1]);
  assert.deepEqual(options.map((o) => o.label), ['Yes', 'No']);
  assert.equal(options[0].last, 0.63);
});

test('Kalshi: los centavos se convierten a probabilidad', () => {
  assert.equal(kalshi.centsToProb(45), 0.45);
  assert.equal(kalshi.centsToProb(0), null);
  assert.equal(kalshi.centsToProb(100), null);
  assert.equal(kalshi.centsToProb(null), null);
});

test('Kalshi: evento mutuamente excluyente con varios mercados', () => {
  const event = kalshi.mapEvent(kalshiRaw.events[0]);
  assert.equal(event.platform, 'robinhood_kalshi');
  assert.equal(event.platformLabel, 'Robinhood / Kalshi');
  assert.equal(event.options.length, 3);
  assert.equal(event.options[0].label, 'Gavin Newsom');
  assert.ok(Math.abs(event.options[0].price - 0.435) < 1e-9); // (42 + 45) / 200
  assert.ok(Math.abs(event.options.reduce((a, o) => a + o.impliedProb, 0) - 1) < 1e-9);
  assert.equal(event.closesAt, '2028-11-07T12:00:00.000Z');
});

test('Kalshi: un mercado único produce las dos patas Sí/No', () => {
  const event = kalshi.mapEvent(kalshiRaw.events[1]);
  assert.equal(event.options.length, 2);
  assert.ok(Math.abs(event.options[0].price - 0.615) < 1e-9);
  assert.ok(Math.abs(event.options[1].price - 0.385) < 1e-9);
});

test('Manifold: multi-opción usa las probabilidades de cada respuesta', () => {
  const event = manifold.mapMarket(manifoldRaw[0]);
  assert.equal(event.options.length, 3);
  assert.equal(event.credibility, 0.35, 'el dinero de juego debe pesar menos');
  assert.equal(event.options[0].label, 'Gavin Newsom');
  assert.ok(Math.abs(event.options[0].impliedProb - 0.46) < 1e-9);
});

test('Manifold: un binario se expande a Sí/No', () => {
  const event = manifold.mapMarket(manifoldRaw[1]);
  assert.deepEqual(event.options.map((o) => o.label), ['Sí', 'No']);
  assert.ok(Math.abs(event.options[0].price - 0.58) < 1e-9);
  assert.ok(Math.abs(event.options[1].price - 0.42) < 1e-9);
});

test('Los eventos sin opciones utilizables se descartan en vez de romper', () => {
  assert.equal(polymarket.mapEvent({ slug: 'x', title: 'x', markets: [] }), null);
  assert.equal(kalshi.mapEvent({ event_ticker: 'X', title: 'x', markets: [] }), null);
  assert.equal(manifold.mapMarket({ id: 'x', question: 'x', outcomeType: 'MULTIPLE_CHOICE' }), null);
});
