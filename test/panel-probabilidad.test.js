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

// Un horizonte como el que manda el servidor: rejilla, sigmas y plazo.
//
// `sigmaHorizonte` se calcula con la misma cuenta que usa el servidor, a
// partir de `sigmaBloque`, para que las pruebas del cierre de vela comparen
// contra algo de verdad y no contra un número puesto a mano.
function horizonte({ sigma = null, bloques = 1, ms = 60_000, muestra = 400,
                     sigmaBloque = 0.001, vLargo = 0.0000015, persistencia = 0.97 } = {}) {
  // Una muestra simétrica, para que el 50% caiga donde debe.
  const xs = Array.from({ length: muestra }, (_, i) => (i - (muestra - 1) / 2) / (muestra / 6));
  return {
    ok: true, bloques, ms, desde: '1m',
    sigmaBloque, vLargo, persistencia,
    sigmaHorizonte: sigma !== null ? sigma : Math.sqrt(F.varianzaHorizonte(sigmaBloque, vLargo, bloques, persistencia)),
    rejilla: F.rejillaZ(xs),
  };
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
    dataset: {},
    classList: {
      add: (c) => clases.add(c),
      remove: (c) => clases.delete(c),
      contains: (c) => clases.has(c),
    },
    _clases: clases,
  };
}

// Un panel ya pintado: las fichas de los plazos fijos y, si se pide, el bloque
// del cierre de la vela.
function panelFalso(n, { cierre = null } = {}) {
  const fichas = Array.from({ length: n }, (_, i) => {
    const encima = celdaFalsa();
    const debajo = celdaFalsa();
    const plazo = celdaFalsa();
    plazo.dataset.vence = String(1_000_000 + 60_000);
    return {
      dataset: { probFila: String(i) },
      querySelector: (sel) => ({ '.prob-encima': encima, '.prob-debajo': debajo, '.pred-cuando': plazo }[sel] || null),
      _encima: encima, _debajo: debajo, _plazo: plazo,
    };
  });

  const caja = cierre === null ? null : (() => {
    const encima = celdaFalsa();
    const debajo = celdaFalsa();
    const falta = celdaFalsa();
    return {
      dataset: { cierraEn: String(cierre) },
      querySelector: (sel) => ({
        '.prob-cierre-falta': falta,
        '.prob-cierre-p.prob-encima': encima,
        '.prob-cierre-p.prob-debajo': debajo,
      }[sel] || null),
      _encima: encima, _debajo: debajo, _falta: falta,
    };
  })();

  return {
    innerHTML: '',
    querySelectorAll: (sel) => (sel === '[data-prob-fila]' ? fichas : []),
    querySelector: (sel) => (sel === '[data-prob-cierre]' ? caja : null),
    _fichas: fichas,
    _cierre: caja,
  };
}

test('actualizar escribe los números sin repintar el panel', () => {
  const datos = datosDe([horizonte({ ms: 60_000 }), horizonte({ ms: 300_000, sigma: 0.02 })]);
  const c = panelFalso(2);

  assert.equal(P.actualizar(c, { datos, nivel: 101, precio: 100 }), true);
  assert.equal(c.innerHTML, '', 'no se ha tocado el HTML: el campo del precio conserva el foco');
  for (const f of c._fichas) {
    assert.match(f._encima.textContent, /%/, 'cada ficha tiene su número');
    assert.match(f._debajo.textContent, /% abajo$/);
  }
});

test('actualizar mueve también las cuentas atrás', () => {
  // Corre cuatro veces por segundo con el reloj, no sólo cuando llega un tick:
  // si no, con el mercado quieto los plazos se quedarían clavados.
  const datos = datosDe([horizonte()]);
  const c = panelFalso(1);

  P.actualizar(c, { datos, nivel: 101, precio: 100 }, 1_000_000);
  assert.equal(c._fichas[0]._plazo.textContent, '01:00');

  P.actualizar(c, { datos, nivel: 101, precio: 100 }, 1_030_000);
  assert.equal(c._fichas[0]._plazo.textContent, '00:30');

  P.actualizar(c, { datos, nivel: 101, precio: 100 }, 1_070_000);
  assert.equal(c._fichas[0]._plazo.textContent, 'vencida', 'pasado el plazo se dice, no se enseña 00:00');
});

