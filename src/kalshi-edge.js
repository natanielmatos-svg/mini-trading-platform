'use strict';

// ¿Está barato este contrato de Kalshi, según lo que sabemos del precio?
//
// Kalshi lista contratos binarios sobre el mismo suceso que esta aplicación ya
// estima: «¿estará bitcoin por encima de 88.000 a las 15:00?». El contrato
// cuesta entre 1 y 99 céntimos y paga 1 dólar si acierta, así que su precio ES
// una probabilidad. Y nosotros tenemos otra, medida sobre los exchanges. La
// diferencia entre las dos es la ventaja —si es que la hay.
//
// ESTE MÓDULO NO ENVÍA ÓRDENES. Decide. Es la mitad donde se gana o se pierde
// el dinero, y la que se puede comprobar entera sin tocar una cuenta real.
//
// TRES COSAS SE COMEN LA VENTAJA ANTES QUE NADA, Y LAS TRES ESTÁN AQUÍ:
//
//   1. **La comisión.** Kalshi cobra por operar una cantidad proporcional a
//      P·(1−P): máxima justo en 50¢, que es donde están los contratos
//      interesantes. En un contrato a 50¢ son ~2¢, o sea el 4% de lo que
//      arriesgas. Una ventaja de un céntimo NO existe: se la come la comisión
//      entera y sobra.
//
//   2. **La calibración.** Esta aplicación publica su propio boletín de notas:
//      a un plazo dice «la banda del 90% contuvo el 82%». Operar un plazo mal
//      calibrado es pagar por equivocarse de forma sistemática, así que el
//      motor se niega. Es el uso más serio que se le puede dar a haber medido
//      la calibración: usarla como interruptor, no como adorno.
//
//   3. **La base.** Kalshi liquida contra SU índice, no contra nuestra mediana
//      de Binance, Kraken, Coinbase y Gemini. Predecir un precio y cobrar
//      contra otro es riesgo de base, y cerca del strike —que es justo donde se
//      opera— decide el resultado. Se modela como ruido añadido en cuadratura:
//      ensancha la distribución y acerca la probabilidad al 50%, encogiendo la
//      ventaja por los dos lados. No se puede «elegir» a favor.

const forecast = require('./forecast');

// ---------------------------------------------------------------------------
// Comisiones
// ---------------------------------------------------------------------------

// Tasa de la comisión de negociación de Kalshi. La fórmula publicada es
//
//     comisión = redondeo_hacia_arriba( tasa · contratos · P · (1−P) )
//
// con P en dólares. Se deja configurable y el CLI imprime la que asume, porque
// el calendario de comisiones cambia y hay series con comisión de creador de
// mercado aparte: operar con una tasa vieja es operar con una ventaja que no
// existe. COMPRUÉBALA contra el calendario vigente antes de poner dinero.
const TASA_COMISION = 0.07;

// Kalshi no cobra por la liquidación: un contrato que llega a vencimiento paga
// o no paga, y ya. Eso tiene una consecuencia que el bot usa para decidir las
// SALIDAS: vender antes de tiempo cuesta otra comisión, así que aguantar hasta
// el vencimiento suele ser mejor que recoger un beneficio pequeño.
const COMISION_LIQUIDACION = 0;

/**
 * Comisión en dólares de comprar `contratos` a `precio` (0..1).
 *
 * El redondeo es hacia arriba al céntimo y sobre el TOTAL, no por contrato:
 * un solo contrato a 50¢ paga lo mismo que… 1,75¢ redondeado a 2¢, y cien
 * contratos pagan 1,75$ redondeado a 1,75$. Redondear por contrato inflaría la
 * comisión estimada y dejaría fuera operaciones que sí valen la pena.
 */
function comision(contratos, precio, tasa = TASA_COMISION) {
  if (!(contratos > 0) || !(precio > 0) || !(precio < 1)) return 0;
  return Math.ceil(tasa * contratos * precio * (1 - precio) * 100) / 100;
}

