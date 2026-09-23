'use strict';

// El motor que decide si un contrato de Kalshi está barato.
//
// De todo el proyecto, éste es el archivo donde un fallo cuesta dinero de
// verdad, así que las pruebas van casi todas sobre lo que NO debe hacer:
// operar una ventaja que la comisión se come, operar un plazo donde el modelo
// no está calibrado, o vender por vender cuando aguantar es gratis.

const test = require('node:test');
const assert = require('node:assert');

const E = require('../src/kalshi-edge');
const F = require('../src/forecast');
const { zNormal } = require('../src/calibracion');

// Una respuesta de /api/forecast como la que se recibe de verdad: horizontes
// con rejilla, sigmas y su calibración.
function forecastFalso({ sigmaBloque = 0.0008, cobertura = 0.9, muestra = 400 } = {}) {
  // Una muestra normal exacta y determinista: los cuantiles de la normal en
  // (i+½)/n. Las pruebas de este archivo son sobre las REGLAS, no sobre la
  // forma de las colas, así que conviene que la forma no sea una variable.
  const xs = Array.from({ length: muestra }, (_, i) => zNormal((i + 0.5) / muestra));
  const rejilla = F.rejillaZ(xs);

  const horizonte = (bloques, ms) => ({
    ok: true, bloques, ms, desde: '1m',
    sigmaBloque, vLargo: sigmaBloque * sigmaBloque, persistencia: 0.97,
    sigmaHorizonte: Math.sqrt(F.varianzaHorizonte(sigmaBloque, sigmaBloque * sigmaBloque, bloques, 0.97)),
    rejilla,
    calibracion: { ok: true, cobertura: [{ nominal: 0.9, observada: cobertura }] },
  });

  return { horizontes: [horizonte(1, 60_000), horizonte(15, 900_000), horizonte(60, 3_600_000)] };
}

const mercadoDe = (extra = {}) => ({
  ticker: 'KXBTC-TEST', tipo: 'mayor', suelo: 100, techo: null,
  vencimiento: 1_000_000 + 900_000,
  yesBid: 0.48, yesAsk: 0.50, noBid: 0.50, noAsk: 0.52,
  libro: { yesAsk: 10_000, noAsk: 10_000 },
  ...extra,
});

const ctx = (extra = {}) => ({ precio: 100, capital: 1000, ahora: 1_000_000, ...extra });

// --- Comisiones -------------------------------------------------------------

test('la comisión sigue la fórmula publicada y redondea hacia arriba', () => {
  // 0,07 × 1 × 0,5 × 0,5 = 0,0175 $ → 2 céntimos.
  assert.equal(E.comision(1, 0.5), 0.02);
  // Y sobre el lote entero, no por contrato: 0,07 × 100 × 0,25 = 1,75 → 1,76 al
  // redondear hacia arriba. Redondear por contrato habría dado 2,00.
  assert.equal(E.comision(100, 0.5), 1.76);
  assert.equal(E.comision(100, 0.10), 0.64);
  assert.equal(E.comision(0, 0.5), 0, 'sin contratos no hay comisión');
  assert.equal(E.comision(10, 0), 0, 'un precio imposible no cobra comisión');
});

test('la comisión es máxima en 50¢, que es donde están los contratos interesantes', () => {
  const mitad = E.comision(1000, 0.5);
  for (const p of [0.1, 0.3, 0.7, 0.9]) {
    assert.ok(E.comision(1000, p) < mitad, `a ${p} debería costar menos que a 0,5`);
  }
});

test('una ventaja de un céntimo no existe: se la come la comisión', () => {
  const v = E.valorEsperado({ p: 0.51, precio: 0.50, contratos: 100 });
  assert.ok(v.bruto > 0, 'en bruto parece ventaja');
  assert.ok(v.ev < 0, `y neta es pérdida: ${v.ev}`);
});

// --- Los interruptores ------------------------------------------------------

