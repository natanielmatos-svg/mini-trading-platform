'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadDemoEvents } = require('../src/api');
const { clusterEvents, canonicalizeOptions } = require('../src/match');
const { analyzeEvents, combineQuotes, findArbitrage, matchesQuery } = require('../src/analyze');

const { events } = loadDemoEvents();

function findByTitle(analyses, needle) {
  return analyses.find((a) => a.title.toLowerCase().includes(needle));
}

test('los datos de ejemplo cargan las tres plataformas', () => {
  const platforms = new Set(events.map((e) => e.platform));
  assert.deepEqual([...platforms].sort(), ['manifold', 'polymarket', 'robinhood_kalshi']);
});

test('el mismo evento en tres plataformas se agrupa en un solo cluster', () => {
  const clusters = clusterEvents(events);
  const election = clusters.find((c) => c.events.length === 3);

  assert.ok(election, 'las tres versiones de la elección deberían quedar juntas');
  assert.deepEqual(
    election.events.map((e) => e.platform).sort(),
    ['manifold', 'polymarket', 'robinhood_kalshi']
  );
});

test('un evento que sólo cotiza una plataforma no se mezcla con otros', () => {
  const clusters = clusterEvents(events);
  const rain = clusters.find((c) => c.anchor.title.includes('rain in Miami'));
  assert.ok(rain);
  assert.equal(rain.events.length, 1);
});

test('las opciones equivalentes se unifican entre plataformas', () => {
  const clusters = clusterEvents(events);
  const election = clusters.find((c) => c.events.length === 3);
  const { options: groups } = canonicalizeOptions(election);

  assert.equal(groups.length, 3, 'tres candidatos, no nueve opciones sueltas');
  for (const group of groups) {
    assert.equal(group.quotes.length, 3, `"${group.label}" debería tener cotización de las tres`);
  }
});

test('el analizador elige la opción más probable del evento', () => {
  const analyses = analyzeEvents(events);
  const election = findByTitle(analyses, 'election');

  assert.ok(election);
  assert.equal(election.crossPlatform, true);
  assert.equal(election.mostLikely.label, 'Gavin Newsom');
  assert.equal(election.options[0].label, 'Gavin Newsom');
  assert.ok(election.mostLikely.probability > election.options[1].probability);
  assert.ok(election.mostLikely.margin > 0);
});

test('en un evento excluyente las probabilidades del consenso suman 100%', () => {
  const analyses = analyzeEvents(events);
  const election = findByTitle(analyses, 'election');
  const total = election.options.reduce((acc, o) => acc + o.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `suman ${total}`);
});

test('el consenso queda dentro del rango de las plataformas', () => {
  const analyses = analyzeEvents(events);
  for (const analysis of analyses) {
    for (const option of analysis.options) {
      if (!option.range) continue;
      // Tras el devig del consenso puede desplazarse un poco, pero no salirse.
      assert.ok(
        option.probability >= option.range.min - 0.05 &&
        option.probability <= option.range.max + 0.05,
        `${analysis.title} / ${option.label}: ${option.probability} fuera de [${option.range.min}, ${option.range.max}]`
      );
    }
  }
});

test('varias plataformas de acuerdo dan más confianza que una sola fuente', () => {
  const analyses = analyzeEvents(events);
  const election = findByTitle(analyses, 'election');
  const rain = findByTitle(analyses, 'rain in miami');

  assert.ok(election.confidence > rain.confidence);
  assert.ok(rain.flags.some((f) => f.code === 'single_source'));
});

test('la opción con más liquidez arrastra más el consenso', () => {
  const quotes = [
    {
      platform: 'grande',
      credibility: 1,
      option: { impliedProb: 0.7, liquidity: 2000000, volume: 5000000, spread: 0.01 },
    },
    {
      platform: 'pequeña',
      credibility: 1,
      option: { impliedProb: 0.4, liquidity: 500, volume: 900, spread: 0.01 },
    },
  ];

  const { probability } = combineQuotes(quotes);
  assert.ok(probability > 0.4 && probability < 0.7, 'debe quedar entre ambas');
  assert.ok(probability > 0.6, `debería acercarse al mercado profundo, dio ${probability}`);
});

test('un spread ancho reduce el peso de esa cotización', () => {
  const base = { impliedProb: 0.8, liquidity: 10000, volume: 10000 };
  const tight = combineQuotes([
    { credibility: 1, option: { ...base, spread: 0.005 } },
    { credibility: 1, option: { impliedProb: 0.2, liquidity: 10000, volume: 10000, spread: 0.005 } },
  ]);
  const wide = combineQuotes([
    { credibility: 1, option: { ...base, spread: 0.2 } },
    { credibility: 1, option: { impliedProb: 0.2, liquidity: 10000, volume: 10000, spread: 0.005 } },
  ]);

  assert.ok(Math.abs(tight.probability - 0.5) < 1e-9, 'pesos iguales -> 50%');
  assert.ok(wide.probability < tight.probability, 'el lado con spread ancho debe pesar menos');
});

