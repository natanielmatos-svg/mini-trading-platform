'use strict';

// El calmado del precio en vivo.
//
// Lo que se fija aquí es que el titular deje de temblar SIN perder precisión
// donde importa, y sobre todo la propiedad que se descubrió midiendo: con el
// mercado quieto el número tiene que quedarse quieto. Redondear no bastaba
// —el rebote entre compra y venta es más ancho que el escalón y cruzaba la
// frontera de redondeo en cada tick— y por eso hay histéresis.

const test = require('node:test');
const assert = require('node:assert');

const P = require('../src/precio-vivo');
const { priceDecimals } = require('../src/format');

// Flujo de ticks parecido al que manda @aggTrade: paseo aleatorio más el
// rebote entre la compra y la venta del libro, que es el ruido de verdad.
function ticks({ base, volPct, segundos = 60, porSegundo = 10, horquillaPct = 0.00002, semilla = 7 }) {
  const out = [];
  let p = base;
  let s = semilla;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;

  for (let i = 0; i < segundos * porSegundo; i++) {
    p *= 1 + (rnd() - 0.5) * 2 * (volPct / Math.sqrt(porSegundo));
    out.push({ t: i * (1000 / porSegundo), precio: p * (1 + (rnd() < 0.5 ? -1 : 1) * horquillaPct) });
  }
  return out;
}

function repintados(flujo, opciones) {
  const c = P.crear(opciones);
  let n = 0;
  for (const { t, precio } of flujo) if (c.siguiente(precio, t)) n++;
  return n;
}

test('el titular enseña los MISMOS decimales que el resto de la pantalla', () => {
  // Durante un tiempo enseñaba menos —bitcoin en dólares enteros— para que el
  // último dígito no bailara. Era resolver dos veces el mismo problema: la
  // banda de histéresis ya impide repintar hasta que el precio se mueve un
  // 0,05%, así que el decimal no puede parpadear aunque esté. Lo único que
  // conseguía era que el titular fuese el único sitio con otra precisión que
  // el gráfico, la tabla de predicción y los niveles.
  for (const p of [285763.27, 85763.27, 3083.85, 150.257, 24.3271, 1.23456, 0.123456, 0.00001234]) {
    assert.equal(P.decimales(p), priceDecimals(p), `${p} descuadra con el resto de la aplicación`);
  }
});

test('cuantizar redondea a los decimales que se enseñan, sin cola de coma flotante', () => {
  assert.equal(P.cuantizar(1.23456), 1.2346);
  assert.equal(P.cuantizar(85763.27), 85763.3);
  assert.equal(P.cuantizar(150.257), 150.26);
  // Nada de 0,12345999999999999, que es lo que salía al dividir por 10**-5.
  assert.equal(String(P.cuantizar(0.123456)), '0.123456');
});

test('el escalón se mantiene en el mismo orden de magnitud relativo', () => {
  // Entre el 0,001% y el 0,01% del precio, sea cual sea la escala: es el orden
  // de la horquilla del libro. Por debajo no hay información, hay ruido.
  for (const p of [85763, 3083.8, 150.25, 24.3, 1.23, 0.123]) {
    const pct = (P.escalon(p) / p) * 100;
    assert.ok(pct >= 0.0009 && pct <= 0.011, `${p}: escalón del ${pct.toFixed(4)}%`);
  }
});

test('el primer precio se enseña sin esperar', () => {
  // La pantalla no puede quedarse vacía un cuarto de segundo por una regla
  // pensada para el ruido.
  const c = P.crear();
  const r = c.siguiente(85763.27, 0);
  assert.ok(r);
  assert.equal(r.valor, 85763.3);
  assert.equal(r.direccion, null, 'el primero no lleva destello: no hay con qué comparar');
});

test('con el mercado quieto, el número se queda quieto', () => {
  // La propiedad que motivó todo esto. Antes: 600 repintados por minuto de un
  // precio que no se movía.
  const flujo = ticks({ base: 85763, volPct: 0.00002 }); // 0,002% por segundo
  const n = repintados(flujo);

  assert.equal(flujo.length, 600);
  assert.ok(n <= 5, `debería quedarse casi quieto, repintó ${n} veces`);
});

test('pero sigue vivo cuando el precio se mueve de verdad', () => {
  // Calmar no puede significar quedarse congelado: sería peor que temblar.
  const quieto = repintados(ticks({ base: 85763, volPct: 0.00002 }));
  const normal = repintados(ticks({ base: 85763, volPct: 0.0004 }));
  const movido = repintados(ticks({ base: 85763, volPct: 0.002 }));

  assert.ok(normal > quieto, `normal ${normal} vs quieto ${quieto}`);
  assert.ok(movido > normal, `movido ${movido} vs normal ${normal}`);
  assert.ok(movido >= 60, `con el mercado movido debería seguir el precio, repintó ${movido}`);
});