test('no se opera un plazo donde el modelo no está calibrado', () => {
  // Una ventaja enorme, y aun así no se toca: si a ese plazo la banda del 90%
  // contuvo el 70%, el número que dice que hay ventaja es el mismo número que
  // está mal.
  const malo = forecastFalso({ cobertura: 0.70 });
  const r = E.evaluarMercado(mercadoDe({ yesAsk: 0.20 }), malo, ctx());

  assert.equal(r.operar, false);
  assert.match(r.motivo, /no está calibrado/);
});

test('sin calibración medida tampoco se opera', () => {
  const sin = forecastFalso();
  for (const h of sin.horizontes) h.calibracion = { ok: false, reason: 'pocas velas' };

  const r = E.evaluarMercado(mercadoDe({ yesAsk: 0.20 }), sin, ctx());
  assert.equal(r.operar, false);
  assert.match(r.motivo, /calibración/);
});

test('una horquilla ancha descarta el mercado', () => {
  // Coherente pero ancho: 10¢ entre comprar y vender.
  const m = mercadoDe({ yesBid: 0.40, yesAsk: 0.50, noBid: 0.50, noAsk: 0.60 });
  const r = E.evaluarMercado(m, forecastFalso(), ctx());
  assert.equal(r.operar, false);
  assert.match(r.motivo, /horquilla/);
});

test('no se opera lo que vence en segundos ni lo que vence dentro de días', () => {
  const pronto = E.evaluarMercado(mercadoDe({ vencimiento: 1_000_000 + 30_000 }), forecastFalso(), ctx());
  assert.equal(pronto.operar, false);
  assert.match(pronto.motivo, /plazo más corto/);

  const tarde = E.evaluarMercado(mercadoDe({ vencimiento: 1_000_000 + 40 * 3600_000 }), forecastFalso(), ctx());
  assert.equal(tarde.operar, false);
  assert.match(tarde.motivo, /medido/);
});

test('un strike fuera de la muestra medida no se opera', () => {
  // En pantalla eso se escribe «menos del 0,4%», que es honesto. Apostar contra
  // un techo no lo es: el número es un límite, no una medida.
  const r = E.evaluarMercado(mercadoDe({ suelo: 500, yesAsk: 0.10 }), forecastFalso(), ctx());
  assert.equal(r.operar, false);
  assert.match(r.motivo, /muestra medida/);
});

test('los contratos casi resueltos quedan fuera', () => {
  // A 2¢ la comisión relativa se dispara y el redondeo al céntimo manda sobre
  // cualquier ventaja.
  const m = mercadoDe({ suelo: 100.6, yesBid: 0.01, yesAsk: 0.02, noBid: 0.98, noAsk: 0.99 });
  const r = E.evaluarMercado(m, forecastFalso(), ctx());
  assert.equal(r.operar, false, JSON.stringify(r));
});

test('si los dos lados del libro no cuadran, la cotización está vieja y no se opera', () => {
  // El caso que descubrió un test mal formado: con `noAsk` viejo, el motor ve
  // una ventaja enorme en ese lado y la compra. Un arbitraje que sólo existe
  // porque un número está viejo es una pérdida con buena pinta.
  const m = mercadoDe({ suelo: 100.6, yesBid: 0.01, yesAsk: 0.02, noBid: 0.50, noAsk: 0.52 });
  const r = E.evaluarMercado(m, forecastFalso(), ctx());

  assert.equal(r.operar, false);
  assert.match(r.motivo, /no cuadran/);
});

// --- El riesgo de base ------------------------------------------------------

test('el ruido de base encoge la ventaja, nunca la agranda', () => {
  // Kalshi liquida contra SU índice. Esa incertidumbre ensancha la campana y
  // acerca la probabilidad al 50%: si estábamos a favor, menos a favor.
  const datos = forecastFalso();
  const m = mercadoDe({ suelo: 100.15, yesAsk: 0.20, yesBid: 0.19, noAsk: 0.81, noBid: 0.80 });

  const sinBase = E.evaluarMercado(m, datos, ctx({ limites: { ruidoBase: 0 } }));
  const conBase = E.evaluarMercado(m, datos, ctx({ limites: { ruidoBase: 0.002 } }));

  assert.ok(sinBase.p !== undefined && conBase.p !== undefined);
  assert.ok(Math.abs(conBase.p - 0.5) < Math.abs(sinBase.p - 0.5),
    `con base ${conBase.p} debería estar más cerca del 50% que ${sinBase.p}`);
});