// Lo que cuesta la comisión por contrato, que es como se compara con la
// ventaja. Se calcula sobre el lote entero y se reparte, para no arrastrar el
// error del redondeo de un solo contrato a todo el tamaño.
function comisionUnitaria(contratos, precio, tasa = TASA_COMISION) {
  if (!(contratos > 0)) return comision(1, precio, tasa);
  return comision(contratos, precio, tasa) / contratos;
}

// ---------------------------------------------------------------------------
// Valor esperado
// ---------------------------------------------------------------------------

/**
 * Lo que vale, en dólares por contrato, comprar a `precio` algo que ocurre con
 * probabilidad `p` y paga 1 dólar.
 *
 *   pagas `precio`; cobras 1 con probabilidad p
 *   EV = p·(1 − precio) − (1−p)·precio − comisión = p − precio − comisión
 *
 * Positivo no basta. Tiene que superar el margen exigido, porque `p` es una
 * estimación y no un dato.
 */
function valorEsperado({ p, precio, contratos = 1, tasa = TASA_COMISION }) {
  if (!(p >= 0) || !(p <= 1) || !(precio > 0) || !(precio < 1)) return null;
  const fee = comisionUnitaria(contratos, precio, tasa);
  return { ev: p - precio - fee, comision: fee, bruto: p - precio };
}

/**
 * Fracción de Kelly para un contrato binario.
 *
 *   f* = (p − precio) / (1 − precio)
 *
 * Es la fracción del capital que Kelly diría arriesgar, y Kelly entero es
 * demasiado: supone que `p` es exacta, y aquí `p` sale de un modelo. Se usa una
 * fracción de Kelly —un cuarto por defecto— que es la práctica estándar
 * precisamente porque protege del error de estimación, que es el error que
 * tenemos garantizado.
 */
function kelly(p, precio) {
  if (!(precio > 0) || !(precio < 1)) return 0;
  const f = (p - precio) / (1 - precio);
  return f > 0 ? f : 0;
}

// ---------------------------------------------------------------------------
// La decisión
// ---------------------------------------------------------------------------

const LIMITES = {
  // Cuánto tiene que sobrar POR CONTRATO, ya descontada la comisión, para que
  // la operación exista. Dos céntimos sobre un dólar es un 2% de ventaja neta:
  // por debajo, cualquier error del modelo se la come.
  margenMinimo: 0.02,

  // Cuánto se puede desviar la cobertura medida del 90% prometido antes de que
  // el plazo se considere no operable. Con 0,05, un horizonte que cubrió el 82%
  // queda fuera. Es el boletín de notas actuando de interruptor.
  errorCalibracionMax: 0.05,

  // Horquilla máxima. Un mercado con 6 céntimos entre compra y venta se come
  // tres operaciones de ventaja antes de empezar.
  horquillaMax: 0.04,

  // Cuánto pueden descuadrar los dos lados del libro antes de dar la
  // cotización por vieja. Un céntimo es el redondeo; más es otra cosa.
  incoherenciaMax: 0.01,

  // Ruido de base: cuánto puede diferir, en tanto por uno sobre el precio, el
  // índice que liquida Kalshi de nuestra mediana de exchanges. MÍDELO, no lo
  // heredes: es el número que más fácil convierte una ventaja en una pérdida.
  ruidoBase: 0.0005,

  // Nunca operar contratos ya casi resueltos: a 2¢ la comisión relativa se
  // dispara y el redondeo al céntimo manda sobre la ventaja.
  precioMin: 0.05,
  precioMax: 0.95,

  // Ni contratos que vencen en nada: nuestro plazo más corto medido es de un
  // minuto, y por debajo de eso la microestructura manda sobre el modelo.
  vencimientoMinMs: 120_000,

  // Ni tan lejanos que el modelo no esté medido ahí.
  vencimientoMaxMs: 24 * 3600_000,

  fraccionKelly: 0.25,
  maxContratosPorMercado: 100,

  // No llevarse más de esta parte de lo que hay puesto en el libro: el resto
  // del tamaño movería el precio en contra.
  fraccionDelLibro: 0.25,
};

