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