test('actualizar no toca el DOM cuando el número no cambia', () => {
  // A diez ticks por segundo, escribir el mismo "50%" seiscientas veces por
  // minuto es trabajo tirado, y además impide seleccionar el número con el
  // ratón mientras se lee.
  const datos = datosDe([horizonte()]);
  const c = panelFalso(1);
  P.actualizar(c, { datos, nivel: 101, precio: 100 }, 1_000_000);

  const celda = c._fichas[0]._encima;
  const antes = celda.textContent;
  let escrituras = 0;
  Object.defineProperty(celda, 'textContent', {
    get: () => antes,
    set: () => { escrituras++; },
  });

  // Un movimiento minúsculo: el porcentaje redondeado no cambia.
  P.actualizar(c, { datos, nivel: 101, precio: 100.0001 }, 1_000_000);
  assert.equal(escrituras, 0, 'no debería haber escrito nada');
});

test('si el panel no cuadra con los datos, actualizar lo dice', () => {
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
  assert.doesNotMatch(c.innerHTML, /data-prob-fila/, 'y no hay fichas con números');
});

test('render pinta una ficha por plazo, con su cuenta atrás', () => {
  const c = panelFalso(0);
  const datos = datosDe([horizonte({ ms: 60_000 }), horizonte({ ms: 300_000 })]);
  P.render(c, { datos, interval: '1h', nivel: 101, precio: 100 });

  assert.equal((c.innerHTML.match(/data-prob-fila=/g) || []).length, 2);
  // La cuenta atrás se ancla en cuando llegó la respuesta, no en el reloj del
  // servidor: es el mismo criterio que la tabla de predicción.
  assert.ok(c.innerHTML.includes(`data-vence="${1_000_000 + 60_000}"`), 'el primer plazo vence a su hora');
  assert.match(c.innerHTML, /por encima/);
  assert.match(c.innerHTML, /por debajo|abajo/);
});
test('render dice la distancia al nivel, con su signo', () => {
  const c = panelFalso(0);
  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: 102, precio: 100 });
  assert.match(c.innerHTML, /\+2%/);

  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: 98, precio: 100 });
  assert.match(c.innerHTML, /-2%/);
});

test('un nivel pegado al precio no sale como «-0%»', () => {
  // Es el caso del botón «ahora»: el redondeo deja el nivel a una millonésima
  // del precio, la resta daba «-0%» y encima en rojo, como si bajara.
  const c = panelFalso(0);
  P.render(c, { datos: datosDe([horizonte()]), interval: '1h', nivel: 100, precio: 100.0000001 });
  assert.doesNotMatch(c.innerHTML, /-0%/);
  assert.match(c.innerHTML, /una moneda al aire/);
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

// --- El cierre de la vela que se está mirando -------------------------------

test('en el plazo exacto de un horizonte publicado, el cierre reproduce su sigma', () => {
  // La prueba de que la traslación está bien hecha: si a la vela le quedan
  // justo cinco minutos y hay un horizonte publicado de cinco minutos, la
  // anchura recalculada tiene que ser la suya, no una parecida.
  const h = horizonte({ bloques: 5, ms: 300_000 });
  const c = P.alCierre(datosDe([horizonte({ bloques: 1, ms: 60_000 }), h]), 300_000);

  assert.ok(c, 'tiene que salir algo');
  assert.ok(Math.abs(c.sigmaHorizonte - h.sigmaHorizonte) < 1e-12,
    `${c.sigmaHorizonte} frente a ${h.sigmaHorizonte}`);
  assert.equal(c.rejilla, h.rejilla, 'la forma se toma del plazo más cercano');
});

test('el cierre coge el plazo publicado más cercano, no el primero', () => {
  const corto = horizonte({ bloques: 1, ms: 60_000 });
  const largo = horizonte({ bloques: 30, ms: 1_800_000 });
  const datos = datosDe([corto, largo]);

  assert.equal(P.alCierre(datos, 90_000).rejilla, corto.rejilla, 'a minuto y medio manda el de un minuto');
  assert.equal(P.alCierre(datos, 1_500_000).rejilla, largo.rejilla, 'a veinticinco minutos, el de treinta');
});

test('según se acerca el cierre, la incertidumbre se encoge', () => {
  // Es la consecuencia visible de sincronizar con la vela: a doce segundos del
  // cierre el precio ya casi no tiene tiempo de cambiar de lado.
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);
  const sigmas = [900_000, 300_000, 60_000, 12_000].map((ms) => P.alCierre(datos, ms).sigmaHorizonte);
  for (let i = 1; i < sigmas.length; i++) {
    assert.ok(sigmas[i] < sigmas[i - 1], `${sigmas[i]} debería ser menor que ${sigmas[i - 1]}`);
  }
});

test('y la probabilidad se va hacia el 0 o el 100 con ella', () => {
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);
  const nivel = 100.05;  // un pelo por encima del precio
  const r = (ms) => P.evaluar(P.alCierre(datos, ms), 100, nivel);

  const plazos = [900_000, 60_000, 10_000, 1_000];
  const ps = plazos.map((ms) => r(ms).p);
  for (let i = 1; i < ps.length; i++) {
    assert.ok(ps[i] < ps[i - 1], `con ${plazos[i]} ms cabe menos movimiento que con ${plazos[i - 1]}: ${ps[i]} vs ${ps[i - 1]}`);
  }

  // Y ahí se para: el movimiento que haría falta ya se sale de lo que la
  // muestra llegó a ver, así que el panel dirá «< 0,4%» —que es lo honesto— y
  // no seguirá bajando hacia un cero que nadie puede afirmar.
  assert.equal(r(300).fuera, 'arriba');
  assert.equal(r(300).p, r(300).grano, 'se queda en el grano de la muestra');
  assert.ok(r(300).p > 0, 'nunca cero, ni siquiera a trescientos milisegundos');
});