// --- El tamaño --------------------------------------------------------------

test('el tamaño sale de una fracción de Kelly y crece con el capital', () => {
  const datos = forecastFalso();
  const m = mercadoDe({ suelo: 99.9, yesAsk: 0.50, yesBid: 0.49, noAsk: 0.51, noBid: 0.50 });

  const limites = { maxContratosPorMercado: 100_000 };
  const poco = E.evaluarMercado(m, datos, ctx({ capital: 500, limites }));
  const mucho = E.evaluarMercado(m, datos, ctx({ capital: 5000, limites }));

  assert.equal(poco.operar, true, poco.motivo);
  assert.ok(mucho.contratos > poco.contratos, `${mucho.contratos} debería ser más que ${poco.contratos}`);
});

test('Kelly entero se queda en la cuarta parte', () => {
  // Kelly supone que la probabilidad es exacta, y aquí sale de un modelo. La
  // fracción es lo que protege del error que tenemos garantizado.
  assert.ok(Math.abs(E.kelly(0.6, 0.5) - 0.2) < 1e-12);
  assert.equal(E.kelly(0.4, 0.5), 0, 'sin ventaja no se arriesga nada');

  const capital = 10_000;
  const entero = E.tamano({ p: 0.6, precio: 0.5, capital, libro: 1e9, limites: { ...E.LIMITES, fraccionKelly: 1, maxContratosPorMercado: 1e9 } });
  const cuarto = E.tamano({ p: 0.6, precio: 0.5, capital, libro: 1e9, limites: { ...E.LIMITES, maxContratosPorMercado: 1e9 } });
  assert.equal(cuarto, Math.floor(entero / 4));
});

test('no se pide más de lo que hay puesto en el libro', () => {
  const limites = { ...E.LIMITES, maxContratosPorMercado: 1e9 };
  const sinLibro = E.tamano({ p: 0.7, precio: 0.5, capital: 1e6, libro: null, limites });
  const conLibro = E.tamano({ p: 0.7, precio: 0.5, capital: 1e6, libro: 40, limites });

  assert.ok(sinLibro > 1000);
  assert.equal(conLibro, 10, 'un cuarto de los 40 que hay puestos');
});

test('el tope por mercado manda sobre Kelly', () => {
  const n = E.tamano({ p: 0.9, precio: 0.5, capital: 1e9, libro: 1e9, limites: E.LIMITES });
  assert.equal(n, E.LIMITES.maxContratosPorMercado);
});

// --- Las formas de mercado --------------------------------------------------

test('una franja es la resta de dos preguntas', () => {
  const datos = forecastFalso();
  const dist = F.distribucionEn(datos.horizontes, 900_000);

  const franja = E.probabilidadYes({ tipo: 'franja', suelo: 99.9, techo: 100.1 }, 100, dist);
  const sobreSuelo = E.probabilidadYes({ tipo: 'mayor', suelo: 99.9 }, 100, dist);
  const sobreTecho = E.probabilidadYes({ tipo: 'mayor', suelo: 100.1 }, 100, dist);

  assert.ok(franja.ok && sobreSuelo.ok && sobreTecho.ok);
  assert.ok(Math.abs(franja.p - (sobreSuelo.p - sobreTecho.p)) < 1e-12);
  assert.ok(franja.p > 0 && franja.p < 1);
});

test('«menor que» es el complemento de «mayor que»', () => {
  const datos = forecastFalso();
  const dist = F.distribucionEn(datos.horizontes, 900_000);

  const menor = E.probabilidadYes({ tipo: 'menor', techo: 100.05 }, 100, dist);
  const mayor = E.probabilidadYes({ tipo: 'mayor', suelo: 100.05 }, 100, dist);
  assert.ok(Math.abs(menor.p + mayor.p - 1) < 1e-12);
});

