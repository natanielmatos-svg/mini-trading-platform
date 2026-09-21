'use strict';

// El registro es lo que convierte la app en algo que acumula evidencia en vez
// de sólo enseñar la foto del momento. Si anota mal, las semanas de espera no
// sirven de nada, así que conviene fijarlo con tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Cada ejecución usa su propio directorio: el registro es un fichero que se
// acumula, y un test no puede depender de lo que dejó el anterior.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
process.env.LEDGER_DIR = tmp;

const { registrar, leer, resumen, extraerSenales } = require('../src/ledger');

function analisisCon(platforms, extra = {}) {
  return {
    id: 'polymarket:evento',
    title: 'Un evento cualquiera',
    url: 'https://ejemplo',
    category: 'política',
    closesAt: '2030-01-01T00:00:00Z',
    matchScore: 0.8,
    crossPlatform: true,
    arbitrage: null,
    options: [{ label: 'Sí', key: 'yes', probability: 0.5, platforms }],
    ...extra,
  };
}

const CARA = { platform: 'robinhood_kalshi', platformLabel: 'Robinhood / Kalshi', impliedProb: 0.62, ask: 0.63, bid: 0.61, liquidity: 1e5 };
const BARATA = { platform: 'polymarket', platformLabel: 'Polymarket', impliedProb: 0.50, ask: 0.51, bid: 0.49, liquidity: 4e5 };
const JUEGO = { platform: 'manifold', platformLabel: 'Manifold', impliedProb: 0.20, ask: 0.21, bid: 0.19, liquidity: 900 };

test('anota una divergencia entre plataformas de dinero real', () => {
  const senales = extraerSenales(analisisCon([BARATA, CARA]), '2026-01-01T00:00:00Z');

  assert.equal(senales.length, 1);
  const s = senales[0];
  assert.equal(s.tipo, 'divergencia');
  assert.ok(Math.abs(s.divergencia - 0.12) < 1e-9);
  // Queda anotado dónde se compraba y a cuánto, que es lo que permitirá
  // comprobar después si el precio estaba de verdad disponible.
  assert.equal(s.comprarEn, 'Polymarket');
  assert.equal(s.comprarA, 0.51);
  assert.equal(s.venderEn, 'Robinhood / Kalshi');
  assert.equal(s.venderA, 0.61);
  assert.equal(s.resuelto, null, 'el resultado se rellena cuando el evento cierre');
});

test('una divergencia pequeña no se anota', () => {
  const casi = { ...CARA, impliedProb: 0.52 };
  assert.equal(extraerSenales(analisisCon([BARATA, casi]), 'ahora').length, 0);
});

test('Manifold no cuenta para la divergencia: es dinero de juego', () => {
  // Sólo Polymarket y Manifold: aunque discrepan 30 pts, no hay dos
  // plataformas de dinero real que comparar.
  const senales = extraerSenales(analisisCon([BARATA, JUEGO]), 'ahora');
  assert.equal(senales.length, 0);
});

test('con tres plataformas, la divergencia se mide sólo entre las reales', () => {
  const senales = extraerSenales(analisisCon([BARATA, CARA, JUEGO]), 'ahora');
  assert.equal(senales.length, 1);
  // 0,62 - 0,50, no 0,62 - 0,20.
  assert.ok(Math.abs(senales[0].divergencia - 0.12) < 1e-9);
});

test('el arbitraje se anota con su cobertura', () => {
  const analysis = analisisCon([BARATA, CARA], {
    arbitrage: {
      platformLabel: 'Polymarket',
      cost: 0.94,
      coverage: 1,
      returnPct: 0.0638,
      legs: [{}, {}, {}],
    },
  });

  const senales = extraerSenales(analysis, 'ahora');
  const arb = senales.find((s) => s.tipo === 'arbitraje');
  assert.ok(arb);
  assert.equal(arb.coste, 0.94);
  assert.equal(arb.cobertura, 1);
  assert.equal(arb.patas, 3);
});

test('la misma señal no se anota dos veces', () => {
  const analysis = analisisCon([BARATA, CARA]);

  const primera = registrar([analysis]);
  assert.equal(primera.nuevas, 1);

  // El catálogo se refresca cada cinco minutos: si la divergencia sigue ahí,
  // no es una oportunidad nueva.
  const segunda = registrar([analysis]);
  assert.equal(segunda.nuevas, 0);
  assert.equal(segunda.total, 1);

  assert.equal(leer().length, 1);
});

test('el resumen cuenta por tipo y por categoría', () => {
  const r = resumen();
  assert.equal(r.total, 1);
  assert.equal(r.porTipo.divergencia, 1);
  assert.equal(r.porCategoria['política'], 1);
  assert.ok(Math.abs(r.divergenciaMedia - 0.12) < 1e-9);
});

test('una línea corrupta no invalida el resto del registro', () => {
  const fichero = path.join(tmp, 'oportunidades.jsonl');
  fs.appendFileSync(fichero, '{esto no es json\n');

  // Un corte de luz a mitad de escritura pierde la última línea, no el
  // histórico entero.
  const registros = leer();
  assert.equal(registros.length, 1);
});