test('sin vela no hay cifra grande, pero sí los plazos fijos', () => {
  // Es el caso de la bolsa cerrada: no hay vela formándose, así que una cuenta
  // atrás «al cierre» sería hacia un cierre que no va a ocurrir.
  const c = panelFalso(0);
  const datos = datosDe([horizonte()]);
  P.render(c, { datos, interval: '1h', nivel: 101, precio: 100, vela: null });

  assert.doesNotMatch(c.innerHTML, /data-prob-cierre/);
  assert.match(c.innerHTML, /data-prob-fila/, 'los plazos fijos siguen');
});

test('con vela, la cifra grande dice a qué bloque corresponde', () => {
  const c = panelFalso(0);
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);
  P.render(c, { datos, interval: '15m', nivel: 101, precio: 100, vela: { cierraEn: Date.now() + 420_000 } });

  assert.match(c.innerHTML, /data-prob-cierre/);
  assert.match(c.innerHTML, /al cierre de esta vela de <strong>15m<\/strong>/);
  assert.match(c.innerHTML, /por encima/);
});

test('el bloque del cierre se recalcula con el reloj, no sólo con el precio', () => {
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);
  const ahora = 5_000_000;
  const c = panelFalso(1, { cierre: ahora + 600_000 });

  P.actualizar(c, { datos, nivel: 100.05, precio: 100, vela: { cierraEn: ahora + 600_000 } }, ahora);
  const lejos = c._cierre._encima.textContent;
  assert.equal(c._cierre._falta.textContent, '10:00');

  // El precio no se ha movido ni un céntimo; sólo ha pasado el tiempo.
  P.actualizar(c, { datos, nivel: 100.05, precio: 100, vela: { cierraEn: ahora + 600_000 } }, ahora + 597_000);
  assert.equal(c._cierre._falta.textContent, '00:03');
  assert.notEqual(c._cierre._encima.textContent, lejos, 'con tres segundos por delante no puede decir lo mismo');
});

test('cuando la vela cierra se dice, en vez de enseñar un número de lo que ya pasó', () => {
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);
  const ahora = 5_000_000;
  const c = panelFalso(1, { cierre: ahora - 1 });

  P.actualizar(c, { datos, nivel: 101, precio: 100, vela: { cierraEn: ahora - 1 } }, ahora);
  assert.equal(c._cierre._falta.textContent, 'cerrada');
  assert.equal(c._cierre._encima.textContent, '—', 'sin plazo no hay probabilidad que dar');
});

test('la vela nueva sustituye a la anterior sin repintar', () => {
  // Al cerrar una vela empieza otra. Si el bloque se quedara con el cierre
  // viejo, la cuenta atrás diría "cerrada" hasta el siguiente refresco.
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);
  const ahora = 5_000_000;
  const c = panelFalso(1, { cierre: ahora - 1 });

  P.actualizar(c, { datos, nivel: 101, precio: 100, vela: { cierraEn: ahora + 900_000 } }, ahora);
  assert.equal(c._cierre.dataset.cierraEn, String(ahora + 900_000));
  assert.equal(c._cierre._falta.textContent, '15:00');
});

test('la línea de resumen va también al cierre de la vela', () => {
  const c = { innerHTML: '' };
  const datos = datosDe([horizonte({ bloques: 15, ms: 900_000 })]);

  P.renderLinea(c, { datos, nivel: 101, precio: 100, interval: '15m', vela: { cierraEn: Date.now() + 300_000 } });
  assert.match(c.innerHTML, /al cierre de esta vela de 15m/);

  // Sin vela cae al plazo más corto publicado, que es lo que había antes.
  P.renderLinea(c, { datos, nivel: 101, precio: 100, interval: '15m', vela: null });
  assert.match(c.innerHTML, /^en \d/);
});
