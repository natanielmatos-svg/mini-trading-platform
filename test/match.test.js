'use strict';

// Casos tomados de una ejecución real contra las APIs: son los pares que el
// emparejamiento acertaba y, sobre todo, los que confundía. Sirven para que un
// retoque del umbral no vuelva a fusionar eventos que no tienen nada que ver.

const test = require('node:test');
const assert = require('node:assert/strict');

const { eventSimilarity, isGenericBinary, clusterEvents } = require('../src/match');
const { canonicalLabelKey } = require('../src/normalize');

const UMBRAL = 0.5;

function binario(platform, title) {
  return {
    platform,
    platformLabel: platform,
    credibility: 1,
    title,
    options: [
      { label: 'Sí', key: 'yes', price: 0.5, impliedProb: 0.5, liquidity: 1000, volume: 1000 },
      { label: 'No', key: 'no', price: 0.5, impliedProb: 0.5, liquidity: 1000, volume: 1000 },
    ],
    liquidity: 1000,
    volume: 1000,
    closesAt: null,
    mutuallyExclusive: true,
  };
}

function multiple(platform, title, etiquetas) {
  return {
    platform,
    platformLabel: platform,
    credibility: 1,
    title,
    options: etiquetas.map((label) => ({
      label,
      key: canonicalLabelKey(label),
      price: 1 / etiquetas.length,
      impliedProb: 1 / etiquetas.length,
      liquidity: 1000,
      volume: 1000,
    })),
    liquidity: 1000,
    volume: 1000,
    closesAt: null,
    mutuallyExclusive: true,
  };
}

test('un mercado Sí/No se reconoce como binario genérico', () => {
  assert.equal(isGenericBinary(binario('x', 'Cualquier cosa?')), true);
  assert.equal(isGenericBinary(multiple('x', 'Quién gana?', ['Ana', 'Luis'])), false);
});

test('dos redacciones del mismo evento binario se emparejan', () => {
  const score = eventSimilarity(
    binario('polymarket', 'Will China invade Taiwan by end of 2026?'),
    binario('manifold', 'Will China attempt to invade Taiwan by the end of 2026?')
  );
  assert.ok(score >= UMBRAL, `debería emparejar, dio ${score.toFixed(3)}`);
});

// El fallo que motivó el cambio: entre binarios, el conjunto {Sí, No} es
// idéntico siempre y regalaba 0,35 a cualquier pareja.
test('dos binarios que sólo comparten el año NO se emparejan', () => {
  const score = eventSimilarity(
    binario('polymarket', 'Hantavirus pandemic in 2026?'),
    binario('manifold', 'US recession in 2026?')
  );
  assert.ok(score < UMBRAL, `no deberían emparejarse, dio ${score.toFixed(3)}`);
});

test('dos binarios sobre invasiones distintas NO se emparejan', () => {
  const score = eventSimilarity(
    binario('polymarket', 'Will the U.S. invade Iran before 2027?'),
    binario('manifold', 'Will China attempt to invade Taiwan by the end of 2026?')
  );
  assert.ok(score < UMBRAL, `no deberían emparejarse, dio ${score.toFixed(3)}`);
});

test('dos binarios sobre Irán pero con desenlaces distintos NO se emparejan', () => {
  const score = eventSimilarity(
    binario('polymarket', 'Will the U.S. invade Iran before 2027?'),
    binario('manifold', "Will Iran's regime fall in 2026?")
  );
  assert.ok(score < UMBRAL, `no deberían emparejarse, dio ${score.toFixed(3)}`);
});

test('los eventos de varias opciones se siguen emparejando por sus candidatos', () => {
  const candidatos = ['Gavin Newsom', 'JD Vance', 'Josh Shapiro'];
  const score = eventSimilarity(
    multiple('polymarket', 'Presidential Election Winner 2028', candidatos),
    multiple('manifold', '2028 US Presidential Election winner?', candidatos)
  );
  assert.ok(score >= UMBRAL, `debería emparejar, dio ${score.toFixed(3)}`);
});

test('la nominación demócrata se empareja pese a la redacción distinta', () => {
  const candidatos = ['Alexandria Ocasio-Cortez', 'Jon Ossoff', 'Gavin Newsom'];
  const score = eventSimilarity(
    multiple('polymarket', 'Democratic Presidential Nominee 2028', candidatos),
    multiple('manifold', 'Who will be the Democratic nominee for president in 2028?', candidatos)
  );
  assert.ok(score >= UMBRAL, `debería emparejar, dio ${score.toFixed(3)}`);
});

test('sobre el lote completo, sólo se agrupa lo que de verdad coincide', () => {
  const candidatos = ['Gavin Newsom', 'JD Vance', 'Josh Shapiro'];
  const eventos = [
    binario('polymarket', 'Will China invade Taiwan by end of 2026?'),
    binario('polymarket', 'Hantavirus pandemic in 2026?'),
    binario('polymarket', 'Will the U.S. invade Iran before 2027?'),
    multiple('polymarket', 'Presidential Election Winner 2028', candidatos),
    binario('manifold', 'Will China attempt to invade Taiwan by the end of 2026?'),
    binario('manifold', 'US recession in 2026?'),
    binario('manifold', "Will Iran's regime fall in 2026?"),
    multiple('manifold', '2028 US Presidential Election winner?', candidatos),
  ];

  const clusters = clusterEvents(eventos);
  const cruzados = clusters.filter((c) => c.events.length > 1);

  // Exactamente dos parejas legítimas: Taiwán y las presidenciales de 2028.
  assert.equal(cruzados.length, 2, 'deberían agruparse dos parejas, ni más ni menos');
  for (const c of cruzados) {
    const titulos = c.events.map((e) => e.title.toLowerCase());
    const esTaiwan = titulos.every((t) => t.includes('taiwan'));
    const esEleccion = titulos.every((t) => t.includes('2028'));
    assert.ok(esTaiwan || esEleccion, `grupo inesperado: ${titulos.join(' | ')}`);
  }
});