/**
 * La probabilidad de que el contrato liquide SÍ, según la forma del mercado.
 *
 * Kalshi no lista sólo «por encima de X». Los mercados de cripto suelen ser
 * franjas —«entre 87.000 y 88.000»— y ésos son dos preguntas restadas: la
 * probabilidad de pasar del suelo menos la de pasar del techo. La rejilla
 * responde a las dos, así que la franja sale gratis.
 *
 * Si algún extremo cae fuera de la muestra medida, no se opera. Ahí el número
 * es un techo y no una medida: en pantalla se puede escribir «menos del 0,4%»,
 * pero no se puede apostar contra él.
 */
function probabilidadYes(mercado, precio, dist) {
  const en = (nivel) => forecast.probabilidadEncima({
    precio, nivel, sigmaHorizonte: dist.sigmaHorizonte, rejilla: dist.rejilla,
  });

  if (mercado.tipo === 'mayor') {
    const r = en(mercado.suelo);
    if (!r) return { ok: false, motivo: 'no se pudo estimar la probabilidad' };
    if (r.fuera) return { ok: false, motivo: `el strike se sale de la muestra medida (${r.fuera})` };
    return { ok: true, p: r.p };
  }

  if (mercado.tipo === 'menor') {
    const r = en(mercado.techo);
    if (!r) return { ok: false, motivo: 'no se pudo estimar la probabilidad' };
    if (r.fuera) return { ok: false, motivo: `el strike se sale de la muestra medida (${r.fuera})` };
    return { ok: true, p: 1 - r.p };
  }

  if (mercado.tipo === 'franja') {
    const bajo = en(mercado.suelo);
    const alto = en(mercado.techo);
    if (!bajo || !alto) return { ok: false, motivo: 'no se pudo estimar la probabilidad' };
    if (bajo.fuera || alto.fuera) return { ok: false, motivo: 'algún extremo de la franja se sale de la muestra medida' };

    // P(suelo < X < techo) = P(X > suelo) − P(X > techo).
    const p = bajo.p - alto.p;
    if (!(p >= 0)) return { ok: false, motivo: 'franja mal formada: el suelo no está por debajo del techo' };
    return { ok: true, p };
  }

  return { ok: false, motivo: `forma de mercado no soportada: ${mercado.tipo}` };
}

// Por qué NO se opera. Cada motivo es una frase que se puede leer en el
// registro y entender sin abrir el código.
function rechazo(motivo, detalle = {}) {
  return { operar: false, motivo, ...detalle };
}

/**
 * ¿Hay operación en este mercado, y de qué tamaño?
 *
 * @param mercado    { strike, vencimiento, yesBid, yesAsk, noBid, noAsk, libro }
 * @param forecastResp la respuesta de /api/forecast (trae los horizontes)
 * @param contexto   { precio, capital, ahora, limites }
 */