test('la histéresis es lo que mata el rebote, no el redondeo', () => {
  // Es el hallazgo: el rebote compra/venta es MÁS ANCHO que el escalón, así
  // que cruza la frontera de redondeo en cada tick y el cuantizado cambia
  // igual. Sin banda, un mercado parado seguía repintando cientos de veces.
  const flujo = ticks({ base: 85763, volPct: 0.00002 });
  const sinBanda = repintados(flujo, { banda: 0 });
  const conBanda = repintados(flujo);

  assert.ok(sinBanda > 100, `sin banda debería repintar mucho, repintó ${sinBanda}`);
  assert.ok(conBanda * 20 < sinBanda, `con banda ${conBanda}, sin banda ${sinBanda}`);
});

test('un precio que oscila dentro de la banda no repinta nunca', () => {
  const c = P.crear();
  c.siguiente(85763, 0);

  // Oscila 20 $ arriba y abajo: por encima del escalón (1 $) pero por debajo
  // de la banda (0,05% = 42 $).
  let n = 0;
  for (let i = 1; i <= 100; i++) {
    if (c.siguiente(85763 + (i % 2 ? 20 : -20), i * 1000)) n++;
  }
  assert.equal(n, 0, `repintó ${n} veces sin salir de la banda`);
  assert.equal(c.valor, 85763);
});

test('un movimiento real sí pasa, y con la dirección correcta', () => {
  const c = P.crear();
  c.siguiente(85763, 0);

  const sube = c.siguiente(85900, 1000);
  assert.ok(sube, 'un salto de 137 $ tiene que pasar');
  assert.equal(sube.direccion, 'sube');
  assert.equal(sube.valor, 85900);

  const baja = c.siguiente(85600, 2000);
  assert.ok(baja);
  assert.equal(baja.direccion, 'baja');
});

test('el tope de repintados se respeta aunque el precio se dispare', () => {
  const c = P.crear();
  c.siguiente(85763, 0);

  // Diez saltos enormes dentro de la misma ventana de 250 ms: ninguno pasa.
  // Retener un cuarto de segundo es el precio de no parpadear, y es el mismo
  // trato tanto si el movimiento es grande como si es ruido.
  let n = 0;
  for (let i = 1; i <= 10; i++) if (c.siguiente(85763 + i * 50, i * 20)) n++;
  assert.equal(n, 0, `el tope es ${P.MIN_MS} ms, pasaron ${n}`);

  // Pasada la ventana, el siguiente entra, y con el precio del momento: no se
  // pinta una cola de valores viejos.
  const r = c.siguiente(86500, 300);
  assert.ok(r, 'pasado el tope debería aceptar');
  assert.equal(r.valor, 86500);
  assert.equal(r.direccion, 'sube');

  // Y vuelve a cerrarse hasta que pasen otros 250 ms.
  assert.equal(c.siguiente(87000, 400), null);
  assert.ok(c.siguiente(87000, 600));
});

test('al cambiar de activo se olvida el anterior', () => {
  // Si no, el primer precio del nuevo se compararía con el del viejo y saldría
  // un destello rojo enorme por pasar de bitcoin a solana.
  const c = P.crear();
  c.siguiente(85763, 0);
  c.reiniciar();

  assert.equal(c.valor, null);
  const r = c.siguiente(150.25, 10);
  assert.ok(r);
  assert.equal(r.direccion, null, 'el primero del activo nuevo no lleva destello');
  assert.equal(r.valor, 150.25);
});

test('un precio inservible no se enseña ni borra el que había', () => {
  const c = P.crear();
  c.siguiente(85763, 0);

  for (const malo of [null, undefined, NaN, 0, -1, 'x']) {
    assert.equal(c.siguiente(malo, 5000), null, `${malo} no debería pintar nada`);
  }
  assert.equal(c.valor, 85763, 'se conserva el último bueno');
});

test('el calmado es sólo de pantalla: no toca el precio del análisis', () => {
  // La distancia al nivel de ruptura se mide con el precio crudo. Suavizar eso
  // sería mentir sobre lo cerca que está de romper, y es justo el número del
  // que depende una señal de compra.
  const fuente = require('fs').readFileSync(require.resolve('../src/precio-vivo'), 'utf8');
  assert.match(fuente, /no pasa por aquí|LO QUE NO SE TOCA/i);

  for (const pagina of ['../public/app.js', '../public/acciones.js']) {
    const código = require('fs').readFileSync(require.resolve(pagina), 'utf8');
    // El calmador sólo aparece en el pintado del reloj, nunca alimentando
    // evaluateSignals ni la petición de ruptura.
    const lineasCalma = código.split('\n').filter((l) => l.includes('calma.siguiente'));
    assert.equal(lineasCalma.length, 1, `${pagina}: el calmador se usa en más de un sitio`);
    assert.doesNotMatch(código, /price:\s*calma\./, `${pagina}: el análisis no puede recibir el precio calmado`);
  }
});