// El arbitraje sólo cuenta dentro de una misma plataforma. Comprar cada pata
// donde esté más barata entre varias parece más rentable y no lo es: son
// contratos distintos que no tienen por qué liquidar igual.
// price es el medio crudo, que mide cuánta probabilidad cubren las opciones;
// ask es a lo que se compraría. Un libro cruzado tiene el ask por debajo.
function opcion(label, cotizaciones) {
  return {
    label,
    platforms: cotizaciones.map(([platform, ask, price]) => ({
      platform,
      platformLabel: platform,
      ask,
      price: price === undefined ? ask : price,
    })),
  };
}

test('findArbitrage detecta comprar todas las patas por menos de 1 en una plataforma', () => {
  // Medios que suman 1 (la lista cubre todo) y asks que suman 0,95.
  const options = [
    opcion('A', [['x', 0.45, 0.45]]),
    opcion('B', [['x', 0.4, 0.4]]),
    opcion('C', [['x', 0.1, 0.15]]),
  ];

  const arb = findArbitrage(options, true);
  assert.ok(arb);
  assert.equal(arb.platform, 'x');
  assert.ok(Math.abs(arb.cost - 0.95) < 1e-9);
  assert.ok(Math.abs(arb.profit - 0.05) < 1e-9);
  assert.equal(arb.legs.length, 3);

  // Sin margen suficiente, o si el evento no es excluyente, no hay arbitraje.
  assert.equal(findArbitrage([opcion('A', [['x', 0.6, 0.6]]), opcion('B', [['x', 0.45, 0.4]])], true), null);
  assert.equal(findArbitrage(options, false), null);
});

test('repartir las patas entre plataformas NO es arbitraje', () => {
  // Cada pata más barata en un sitio distinto suma 0,95, pero no hay ninguna
  // plataforma donde se puedan comprar todas: es la diferencia entre dos
  // mercados que pueden resolver distinto, no un beneficio asegurado.
  const options = [
    opcion('A', [['x', 0.45], ['y', 0.52]]),
    opcion('B', [['x', 0.47], ['y', 0.4]]),
    opcion('C', [['y', 0.1]]),
  ];

  assert.equal(findArbitrage(options, true), null);
});

test('una plataforma a la que le falta una pata no cuenta', () => {
  const options = [
    opcion('A', [['x', 0.3]]),
    opcion('B', [['x', 0.3]]),
    opcion('C', [['y', 0.2]]), // x no cotiza esta opción
  ];

  assert.equal(findArbitrage(options, true), null, 'sin cubrir todos los desenlaces no hay arbitraje');
});

test('la búsqueda filtra por título y por nombre de opción', () => {
  const election = events.find((e) => e.platform === 'polymarket' && e.options.length === 3);
  assert.equal(matchesQuery(election, 'election'), true);
  assert.equal(matchesQuery(election, 'newsom'), true, 'debe buscar también en las opciones');
  assert.equal(matchesQuery(election, 'bitcoin'), false);
  assert.equal(matchesQuery(election, ''), true);

  // Los tres mercados de la Fed del ejemplo son el mismo evento, pero el de
  // Polymarket está redactado tan distinto ("decreases interest rates" frente a
  // "cut rates") que no llega al umbral que exigimos a los binarios. Es el
  // precio de rechazar los falsos positivos, que en esa franja puntuaban igual.
  const filtered = analyzeEvents(events, { query: 'fed' });
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((f) => f.title.toLowerCase().includes('fed')));
});

test('el veredicto describe la opción ganadora en texto', () => {
  const analyses = analyzeEvents(events);
  const election = findByTitle(analyses, 'election');
  assert.match(election.verdict.text, /Gavin Newsom/);
  assert.match(election.verdict.text, /%/);
  assert.ok(['alta', 'media', 'baja'].includes(election.verdict.confidenceLabel));
});

// Confianza y margen responden a preguntas distintas. Con 1,2 pts de ventaja no
// hay favorito, por muy fiables que sean los datos, y el veredicto debe decirlo
// en vez de dejar que "confianza alta" se lea como "hay ganador".
test('un margen mínimo se presenta como empate, no como favorito', () => {
  const { analyzeCluster } = require('../src/analyze');

  const construir = (probabilidades) => {
    const evento = {
      platform: 'polymarket',
      platformLabel: 'Polymarket',
      credibility: 1,
      title: 'Nominación demócrata 2028',
      url: '',
      closesAt: null,
      mutuallyExclusive: true,
      liquidity: 5e6,
      volume: 5e7,
      options: probabilidades.map(([label, p]) => ({
        label,
        key: label.toLowerCase(),
        price: p,
        impliedProb: p,
        bid: p - 0.005,
        ask: p + 0.005,
        spread: 0.01,
        priceSource: 'book',
        liquidity: 5e5,
        volume: 5e6,
        url: '',
      })),
    };
    return analyzeCluster({ events: [evento], anchor: evento, matchScore: 1 });
  };

  const empate = construir([['AOC', 0.35], ['Jon Ossoff', 0.34], ['Otro nombre', 0.31]]);
  assert.equal(empate.verdict.decisive, false);
  assert.match(empate.verdict.text, /Empate técnico/);
  assert.match(empate.verdict.text, /Jon Ossoff/, 'debe nombrar a los dos empatados');
  assert.ok(empate.flags.some((f) => f.code === 'too_close'));

  const claro = construir([['AOC', 0.6], ['Jon Ossoff', 0.25], ['Otro nombre', 0.15]]);
  assert.equal(claro.verdict.decisive, true);
  assert.match(claro.verdict.text, /es la opción más probable/);
});

