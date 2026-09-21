'use strict';

// Casos tomados de una ejecución real contra las APIs: son los pares que el
// emparejamiento acertaba y, sobre todo, los que confundía. Sirven para que un
// retoque del umbral no vuelva a fusionar eventos que no tienen nada que ver.

const test = require('node:test');
const assert = require('node:assert/strict');

const { eventSimilarity, isGenericBinary, clusterEvents, canonicalizeOptions } = require('../src/match');
const { analyzeCluster } = require('../src/analyze');
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

// El año de resolución es el contrato, no un adorno del enunciado. Estos pares
// salieron de una ejecución real con puntuaciones por encima del umbral pese a
// referirse a comicios de años distintos.
const PARTIDOS = ['Democratic', 'Republican'];

test('mismo molde de pregunta pero años distintos NO se emparejan', () => {
  const score = eventSimilarity(
    multiple('polymarket', 'Which party will win the House in 2026?', PARTIDOS),
    multiple('robinhood_kalshi', 'Which party will win the 2032 Presidential Election?', PARTIDOS)
  );
  assert.equal(score, 0, 'años incompatibles deben descartarse de plano');
});

test('la Cámara de 2026 y la presidencia de 2028 NO se emparejan', () => {
  const score = eventSimilarity(
    multiple('polymarket', 'Which party will win the House in 2026?', PARTIDOS),
    multiple('manifold', 'Which political party wins the US presidency in 2028?', PARTIDOS)
  );
  assert.equal(score, 0);
});

test('un año mencionado de paso no rompe un emparejamiento válido', () => {
  // Basta con que compartan un año: el segundo título cita 2024 además de 2026.
  const score = eventSimilarity(
    binario('polymarket', 'Will China invade Taiwan by end of 2026?'),
    binario('manifold', 'After the 2024 elections, will China invade Taiwan by end of 2026?')
  );
  assert.ok(score >= UMBRAL, `debería emparejar, dio ${score.toFixed(3)}`);
});

test('si sólo un título cita un año, decide la similitud normal', () => {
  const score = eventSimilarity(
    multiple('polymarket', 'Prime Minister of Israel after the next election', ['Naftali Bennett', 'Yair Lapid']),
    multiple('robinhood_kalshi', 'Who will succeed Netanyahu as Prime Minister of Israel in 2027?', ['Naftali Bennett', 'Yair Lapid'])
  );
  assert.ok(score > 0, 'sin año en un lado no se aplica el descarte');
});

// Cada plataforma enumera su propio conjunto de candidatos: Polymarket llegó a
// listar 52 y Manifold 45 para las mismas presidenciales. Si la unión define el
// universo, la masa de probabilidad que sólo cotiza una se cuenta dos veces.
test('la plataforma ancla define el universo de opciones', () => {
  const ancla = multiple('polymarket', 'Presidential Election Winner 2028', [
    'JD Vance', 'Gavin Newsom', 'Josh Shapiro', 'Marco Rubio',
  ]);
  ancla.liquidity = 60285335;
  ancla.volume = 707304548;

  const secundaria = multiple('manifold', '2028 US Presidential Election winner?', [
    'JD Vance', 'Gavin Newsom', 'Other', 'Michelle Obama',
  ]);
  secundaria.liquidity = 159050;
  secundaria.volume = 1324708;

  const cluster = { events: [ancla, secundaria], anchor: ancla, matchScore: 0.8 };
  const { options, descartadas } = canonicalizeOptions(cluster);

  assert.equal(options.length, 4, 'el universo es el del ancla, no la unión');
  assert.equal(descartadas, 2, '"Other" y "Michelle Obama" no están en el ancla');

  const vance = options.find((o) => o.label === 'JD Vance');
  assert.equal(vance.quotes.length, 2, 'las opciones compartidas sí reciben ambas cotizaciones');

  const rubio = options.find((o) => o.label === 'Marco Rubio');
  assert.equal(rubio.quotes.length, 1, 'las que sólo tiene el ancla conservan su precio');
});

test('el consenso no se hunde al unir listas de distinto tamaño', () => {
  const ancla = multiple('polymarket', 'Presidential Election Winner 2028', [
    'JD Vance', 'Gavin Newsom', 'Josh Shapiro', 'Marco Rubio',
  ]);
  ancla.liquidity = 60285335;
  ancla.volume = 707304548;

  const secundaria = multiple('manifold', '2028 US Presidential Election winner?', [
    'JD Vance', 'Gavin Newsom', 'Other', 'Michelle Obama',
  ]);

  const solo = analyzeCluster({ events: [ancla], anchor: ancla, matchScore: 1 });
  const conAmbas = analyzeCluster({ events: [ancla, secundaria], anchor: ancla, matchScore: 0.8 });

  const pSolo = solo.options.find((o) => o.label === 'JD Vance').probability;
  const pAmbas = conAmbas.options.find((o) => o.label === 'JD Vance').probability;

  // Sumar una segunda fuente que opina parecido no puede desplomar el número:
  // antes bajaba un 30% sólo por contar dos veces la cola de cada lista.
  assert.ok(
    Math.abs(pSolo - pAmbas) < 0.05,
    `añadir una fuente movió el favorito de ${(pSolo * 100).toFixed(1)}% a ${(pAmbas * 100).toFixed(1)}%`
  );
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
