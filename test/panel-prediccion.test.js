'use strict';

// La cuenta atrás de la tabla de predicción.
//
// Lo que se prueba aquí es lo que no se ve al mirar la pantalla un segundo:
// que `tick` toque SÓLO el número y deje en pie el resto de la celda —el
// "de 1m" que dice con qué velas se calculó el plazo—, que la fila se marque
// cuando el plazo vence, y que se desmarque si vuelve a haber futuro, porque
// al refrescar el panel las filas se reutilizan.

const test = require('node:test');
const assert = require('node:assert');

const P = require('../src/panel-prediccion');

// Un doble del DOM con lo justo: un nodo de texto que `tick` reescribe, un
// hermano que NO debe tocar, y la fila con sus clases.
function celda(vence, { sufijo = null } = {}) {
  const texto = { nodeValue: 'x' };
  const clases = new Set();
  const fila = {
    classList: {
      add: (c) => clases.add(c),
      remove: (c) => clases.delete(c),
      has: (c) => clases.has(c),
    },
  };
  return {
    dataset: { vence: String(vence) },
    childNodes: sufijo ? [texto, sufijo] : [texto],
    closest: () => fila,
    _texto: texto,
    _fila: fila,
    _clases: clases,
  };
}

const contenedorDe = (celdas) => ({ querySelectorAll: () => celdas });

test('la cuenta atrás baja con el reloj', () => {
  const ahora = 1_000_000;
  const c = celda(ahora + 95_000);
  P.tick(contenedorDe([c]), ahora);
  assert.equal(c._texto.nodeValue, '01:35');

  P.tick(contenedorDe([c]), ahora + 5_000);
  assert.equal(c._texto.nodeValue, '01:30', 'cinco segundos después faltan cinco menos');
});

test('un plazo de más de una hora se lee con horas', () => {
  const ahora = 0;
  const c = celda(4 * 3600e3 + 61_000);
  P.tick(contenedorDe([c]), ahora);
  assert.equal(c._texto.nodeValue, '4:01:01');
});

test('al vencer, la fila se marca y el texto lo dice', () => {
  const ahora = 500;
  const c = celda(ahora - 1);
  P.tick(contenedorDe([c]), ahora);
  assert.equal(c._texto.nodeValue, 'vencida');
  assert.ok(c._clases.has('vencida'), 'la fila tiene que quedar marcada');
});

test('una fila reutilizada deja de estar vencida', () => {
  // El panel se repinta cada minuto con horizontes nuevos: si la marca no se
  // quitara, una fila caducada seguiría en gris para siempre.
  const c = celda(0);
  P.tick(contenedorDe([c]), 1_000);
  assert.ok(c._clases.has('vencida'));

  c.dataset.vence = String(60_000);
  P.tick(contenedorDe([c]), 1_000);
  assert.ok(!c._clases.has('vencida'), 'volvió a haber futuro');
  assert.equal(c._texto.nodeValue, '00:59');
});

test('tick no borra el resto de la celda', () => {
  // La celda lleva, además del número, un "de 1m" que dice con qué velas se
  // calculó. Reescribir innerHTML lo perdería; por eso se toca el nodo.
  const sufijo = { nodeValue: ' de 1m' };
  const c = celda(30_000, { sufijo });
  P.tick(contenedorDe([c]), 0);
  assert.equal(c._texto.nodeValue, '00:30');
  assert.equal(c.childNodes[1], sufijo, 'el sufijo sigue ahí');
  assert.equal(sufijo.nodeValue, ' de 1m', 'y sin tocar');
});

test('tick sin contenedor no revienta', () => {
  assert.doesNotThrow(() => P.tick(null));
});

test('cuantoFalta prefiere el ms del servidor a los bloques del gráfico', () => {
  // Los plazos cortos se calculan con velas de un minuto aunque el gráfico
  // esté en 1h: sin el `ms`, "5 bloques" se leería como cinco horas.
  assert.equal(P.cuantoFalta({ ms: 300e3, bloques: 5 }, P.MS['1h']), 300e3);
  assert.equal(P.cuantoFalta({ bloques: 4 }, P.MS['1h']), 4 * 3600e3, 'sin ms, bloques por paso');
});