test('una forma que no se sabe leer no se opera', () => {
  const dist = F.distribucionEn(forecastFalso().horizontes, 900_000);
  assert.equal(E.probabilidadYes({ tipo: 'escalera' }, 100, dist).ok, false);
});

// --- Las salidas ------------------------------------------------------------

test('no se vende sólo porque la posición vaya ganando', () => {
  // La regla que no es obvia: liquidar al vencimiento no cobra comisión y
  // vender sí. Recoger un beneficio pequeño es pagar por perder ventaja.
  const datos = forecastFalso();
  const m = mercadoDe({ suelo: 99.9, yesBid: 0.62, yesAsk: 0.64 });
  const pos = { lado: 'yes', contratos: 50, precioEntrada: 0.50 };

  const r = E.evaluarSalida(pos, m, datos, { precio: 100, ahora: 1_000_000 });
  assert.equal(r.salir, false);
  assert.match(r.motivo, /aguantar al vencimiento es gratis/);
});

test('se vende cuando el mercado paga más de lo que la posición vale', () => {
  const datos = forecastFalso();
  // El precio se ha ido muy por debajo del strike: nuestro SÍ ya casi no vale
  // nada, pero el libro todavía paga 40¢ por él.
  const m = mercadoDe({ suelo: 100.3, yesBid: 0.40, yesAsk: 0.42 });
  const pos = { lado: 'yes', contratos: 50, precioEntrada: 0.50 };

  const r = E.evaluarSalida(pos, m, datos, { precio: 99.9, ahora: 1_000_000 });
  assert.equal(r.salir, true, r.motivo);
  assert.ok(r.ventaja >= E.LIMITES.margenMinimo);
  assert.equal(r.contratos, 50);
});

test('pasado el vencimiento no se hace nada: se liquida solo y gratis', () => {
  const datos = forecastFalso();
  const m = mercadoDe({ vencimiento: 999_000 });
  const r = E.evaluarSalida({ lado: 'yes', contratos: 10 }, m, datos, { precio: 100, ahora: 1_000_000 });

  assert.equal(r.salir, false);
  assert.match(r.motivo, /liquidar no cobra comisión/);
});

test('si nadie puja no se puede salir, y se dice', () => {
  const datos = forecastFalso();
  const m = mercadoDe({ suelo: 100.3, yesBid: 0, yesAsk: 0.42 });
  const r = E.evaluarSalida({ lado: 'yes', contratos: 10 }, m, datos, { precio: 99.9, ahora: 1_000_000 });

  assert.equal(r.salir, false);
  assert.match(r.motivo, /nadie puja/);
});

// --- Que la operación buena sí salga ---------------------------------------

test('con ventaja real, calibración buena y horquilla estrecha, se opera', () => {
  // El caso positivo. Sin él, todo lo anterior se cumpliría con un motor que
  // no opera nunca.
  const datos = forecastFalso();
  const m = mercadoDe({ suelo: 99.9, yesBid: 0.44, yesAsk: 0.46, noBid: 0.54, noAsk: 0.56 });
  const r = E.evaluarMercado(m, datos, ctx({ capital: 2000 }));

  assert.equal(r.operar, true, r.motivo);
  assert.ok(['yes', 'no'].includes(r.lado));
  assert.ok(r.contratos > 0);
  assert.ok(r.ev >= E.LIMITES.margenMinimo, `la ventaja neta declarada es ${r.ev}`);
  assert.ok(r.coste > 0 && r.coste <= 2000);
  assert.equal(typeof r.venceEnMs, 'number');
});

test('el valor esperado que se declara ya lleva la comisión descontada', () => {
  const datos = forecastFalso();
  const m = mercadoDe({ suelo: 99.9, yesBid: 0.44, yesAsk: 0.46, noBid: 0.54, noAsk: 0.56 });
  const r = E.evaluarMercado(m, datos, ctx({ capital: 2000 }));

  const bruto = r.probabilidadLado - r.precio;
  assert.ok(r.ev < bruto, 'el neto tiene que ser menor que el bruto');
  assert.ok(Math.abs((bruto - r.ev) - E.comisionUnitaria(r.contratos, r.precio)) < 1e-9);
});
