'use strict';

// La paginación falló en producción de la peor forma posible: trajo miles de
// eventos y los tiró todos porque la última página devolvió un 4xx. Las tres
// APIs cortan la paginación así al pasarse de su tope de offset, de modo que es
// el caso normal, no la excepción.

const test = require('node:test');
const assert = require('node:assert/strict');

const { paginate, classifyCategory } = require('../src/providers/base');

function paginaDe(n, offset) {
  return Array.from({ length: n }, (_, i) => ({ id: offset + i }));
}

test('una página que falla no tira las que ya se trajeron', async () => {
  const items = await paginate(
    async ({ offset }) => {
      // Polymarket devolvía 422 y Manifold 400 al pasarse del tope de offset.
      if (offset >= 300) throw new Error('HTTP 422 en /events?offset=300');
      return { batch: paginaDe(100, offset) };
    },
    { pageSize: 100, pauseMs: 0 }
  );

  assert.equal(items.length, 300, 'deben conservarse las tres páginas buenas');
  assert.match(items.note, /paginación detenida/);
  assert.match(items.note, /422/, 'la nota debe decir por qué se paró');
});

test('si falla la primera página no se inventa nada', async () => {
  const items = await paginate(
    async () => {
      throw new Error('HTTP 500');
    },
    { pageSize: 100, pauseMs: 0 }
  );

  assert.equal(items.length, 0);
  assert.match(items.note, /500/);
});

test('una página incompleta cierra la paginación por offset', async () => {
  let llamadas = 0;
  const items = await paginate(
    async ({ offset }) => {
      llamadas++;
      return { batch: paginaDe(offset === 0 ? 100 : 40, offset) };
    },
    { pageSize: 100, pauseMs: 0 }
  );

  assert.equal(items.length, 140);
  assert.equal(llamadas, 2, 'no se pide una página más tras una incompleta');
  assert.equal(items.note, undefined, 'terminar el catálogo no es una anomalía');
});

test('la paginación por cursor termina cuando deja de haber cursor', async () => {
  const cursores = ['a', 'b', null];
  let i = 0;
  const items = await paginate(
    async () => {
      const nextCursor = cursores[i++];
      return { batch: paginaDe(200, 0), nextCursor };
    },
    { pageSize: 200, pauseMs: 0 }
  );

  assert.equal(items.length, 600, 'tres páginas antes de agotarse el cursor');
});

test('un cursor repetido no provoca un bucle infinito', async () => {
  const items = await paginate(
    async () => ({ batch: paginaDe(200, 0), nextCursor: 'siempre-el-mismo' }),
    { pageSize: 200, pauseMs: 0, maxPages: 50 }
  );

  assert.equal(items.length, 400, 'se corta al repetirse el cursor');
});

test('el tope de páginas se anota, porque puede haber más contratos', async () => {
  const items = await paginate(
    async ({ offset }) => ({ batch: paginaDe(100, offset) }),
    { pageSize: 100, pauseMs: 0, maxPages: 3 }
  );

  assert.equal(items.length, 300);
  assert.match(items.note, /tope de 3 páginas/);
});

test('la taxonomía reparte los contratos por tema', () => {
  const casos = [
    ['deportes', 'Will the Chiefs win the Super Bowl?'],
    ['política', 'Presidential Election Winner 2028'],
    ['economía', 'How many Fed rate cuts in 2026?'],
    ['cripto', 'Will Bitcoin trade above 100k?'],
    ['geopolítica', 'Will China invade Taiwan by end of 2026?'],
    ['clima', 'Highest temperature in NYC tomorrow'],
    ['ciencia', 'When will all Millennium Prize Problems be solved?'],
    ['entretenimiento', 'Which film wins Best Picture at the Oscars?'],
    ['otros', 'Un enunciado sin ninguna palabra reconocible'],
  ];

  for (const [esperada, titulo] of casos) {
    assert.equal(classifyCategory(titulo), esperada, `"${titulo}"`);
  }
});

test('la categoría usa también las etiquetas de la plataforma', () => {
  // El título por sí solo no delata el tema; la etiqueta sí.
  assert.equal(classifyCategory('Gonzaga vs Baylor', 'basketball ncaa'), 'deportes');
  assert.equal(classifyCategory('Sin pistas', ''), 'otros');
});

