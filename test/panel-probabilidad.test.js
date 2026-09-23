'use strict';

// «¿Termina por encima de 88.000?»
//
// Lo que se prueba aquí es sobre todo lo que el panel NO debe decir. Un número
// de probabilidad es la clase de cosa que se lee con demasiada confianza, así
// que las reglas duras son: nunca 0%, nunca 100%, y nunca más dígitos de los
// que la muestra puede sostener.

const test = require('node:test');
const assert = require('node:assert');

const P = require('../src/panel-probabilidad');
const F = require('../src/forecast');

// Un horizonte como el que manda el servidor: rejilla, sigma y plazo.
function horizonte({ sigma = 0.01, bloques = 1, ms = 60_000, muestra = 400 } = {}) {
  // Una muestra simétrica, para que el 50% caiga donde debe.
  const xs = Array.from({ length: muestra }, (_, i) => (i - (muestra - 1) / 2) / (muestra / 6));
  return { ok: true, bloques, ms, desde: '1m', sigmaHorizonte: sigma, rejilla: F.rejillaZ(xs) };
}

const datosDe = (hs) => ({ horizontes: hs, recibido: 1_000_000 });

// --- Lo que no puede decir --------------------------------------------------

test('un nivel fuera de la muestra no sale como imposible', () => {
  const h = horizonte();
  const r = P.evaluar(h, 100, 1000);   // diez veces el precio, en un minuto
  assert.ok(r.p > 0, 'nunca cero');
  assert.equal(r.fuera, 'arriba');

  const texto = P.formatProb(r);
  assert.match(texto, /^< \d/, `debería decir "menos de", y dijo "${texto}"`);
  assert.doesNotMatch(texto, /^0%/);
});

test('ni como seguro por el otro lado', () => {
  const h = horizonte();
  const r = P.evaluar(h, 100, 0.01);
  assert.ok(r.p < 1, 'nunca uno');
  const texto = P.formatProb(r);
  assert.match(texto, /^> \d/, `debería decir "más de", y dijo "${texto}"`);
  assert.doesNotMatch(texto, /100%/);
});

test('no se escriben decimales que la muestra no sostiene', () => {
  // Con 128 puntos de rejilla el grano es del 0,4%: "61,7%" serían dos dígitos
  // inventados. Por encima del 10% se redondea al entero.
  assert.equal(P.formatProb({ p: 0.617, grano: 0.004, fuera: null }), '62%');
  assert.equal(P.formatProb({ p: 0.5, grano: 0.004, fuera: null }), '50%');

  // Por debajo del 10% un punto porcentual sí cambia la decisión, así que ahí
  // se da un decimal — y con coma, que es como se escribe en español.
  assert.equal(P.formatProb({ p: 0.043, grano: 0.004, fuera: null }), '4,3%');
  assert.equal(P.formatProb({ p: 0.004, grano: 0.004, fuera: null }), '< 1%');
});

test('sin datos no se inventa un número', () => {
  assert.equal(P.formatProb(null), '—');
  assert.equal(P.evaluar({ ok: true, sigmaHorizonte: 0.01 }, 100, 101), null, 'sin rejilla no hay respuesta');
  assert.equal(P.evaluar({ ok: false, rejilla: {} }, 100, 101), null, 'un horizonte que falló no responde');
});

// --- Que la cuenta sea la que dice -----------------------------------------

test('en el precio de ahora la probabilidad es la mitad', () => {
  // Consecuencia directa de no predecir dirección. Si saliera 57%, el panel
  // estaría apostando al alza sin decirlo.
  const r = P.evaluar(horizonte(), 100, 100);
  assert.ok(Math.abs(r.p - 0.5) < 0.02, `salió ${r.p}`);
});

test('por debajo y por encima suman uno', () => {
  const r = P.evaluar(horizonte(), 100, 100.5);
  assert.ok(Math.abs(r.p + P.inverso(r).p - 1) < 1e-12);
});

