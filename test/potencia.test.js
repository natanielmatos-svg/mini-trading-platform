'use strict';

// ¿Cuántos contratos hacen falta para saber si hay ventaja?
//
// Lo que estas pruebas fijan es sobre todo lo que el módulo NO debe permitir:
// dar por concluyente una muestra que cruza el equilibrio, devolver intervalos
// fuera de [0,1], o sugerir que con datos suficientes se demuestra cualquier
// cosa.

const test = require('node:test');
const assert = require('node:assert');

const P = require('../src/potencia');

// --- El punto de equilibrio -------------------------------------------------

test('el equilibrio es lo que cuesta el contrato, precio más comisión', () => {
  const e = P.equilibrio(0.5);
  assert.equal(e.comision, 0.02, '0,07 × 0,5 × 0,5 = 0,0175 -> 2¢ al redondear hacia arriba');
  assert.equal(e.acierto, 0.52);

  // La comisión es máxima justo en 50¢, que es donde están los contratos
  // interesantes: el equilibrio se aleja más del precio ahí que en los extremos.
  const margen = (p) => P.equilibrio(p).acierto - p;
  assert.ok(margen(0.5) >= margen(0.2));
  assert.ok(margen(0.5) >= margen(0.9));
});

test('un precio imposible no tiene equilibrio', () => {
  for (const malo of [0, 1, -0.5, 1.5, NaN]) assert.equal(P.equilibrio(malo), null, String(malo));
});

// --- El intervalo -----------------------------------------------------------

test('el intervalo nunca se sale de lo posible', () => {
  // Es la razón de usar Wilson y no Wald: con 0 de 10, Wald da un intervalo de
  // anchura cero, y con 10 de 10 se sale por arriba. Las dos cosas mienten
  // justo donde más daño hace, que es con muestras cortas.
  for (const [a, n] of [[0, 10], [10, 10], [1, 3], [0, 1]]) {
    const i = P.intervalo(a, n);
    assert.ok(i.bajo >= 0 && i.alto <= 1, `${a}/${n} -> [${i.bajo}, ${i.alto}]`);
    assert.ok(i.bajo < i.alto, `${a}/${n} tiene anchura`);
  }
});

test('más muestra, intervalo más estrecho', () => {
  const ancho = (n) => { const i = P.intervalo(Math.round(0.647 * n), n); return i.alto - i.bajo; };
  assert.ok(ancho(200) < ancho(50));
  assert.ok(ancho(50) < ancho(17));
});

test('los 17 contratos medidos no distinguen nada', () => {
  // El caso real: 11 de 17 parece un 65% estupendo, y el intervalo va del 41%
  // al 83% con el equilibrio en el 52% justo en medio.
  const i = P.intervalo(11, 17);
  assert.ok(Math.abs(i.observado - 0.647) < 0.001);
  assert.ok(i.bajo < 0.52 && i.alto > 0.52, 'el equilibrio cae dentro del intervalo');
});

test('una muestra imposible no devuelve un intervalo', () => {
  assert.equal(P.intervalo(5, 0), null);
  assert.equal(P.intervalo(11, 10), null, 'más aciertos que casos');
  assert.equal(P.intervalo(-1, 10), null);
});

// --- El tamaño de muestra ---------------------------------------------------

test('cuanto menor es la ventaja, más contratos hacen falta', () => {
  const n = (a) => P.contratosNecesarios({ acierto: a, equilibrio: 0.52 });
  const serie = [0.647, 0.60, 0.58, 0.56, 0.54].map(n);
  for (let i = 1; i < serie.length; i++) {
    assert.ok(serie[i] > serie[i - 1], `${serie[i]} debería ser más que ${serie[i - 1]}`);
  }
  // Y la escala importa: media ventaja no cuesta el doble, cuesta cuatro veces.
  assert.ok(n(0.56) > 4 * n(0.647), `${n(0.56)} frente a ${n(0.647)}`);
});

test('sin ventaja no hay tamaño de muestra que valga', () => {
  // Devolver un número enorme invitaría a creer que con datos suficientes se
  // demuestra cualquier cosa. No hay nada que detectar.
  assert.equal(P.contratosNecesarios({ acierto: 0.52, equilibrio: 0.52 }), null);
  assert.equal(P.contratosNecesarios({ acierto: 1.5, equilibrio: 0.52 }), null);
  assert.equal(P.contratosNecesarios({}), null);
});

test('más exigencia, más contratos', () => {
  const base = P.contratosNecesarios({ acierto: 0.58, equilibrio: 0.52 });
  assert.ok(P.contratosNecesarios({ acierto: 0.58, equilibrio: 0.52, confianza: 0.99 }) > base);
  assert.ok(P.contratosNecesarios({ acierto: 0.58, equilibrio: 0.52, potencia: 0.95 }) > base);
});

// --- El diagnóstico ---------------------------------------------------------

test('mientras el intervalo cruce el equilibrio, no se concluye nada', () => {
  const d = P.diagnostico({ aciertos: 11, casos: 17 });
  assert.equal(d.concluyente, false);
  assert.match(d.veredicto, /no concluye nada/);
});

test('una muestra grande y buena sí concluye, y lo dice', () => {
  const d = P.diagnostico({ aciertos: 388, casos: 600 });
  assert.equal(d.concluyente, true);
  assert.match(d.veredicto, /excluye perder/);
  assert.ok(d.intervalo.bajo > d.equilibrio.acierto);
});

test('una muestra grande y mala también concluye, en el otro sentido', () => {
  // Importa tanto como la anterior: saber que NO hay ventaja ahorra el dinero
  // que se iba a perder averiguándolo contrato a contrato.
  const d = P.diagnostico({ aciertos: 240, casos: 600 });
  assert.equal(d.concluyente, true);
  assert.match(d.veredicto, /excluye ganar/);
});

test('la tasa medida se marca como tal, para no planificar con ella', () => {
  // Es la más optimista que hay: sale de una muestra corta y suele elegirse
  // después de mirar los datos. Planificar con ella da el tamaño de muestra
  // más pequeño posible, que es justo el error.
  const d = P.diagnostico({ aciertos: 11, casos: 17 });
  const medido = d.supuestos.find((s) => s.medido);

  assert.ok(medido, 'la medida tiene que estar y estar marcada');
  assert.equal(d.supuestos.filter((s) => s.medido).length, 1);
  assert.ok(medido.contratos < d.supuestos.at(-1).contratos,
    'y ser la que menos contratos pide, que es por lo que engaña');
});

test('los supuestos por debajo del equilibrio no se listan', () => {
  // Pedir el tamaño de muestra para detectar una ventaja que no existe no
  // tiene sentido; listarlo sugeriría que la hay.
  const d = P.diagnostico({ aciertos: 11, casos: 17, precio: 0.7 });
  assert.ok(d.supuestos.every((s) => s.acierto > d.equilibrio.acierto));
});

test('un precio distinto mueve el equilibrio y con él todo lo demás', () => {
  const barato = P.diagnostico({ aciertos: 11, casos: 17, precio: 0.3 });
  const caro = P.diagnostico({ aciertos: 11, casos: 17, precio: 0.7 });
  assert.ok(barato.equilibrio.acierto < caro.equilibrio.acierto);
  assert.equal(barato.concluyente, true, 'a 30¢, un 65% de aciertos sí excluye perder');
  assert.equal(caro.concluyente, false, 'a 70¢, el mismo 65% no llega');
});
