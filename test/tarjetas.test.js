'use strict';

// Tarjetas arrastrables: el orden que se guarda y el que se restaura.
//
// Lo que se puede probar sin navegador es justo lo que rompe en silencio: que
// un orden guardado se aplique, que una tarjeta NUEVA —añadida en una versión
// posterior a la que guardó el orden— no desaparezca, y que un localStorage
// que lanza no tumbe la página. Arrastrar con el ratón se comprueba en un
// navegador de verdad; eso no cabe aquí.

const test = require('node:test');
const assert = require('node:assert');

const T = require('../src/tarjetas');

// Un doble mínimo del DOM: sólo lo que el módulo toca de verdad.
function contenedorFalso(ids) {
  const hijos = ids.map((id) => ({ dataset: { tarjeta: id } }));
  const c = {
    hijos,
    querySelectorAll(sel) {
      assert.match(sel, /:scope > \[data-tarjeta\]/, `selector inesperado: ${sel}`);
      return c.hijos;
    },
    appendChild(n) {
      const i = c.hijos.indexOf(n);
      if (i >= 0) c.hijos.splice(i, 1);
      c.hijos.push(n);
    },
  };
  return c;
}

const almacenFalso = (inicial = {}) => {
  const datos = { ...inicial };
  return {
    getItem: (k) => (k in datos ? datos[k] : null),
    setItem: (k, v) => { datos[k] = String(v); },
    removeItem: (k) => { delete datos[k]; },
    _datos: datos,
  };
};

test.beforeEach(() => { globalThis.localStorage = almacenFalso(); });
test.after(() => { delete globalThis.localStorage; });

test('un orden guardado se aplica al cargar', () => {
  const c = contenedorFalso(['reloj', 'prediccion', 'ruptura', 'tendencia']);
  T.aplicarOrden(c, ['ruptura', 'reloj', 'tendencia', 'prediccion']);
  assert.deepEqual(T.ordenActual(c), ['ruptura', 'reloj', 'tendencia', 'prediccion']);
});

test('una tarjeta que no estaba en el orden guardado no se pierde', () => {
  // Pasa en cuanto se añade una tarjeta nueva: quien guardó el orden ayer no
  // la tenía. Hacerla desaparecer sería peor que cualquier orden.
  const c = contenedorFalso(['reloj', 'prediccion', 'ruptura', 'nueva']);
  T.aplicarOrden(c, ['ruptura', 'reloj', 'prediccion']);

  const orden = T.ordenActual(c);
  assert.equal(orden.length, 4, `se perdió alguna: ${orden.join(', ')}`);
  assert.ok(orden.includes('nueva'));
  assert.deepEqual(orden.slice(0, 3), ['ruptura', 'reloj', 'prediccion'], 'las conocidas mandan');
});

test('un orden con tarjetas que ya no existen no rompe nada', () => {
  const c = contenedorFalso(['reloj', 'ruptura']);
  T.aplicarOrden(c, ['borrada', 'ruptura', 'otra-borrada', 'reloj']);
  assert.deepEqual(T.ordenActual(c), ['ruptura', 'reloj']);
});

test('sin orden guardado no se toca nada', () => {
  const c = contenedorFalso(['a', 'b', 'c']);
  T.aplicarOrden(c, null);
  assert.deepEqual(T.ordenActual(c), ['a', 'b', 'c']);
});

test('el orden se guarda y se recupera', () => {
  T.guardarOrden('mtp.prueba', ['b', 'a']);
  assert.deepEqual(T.leerOrden('mtp.prueba'), ['b', 'a']);
});

test('un almacén corrupto o inaccesible no tumba la página', () => {
  // En modo privado localStorage lanza al escribir, y un valor a medias es
  // JSON inválido. Ni una cosa ni la otra puede impedir que la página cargue.
  globalThis.localStorage = { getItem: () => '{esto no es json', setItem() {}, removeItem() {} };
  assert.equal(T.leerOrden('x'), null);

  globalThis.localStorage = { getItem: () => '"una cadena, no una lista"', setItem() {}, removeItem() {} };
  assert.equal(T.leerOrden('x'), null, 'algo que no es una lista tampoco vale');

  globalThis.localStorage = {
    getItem() { throw new Error('bloqueado'); },
    setItem() { throw new Error('bloqueado'); },
    removeItem() {},
  };
  assert.equal(T.leerOrden('x'), null);
  assert.doesNotThrow(() => T.guardarOrden('x', ['a']));
});

test('activar sin contenedor no revienta', () => {
  // La página de predicciones no tiene panel lateral.
  assert.equal(T.activar({ contenedor: null, clave: 'x' }), null);
});
