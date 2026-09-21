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

// Kalshi renombró sus campos de precio: de enteros en centavos (yes_bid) a
// decimales en dólares (yes_bid_dollars). Los fixtures de arriba cubren el
// formato viejo; estos, el nuevo.

test('Kalshi: lee los campos nuevos en dólares', () => {
  const event = kalshi.mapEvent({
    event_ticker: 'FED-26DEC',
    series_ticker: 'KXFED',
    title: '¿Baja tipos la Fed en diciembre?',
    mutually_exclusive: true,
    markets: [
      {
        ticker: 'FED-26DEC-Y',
        status: 'active',
        yes_sub_title: 'Sí',
        no_sub_title: 'No',
        yes_bid_dollars: 0.62,
        yes_ask_dollars: 0.64,
        no_bid_dollars: 0.36,
        no_ask_dollars: 0.38,
        last_price_dollars: 0.63,
        volume_fp: 1180000,
        liquidity_dollars: 340000,
        close_time: '2026-12-16T19:00:00Z',
      },
    ],
  });

  assert.ok(event, 'el evento no debería descartarse');
  assert.equal(event.options.length, 2);
  assert.ok(Math.abs(event.options[0].price - 0.63) < 1e-9, 'Sí = (0.62+0.64)/2');
  assert.ok(Math.abs(event.options[1].price - 0.37) < 1e-9, 'No = (0.36+0.38)/2');
  assert.equal(event.options[0].liquidity, 340000, 'liquidity_dollars ya viene en dólares');
});

test('Kalshi: priceOf prefiere dólares y cae a centavos', () => {
  assert.equal(kalshi.priceOf({ yes_bid_dollars: 0.45, yes_bid: 99 }, 'yes_bid'), 0.45);
  assert.equal(kalshi.priceOf({ yes_bid: 45 }, 'yes_bid'), 0.45);
  assert.equal(kalshi.priceOf({}, 'yes_bid'), null);
  // Un valor fuera de rango en cualquiera de las dos escalas se descarta en vez
  // de colarse como probabilidad imposible.
  assert.equal(kalshi.priceOf({ yes_bid_dollars: 45 }, 'yes_bid'), null);
  assert.equal(kalshi.priceOf({ yes_bid_dollars: 0 }, 'yes_bid'), null);
});

test('Kalshi: descarta las combinadas de varias patas', () => {
  const base = {
    ticker: 'KXMVE-X',
    status: 'active',
    yes_sub_title: 'yes Toronto,yes Detroit',
    yes_bid_dollars: 0.3,
    yes_ask_dollars: 0.32,
    close_time: '2026-12-16T19:00:00Z',
  };

  assert.equal(
    kalshi.mapEvent({ event_ticker: 'E', title: 'Combinada', markets: [{ ...base, mve_collection_ticker: 'KXMVECROSSCATEGORY-X' }] }),
    null,
    'una combinada no es una opción de un evento'
  );
  assert.equal(
    kalshi.mapEvent({ event_ticker: 'E', title: 'Combinada', markets: [{ ...base, mve_selected_legs: [{}, {}] }] }),
    null
  );
});