function evaluarMercado(mercado, forecastResp, { precio, capital, ahora = Date.now(), limites = {} } = {}) {
  const L = { ...LIMITES, ...limites };

  if (!mercado || !mercado.tipo) return rechazo('el mercado no dice contra qué liquida');
  if (!(precio > 0)) return rechazo('no hay precio en vivo del activo');
  if (!(capital > 0)) return rechazo('no hay capital declarado');

  const falta = mercado.vencimiento - ahora;
  if (!(falta > 0)) return rechazo('ya venció');
  if (falta < L.vencimientoMinMs) return rechazo(`vence en ${Math.round(falta / 1000)} s: por debajo del plazo más corto que tenemos medido`);
  if (falta > L.vencimientoMaxMs) return rechazo(`vence dentro de ${Math.round(falta / 3600_000)} h: más allá de donde el modelo está medido`);

  // La distribución a ESE vencimiento, ensanchada por el ruido de base.
  const dist = forecast.distribucionEn(forecastResp && forecastResp.horizontes, falta, { ruidoBase: L.ruidoBase });
  if (!dist) return rechazo('sin distribución utilizable a ese plazo');

  const cal = revisarCalibracion(dist.calibracion, L.errorCalibracionMax);
  if (!cal.ok) return rechazo(cal.motivo, { calibracion: cal });

  const r = probabilidadYes(mercado, precio, dist);
  if (!r.ok) return rechazo(r.motivo);

  const p = r.p;
  const lados = [
    { lado: 'yes', precio: mercado.yesAsk, prob: p, libro: mercado.libro ? mercado.libro.yesAsk : null },
    { lado: 'no', precio: mercado.noAsk, prob: 1 - p, libro: mercado.libro ? mercado.libro.noAsk : null },
  ].filter((x) => x.precio > 0 && x.precio < 1);

  if (!lados.length) return rechazo('el mercado no cotiza', { p });

  const incoherencia = incoherenteEn(mercado);
  if (incoherencia !== null && incoherencia > L.incoherenciaMax) {
    return rechazo(
      `los dos lados del libro no cuadran (${(incoherencia * 100).toFixed(1)}¢): alguna cotización está vieja`,
      { p, incoherencia });
  }

  const horquilla = horquillaDe(mercado);
  if (horquilla !== null && horquilla > L.horquillaMax) {
    return rechazo(`horquilla de ${(horquilla * 100).toFixed(0)}¢: se come la ventaja antes de empezar`, { p, horquilla });
  }

  // El mejor de los dos lados por valor esperado con un contrato. El tamaño se
  // decide después, porque cambia la comisión unitaria.
  const mejor = lados
    .map((x) => ({ ...x, ...valorEsperado({ p: x.prob, precio: x.precio, contratos: 1 }) }))
    .sort((a, b) => b.ev - a.ev)[0];

  if (mejor.precio < L.precioMin || mejor.precio > L.precioMax) {
    return rechazo(`a ${(mejor.precio * 100).toFixed(0)}¢ el redondeo de la comisión manda sobre la ventaja`, { p, ...mejor });
  }
  if (mejor.ev < L.margenMinimo) {
    return rechazo(`ventaja neta de ${(mejor.ev * 100).toFixed(1)}¢, por debajo del mínimo de ${(L.margenMinimo * 100).toFixed(0)}¢`, { p, ...mejor });
  }

  const contratos = tamano({ p: mejor.prob, precio: mejor.precio, capital, libro: mejor.libro, limites: L });
  if (!(contratos > 0)) return rechazo('el tamaño sale a cero', { p, ...mejor });

  // Recalculado con el lote de verdad: la comisión unitaria baja un poco.
  const final = valorEsperado({ p: mejor.prob, precio: mejor.precio, contratos });

  return {
    operar: true,
    lado: mejor.lado,
    contratos,
    precio: mejor.precio,
    coste: Number((contratos * mejor.precio).toFixed(2)),
    comision: comision(contratos, mejor.precio),
    p,
    probabilidadLado: mejor.prob,
    ev: final.ev,
    evTotal: Number((final.ev * contratos).toFixed(2)),
    horquilla,
    venceEnMs: falta,
    sigma: dist.sigmaHorizonte,
    sigmaPropia: dist.sigmaPropia,
    desde: dist.desde,
    calibracion: cal,
  };
}

// La nota del plazo, usada como interruptor. Sin calibración medida no se
// opera: un modelo sin boletín de notas es una opinión.
function revisarCalibracion(cal, errorMax) {
  if (!cal || !cal.ok || !Array.isArray(cal.cobertura)) {
    return { ok: false, motivo: 'ese plazo no tiene calibración medida' };
  }
  const c90 = cal.cobertura.find((c) => c.nominal === 0.9);
  if (!c90) return { ok: false, motivo: 'la calibración no trae la banda del 90%' };

  const error = Math.abs(c90.observada - 0.9);
  if (error > errorMax) {
    return {
      ok: false,
      observada: c90.observada,
      error,
      motivo: `a ese plazo la banda del 90% contuvo el ${(c90.observada * 100).toFixed(0)}%: el modelo no está calibrado ahí`,
    };
  }
  return { ok: true, observada: c90.observada, error };
}

/**
 * ¿Los dos lados del libro describen el mismo mercado?
 *
 * En un binario, comprar NO a `noAsk` es exactamente vender SÍ a `1 − noAsk`,
 * así que `1 − noAsk` tiene que ser la mejor puja por el SÍ. Si no lo es, una
 * de las dos cotizaciones está vieja.
 *
 * Esto salió de un test que fallaba por tener un mercado de mentira mal
 * formado, y se quedó porque el fallo de verdad es peor: con los dos lados
 * descuadrados el motor encuentra una «ventaja» enorme en un lado y la compra
 * con dinero. Un arbitraje que sólo existe porque un número está viejo es una
 * pérdida con buena pinta.
 */