// Hay eventos que la plataforma marca como excluyentes y no lo son: sus
// opciones son umbrales acumulados que se contienen unos a otros. Repartir
// probabilidad entre ellos, o buscarles arbitraje, produce cifras absurdas
// —sobre el catálogo real salía un "arbitraje" del 49.900%.
const { buildEvent } = require('../src/providers/base');
const { isNestedThresholds, pricesLookExclusive } = require('../src/normalize');

function eventoCon(labels, precios) {
  return buildEvent({
    platform: 'x',
    platformLabel: 'X',
    credibility: 1,
    id: 'e1',
    title: 'Un evento',
    mutuallyExclusive: true,
    options: labels.map((label, i) => ({ label, bid: precios[i] - 0.005, ask: precios[i] + 0.005 })),
  });
}

test('los umbrales acumulados no se tratan como alternativas', () => {
  // "Above 0.0%" incluye a "Above 0.3%": sumarlos no significa nada.
  const e = eventoCon(
    ['Above 0.0%', 'Above 0.1%', 'Above 0.2%', 'Above 0.3%'],
    [0.98, 0.91, 0.72, 0.35]
  );

  assert.equal(e.nestedThresholds, true);
  assert.equal(e.mutuallyExclusive, false, 'no se les puede repartir la probabilidad');
  assert.equal(e.overround, null);
  // Cada precio se conserva tal cual, que es lo que significa de verdad.
  assert.ok(Math.abs(e.options[0].impliedProb - 0.98) < 1e-9);
});

test('los tramos de verdad sí son alternativas', () => {
  // Sólo la primera etiqueta lleva comparador, porque marca el extremo.
  const e = eventoCon(['≤3.0%', '3.1%', '3.2%', '3.3%'], [0.3, 0.3, 0.25, 0.2]);

  assert.equal(e.nestedThresholds, false);
  assert.equal(e.mutuallyExclusive, true);
  const total = e.options.reduce((acc, o) => acc + o.impliedProb, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'aquí sí suman 100%');
});

test('unos precios que suman mucho más de 1 delatan opciones no excluyentes', () => {
  // Sin comparadores en las etiquetas: lo detecta la suma, que es la
  // comprobación difícil de engañar. Un creador de mercado se queda unos
  // puntos, nunca un 150%.
  const e = eventoCon(['Tramo A', 'Tramo B', 'Tramo C'], [0.9, 0.85, 0.8]);

  assert.equal(e.nestedThresholds, true);
  assert.equal(e.mutuallyExclusive, false);
});

test('unos precios que casi no suman nada también son sospechosos', () => {
  // Si todas las patas valen casi cero, la lista de opciones no cubre los
  // desenlaces: repartir el 100% entre ellas inventaría probabilidad.
  const e = eventoCon(['A', 'B', 'C'], [0.002, 0.002, 0.003]);
  assert.equal(e.mutuallyExclusive, false);
});

test('un reparto normal con su margen sigue siendo excluyente', () => {
  const e = eventoCon(['Ana', 'Luis', 'Marta'], [0.45, 0.38, 0.2]);
  assert.equal(e.nestedThresholds, false);
  assert.equal(e.mutuallyExclusive, true);
  assert.ok(Math.abs(e.overround - 0.03) < 1e-9);
});

test('isNestedThresholds distingue por la forma de las etiquetas', () => {
  assert.equal(isNestedThresholds(['Above 1', 'Above 2', 'Above 3']), true);
  assert.equal(isNestedThresholds(['≤3.0%', '3.1%', '3.2%']), false);
  assert.equal(isNestedThresholds(['51°F or below', '52-53°F', '54-55°F']), false);
  assert.equal(isNestedThresholds(['Gavin Newsom', 'JD Vance', 'Josh Shapiro']), false);
  // Con dos opciones no hay escalera que detectar.
  assert.equal(isNestedThresholds(['Above 1', 'Above 2']), false);
});

test('pricesLookExclusive acota por arriba y por abajo', () => {
  assert.equal(pricesLookExclusive([0.45, 0.38, 0.2]), true);
  assert.equal(pricesLookExclusive([0.98, 0.91, 0.72]), false);
  assert.equal(pricesLookExclusive([0.001, 0.001]), false);
  assert.equal(pricesLookExclusive([0.6]), true, 'una sola opción no dice nada');
});