test('el aviso de estar fuera de la muestra se da la vuelta con la probabilidad', () => {
  const r = { p: 0.004, fuera: 'arriba', grano: 0.004 };
  assert.equal(P.inverso(r).fuera, 'abajo', 'lo que es cola por arriba es certeza por abajo');
  assert.equal(P.inverso({ p: 0.5, fuera: null }).fuera, null);
});

test('el color sólo dice tres cosas', () => {
  assert.equal(P.clase(0.8), 'bull');
  assert.equal(P.clase(0.2), 'bear');
  assert.equal(P.clase(0.5), 'flat', 'en el medio, gris: una moneda al aire decide igual de bien');
  assert.equal(P.clase(null), 'flat');
});

test('las cuotas justas son el inverso de la probabilidad', () => {
  const texto = P.cuotas(0.25);
  assert.match(texto, /4/, 'a 25%, cuatro a uno');
  assert.match(texto, /25¢/);
  assert.equal(P.cuotas(0), '', 'sin probabilidad no hay cuota');
  assert.equal(P.cuotas(1), '');
});

// --- El panel en el navegador (con un doble del DOM) ------------------------

function celdaFalsa() {
  const clases = new Set(['flat']);
  return {
    textContent: '',
    title: '',
    classList: {
      add: (c) => clases.add(c),
      remove: (c) => clases.delete(c),
      contains: (c) => clases.has(c),
    },
    _clases: clases,
  };
}

function panelFalso(n) {
  const filas = Array.from({ length: n }, (_, i) => {
    const encima = celdaFalsa();
    const debajo = celdaFalsa();
    return {
      dataset: { probFila: String(i) },
      querySelector: (sel) => (sel === '.prob-encima' ? encima : sel === '.prob-debajo' ? debajo : null),
      _encima: encima,
      _debajo: debajo,
    };
  });
  return { innerHTML: '', querySelectorAll: () => filas, _filas: filas };
}

test('actualizar escribe los números sin repintar la tabla', () => {
  const datos = datosDe([horizonte({ ms: 60_000 }), horizonte({ ms: 300_000, sigma: 0.02 })]);
  const c = panelFalso(2);

  assert.equal(P.actualizar(c, { datos, nivel: 101, precio: 100 }), true);
  assert.equal(c.innerHTML, '', 'no se ha tocado el HTML: el campo del precio conserva el foco');
  for (const f of c._filas) {
    assert.match(f._encima.textContent, /%/, 'cada fila tiene su número');
    assert.match(f._debajo.textContent, /%/);
  }
});

test('actualizar no toca el DOM cuando el número no cambia', () => {
  // A diez ticks por segundo, escribir el mismo "50%" seiscientas veces por
  // minuto es trabajo tirado, y además impide seleccionar el número con el
  // ratón mientras se lee.
  const datos = datosDe([horizonte()]);
  const c = panelFalso(1);
  P.actualizar(c, { datos, nivel: 101, precio: 100 });

  const celda = c._filas[0]._encima;
  const antes = celda.textContent;
  let escrituras = 0;
  Object.defineProperty(celda, 'textContent', {
    get: () => antes,
    set: () => { escrituras++; },
  });

  // Un movimiento minúsculo: el porcentaje redondeado no cambia.
  P.actualizar(c, { datos, nivel: 101, precio: 100.0001 });
  assert.equal(escrituras, 0, 'no debería haber escrito nada');
});

test('si la tabla no cuadra con los datos, actualizar lo dice', () => {
  // Pasa al cambiar de intervalo: hay otros horizontes. Devolver `false` es lo
  // que hace que la página repinte en vez de dejar números de otro sitio.
  const datos = datosDe([horizonte(), horizonte(), horizonte()]);
  assert.equal(P.actualizar(panelFalso(2), { datos, nivel: 101, precio: 100 }), false);
  assert.equal(P.actualizar(panelFalso(0), { datos, nivel: 101, precio: 100 }), false);
});