function incoherenteEn(m) {
  const errores = [];
  if (m.noAsk > 0 && m.yesBid > 0) errores.push(Math.abs(1 - m.noAsk - m.yesBid));
  if (m.noBid > 0 && m.yesAsk > 0) errores.push(Math.abs(1 - m.noBid - m.yesAsk));
  return errores.length ? Math.max(...errores) : null;
}

function horquillaDe(m) {
  if (!(m.yesAsk > 0) || !(m.yesBid > 0)) return null;
  return m.yesAsk - m.yesBid;
}

/**
 * Cuántos contratos. El mínimo de cuatro topes, y el que manda se anota.
 */
function tamano({ p, precio, capital, libro, limites }) {
  const f = kelly(p, precio) * limites.fraccionKelly;
  const porKelly = Math.floor((f * capital) / precio);
  const porTope = limites.maxContratosPorMercado;
  const porLibro = libro > 0 ? Math.floor(libro * limites.fraccionDelLibro) : Infinity;

  return Math.max(0, Math.min(porKelly, porTope, porLibro));
}

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------

/**
 * ¿Cerrar una posición abierta?
 *
 * La regla que no es obvia: **aguantar hasta el vencimiento es gratis y vender
 * cuesta otra comisión**. Así que no se recoge beneficio por recogerlo. Sólo se
 * sale cuando la ventaja se ha dado la vuelta —el precio se movió y ahora el
 * contrato vale menos de lo que el mercado paga— y la diferencia cubre la
 * comisión de salir.
 */
function evaluarSalida(posicion, mercado, forecastResp, { precio, ahora = Date.now(), limites = {} } = {}) {
  const L = { ...LIMITES, ...limites };
  if (!posicion || !(posicion.contratos > 0)) return { salir: false, motivo: 'sin posición' };

  const falta = mercado.vencimiento - ahora;
  if (!(falta > 0)) return { salir: false, motivo: 'ya venció: se liquida solo, y liquidar no cobra comisión' };

  const dist = forecast.distribucionEn(forecastResp && forecastResp.horizontes, falta, { ruidoBase: L.ruidoBase });
  if (!dist) return { salir: false, motivo: 'sin distribución: no hay motivo medido para salir' };

  const r = probabilidadYes(mercado, precio, dist);
  if (!r.ok) return { salir: false, motivo: `sin probabilidad utilizable: ${r.motivo}` };

  // Lo que vale nuestra posición, y lo que pagan por ella ahora mismo.
  const justo = posicion.lado === 'yes' ? r.p : 1 - r.p;
  const puja = posicion.lado === 'yes' ? mercado.yesBid : mercado.noBid;
  if (!(puja > 0)) return { salir: false, motivo: 'nadie puja: no se puede salir aunque se quisiera' };

  const feeSalida = comisionUnitaria(posicion.contratos, puja);
  const ganaSaliendo = puja - justo - feeSalida;

  if (ganaSaliendo >= L.margenMinimo) {
    return {
      salir: true,
      contratos: posicion.contratos,
      precio: puja,
      justo,
      comision: comision(posicion.contratos, puja),
      ventaja: ganaSaliendo,
      motivo: `el mercado paga ${(puja * 100).toFixed(0)}¢ por algo que ahora vale ${(justo * 100).toFixed(0)}¢`,
    };
  }

  return {
    salir: false,
    justo,
    puja,
    motivo: `salir costaría ${(feeSalida * 100).toFixed(1)}¢ de comisión y sólo sobran ${(ganaSaliendo * 100).toFixed(1)}¢: aguantar al vencimiento es gratis`,
  };
}

module.exports = {
  evaluarMercado, evaluarSalida, probabilidadYes, valorEsperado, comision, comisionUnitaria, kelly,
  tamano, revisarCalibracion, horquillaDe, incoherenteEn,
  LIMITES, TASA_COMISION, COMISION_LIQUIDACION,
};