test('el ranking prioriza los eventos contrastados entre plataformas', () => {
  const analyses = analyzeEvents(events);
  assert.ok(analyses.length >= 3);
  assert.equal(analyses[0].crossPlatform, true);
});

// "Other" agrupa a todos los demás: es información útil, pero responder "lo más
// probable es Otro" no contesta la pregunta que hace la app.
test('un cajón de sastre nunca encabeza el veredicto', () => {
  const { analyzeCluster } = require('../src/analyze');

  const evento = {
    platform: 'manifold',
    platformLabel: 'Manifold',
    credibility: 1,
    title: '¿Quién gana en 2028?',
    url: '',
    closesAt: null,
    mutuallyExclusive: true,
    liquidity: 1e6,
    volume: 1e6,
    options: [
      ['Other', 0.5],
      ['JD Vance', 0.3],
      ['Alexandria Ocasio-Cortez', 0.2],
    ].map(([label, p]) => ({
      label,
      key: label.toLowerCase(),
      price: p,
      impliedProb: p,
      bid: p - 0.01,
      ask: p + 0.01,
      spread: 0.02,
      priceSource: 'book',
      liquidity: 1e5,
      volume: 1e5,
      url: '',
    })),
  };

  const analysis = analyzeCluster({ events: [evento], anchor: evento, matchScore: 1 });

  assert.equal(analysis.mostLikely.label, 'JD Vance', 'debe ganar la opción real, no el cajón');
  assert.equal(analysis.catchAll.label, 'Other', 'pero el cajón se sigue reportando');
  assert.ok(analysis.catchAll.probability > analysis.mostLikely.probability);
  // Y se avisa de que el mercado apunta fuera de la lista.
  assert.ok(analysis.flags.some((f) => f.code === 'wide_field'));
  // Sigue apareciendo en la lista de opciones: no se oculta información.
  assert.ok(analysis.options.some((o) => o.label === 'Other' && o.catchAll === true));
});

// El fallo que mantenía 345 "arbitrajes" sobre el catálogo real: las opciones
// sin precio válido se descartan antes de llegar aquí, así que un evento con 30
// candidatos del que sólo cotizan 12 sumaba 0,86 y parecía un 14% regalado. El
// 14% que falta está en los 18 candidatos descartados.
function opcionConPrecio(label, platform, price, ask) {
  return {
    label,
    platforms: [{ platform, platformLabel: platform, price, ask }],
  };
}

test('una lista de opciones incompleta no es arbitraje', () => {
  // Tres candidatos de un mercado que tenía muchos más: los precios medios
  // suman 0,60, así que el 40% restante vive en los que no llegaron.
  const options = [
    opcionConPrecio('Ana', 'x', 0.25, 0.26),
    opcionConPrecio('Luis', 'x', 0.20, 0.21),
    opcionConPrecio('Marta', 'x', 0.15, 0.16),
  ];

  assert.equal(findArbitrage(options, true), null, 'sólo cubren el 60% del espacio');
});

test('con las opciones completas y el libro cruzado sí hay arbitraje', () => {
  // Medios que suman 1 —la lista cubre el espacio entero— y asks por debajo:
  // el libro está cruzado y comprarlo todo cuesta 94¢ para cobrar 100¢.
  const options = [
    opcionConPrecio('Ana', 'x', 0.50, 0.48),
    opcionConPrecio('Luis', 'x', 0.30, 0.28),
    opcionConPrecio('Marta', 'x', 0.20, 0.18),
  ];

  const arb = findArbitrage(options, true);
  assert.ok(arb, 'cobertura completa y asks sumando 0,94');
  assert.ok(Math.abs(arb.coverage - 1) < 1e-9);
  assert.ok(Math.abs(arb.cost - 0.94) < 1e-9);
});

test('cobertura completa pero sin margen suficiente tampoco cuenta', () => {
  const options = [
    opcionConPrecio('Ana', 'x', 0.50, 0.52),
    opcionConPrecio('Luis', 'x', 0.30, 0.32),
    opcionConPrecio('Marta', 'x', 0.20, 0.22),
  ];

  assert.equal(findArbitrage(options, true), null, 'los asks suman 1,06');
});