test('sin nivel no se calcula nada y se explica qué hacer', () => {
  const c = panelFalso(0);
  assert.equal(P.actualizar(c, { datos: datosDe([horizonte()]), nivel: null, precio: 100 }), false);

  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: null, precio: 100 });
  assert.match(c.innerHTML, /Escribe un precio/);
});

test('sin precio en vivo se dice, en vez de enseñar una probabilidad vieja', () => {
  const c = panelFalso(0);
  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: 101, precio: null });
  assert.match(c.innerHTML, /precio/i);
  assert.doesNotMatch(c.innerHTML, /%<\/td>/, 'y no hay tabla con números');
});

test('render pinta una fila por horizonte, con su cuenta atrás', () => {
  const c = panelFalso(0);
  const datos = datosDe([horizonte({ ms: 60_000 }), horizonte({ ms: 300_000 })]);
  P.render(c, { datos, interval: '1h', nivel: 101, precio: 100 });

  assert.equal((c.innerHTML.match(/data-prob-fila=/g) || []).length, 2);
  // La cuenta atrás se ancla en cuando llegó la respuesta, no en el reloj del
  // servidor: es la misma celda que usa la tabla de predicción.
  assert.ok(c.innerHTML.includes(`data-vence="${1_000_000 + 60_000}"`), 'el primer plazo vence a su hora');
  assert.match(c.innerHTML, /por encima/);
  assert.match(c.innerHTML, /por debajo/);
});

test('render dice la distancia al nivel, con su signo', () => {
  const c = panelFalso(0);
  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: 102, precio: 100 });
  assert.match(c.innerHTML, /\+2%/);

  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: 98, precio: 100 });
  assert.match(c.innerHTML, /-2%/);
});

test('un horizonte sin rejilla se queda fuera de la tabla', () => {
  // Con poca historia el servidor manda el horizonte marcado como fallido. Una
  // fila con un guión sería peor que no tener la fila.
  const c = panelFalso(0);
  const datos = datosDe([horizonte(), { ok: false, reason: 'sin historia' }]);
  P.render(c, { datos, interval: '1h', nivel: 101, precio: 100 });
  assert.equal((c.innerHTML.match(/data-prob-fila=/g) || []).length, 1);
});

test('si ningún horizonte sirve se explica por qué', () => {
  const c = panelFalso(0);
  P.render(c, { datos: datosDe([{ ok: false, reason: 'hacen falta 100 velas y hay 12' }]), interval: '1h', nivel: 101, precio: 100 });
  assert.match(c.innerHTML, /hacen falta 100 velas/);
});

test('la línea de resumen coge el plazo más corto', () => {
  const c = { innerHTML: '' };
  const datos = datosDe([horizonte({ ms: 60_000 }), horizonte({ ms: 3_600_000 })]);
  P.renderLinea(c, { datos, nivel: 101, precio: 100, interval: '1h' });
  assert.match(c.innerHTML, /01:00/, 'el de un minuto, que es el mejor calibrado');
  assert.match(c.innerHTML, /por encima/);

  P.renderLinea(c, { datos, nivel: null, precio: 100, interval: '1h' });
  assert.equal(c.innerHTML, '', 'sin nivel, la línea desaparece en vez de ocupar sitio');
});

test('con la bolsa cerrada se avisa de que el plazo no cuenta todavía', () => {
  // «4% de pasar de 366,40 dentro de cinco minutos» a las diez de la noche es
  // la probabilidad de un movimiento que no puede ocurrir: no hay mercado donde
  // ocurra. El número se sigue enseñando, pero con su aviso delante.
  const c = panelFalso(0);
  const datos = datosDe([horizonte()]);
  P.render(c, { datos, interval: '1h', nivel: 101, precio: 100, nota: 'El mercado está cerrado.' });
  assert.match(c.innerHTML, /El mercado está cerrado/);
  assert.match(c.innerHTML, /data-prob-fila/, 'y la tabla sigue ahí');

  P.render(c, { datos, interval: '1h', nivel: 101, precio: 100 });
  assert.doesNotMatch(c.innerHTML, /prob-aviso/, 'sin nota, sin recuadro vacío');
});
