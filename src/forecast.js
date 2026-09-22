'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// Motor de predicción: dónde estará el precio, con qué probabilidad.
//
// LO PRIMERO, PORQUE DETERMINA TODO LO DEMÁS: esto no predice un precio. A
// quince minutos vista, la mejor estimación puntual honesta de bitcoin es el
// precio de ahora. No es pereza ni falta de modelo: es que en un mercado
// líquido la deriva a ese horizonte es indistinguible del ruido, y cualquier
// número que se aparte del precio actual con aire de seguridad está inventado.
// Un motor que escupiera "86.412 dentro de 15 minutos" sería una máquina de
// fabricar confianza falsa, y con dinero delante eso es peor que no tener nada.
//
// Lo que SÍ se puede estimar, y es lo que de verdad se usa, es la
// DISTRIBUCIÓN: el rango donde caerá el precio con cada probabilidad. Eso
// permite decidir de verdad —dónde poner un stop, si una opción está cara, si
// un nivel está a tiro— y se puede comprobar si acierta, que es la diferencia
// entre un modelo y un adorno.
//
// Tres piezas, y cada una arregla un defecto conocido de la anterior:
//
//   1. **Volatilidad condicional (EWMA).** La volatilidad no es constante: se
//      agrupa. Tras un día movido viene otro movido. Una desviación típica de
//      las últimas 30 velas pesa igual la de ayer que la de hace un mes; la
//      EWMA da más peso a lo reciente y reacciona. Es el modelo de RiskMetrics,
//      con el lambda de siempre.
//
//   2. **Colas empíricas, no campana de Gauss.** Los rendimientos de cripto
//      tienen colas mucho más gordas que la normal: los movimientos de seis
//      sigmas pasan, y pasan a menudo. En vez de suponer una forma, se usa la
//      distribución OBSERVADA de los rendimientos estandarizados. Es el mismo
//      principio que ya usa el análisis de ruptura con las excursiones.
//
//   3. **Horizonte con reversión a la media.** La raíz del tiempo sale de
//      suponer que la volatilidad de hoy es la de siempre, y no lo es: revierte
//      hacia su nivel de largo plazo. Escalar la EWMA por raíz de h daba bandas
//      DEMASIADO ESTRECHAS a horizontes largos —medido: la banda del 90%
//      contenía el 83,6% a doce velas— porque en un tramo tranquilo la
//      volatilidad tiende a subir durante el camino y eso no se contaba.
//      Ahora la varianza de cada paso futuro se mezcla hacia la de largo plazo
//      y se suman, que es la cuenta de un GARCH.
//
// La deriva se fija en CERO a propósito. Estimarla con 400 velas da un número
// dominado por el ruido de la muestra, y meterlo desplaza todas las bandas en
// una dirección por razones que no se sostienen. Centrar en el precio actual
// es la hipótesis de martingala, y es la que hay que batir, no la que hay que
// adornar.

const I = typeof module !== 'undefined' && module.exports ? require('./indicators') : globalThis.Indicators;
const { quantile } = I;

// Cuánto dura cada intervalo. En el navegador este módulo no planifica
// horizontes —eso lo hace el servidor— así que la tabla va aquí y no se
// arrastra una dependencia de klines.js, que sí sale a la red.
const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
};

// Lambda de RiskMetrics para datos diarios. Cuánto pesa el pasado: con 0,94,
// la vela de hace 30 pesa un 16% de lo que pesa la última.
const LAMBDA = 0.94;

// Con cuánta fuerza persiste la volatilidad de un paso al siguiente. Es la
// (alfa+beta) de un GARCH(1,1): por debajo de 1 hay reversión a la media, y en
// series financieras sale casi siempre entre 0,95 y 0,99.
const PERSISTENCIA = 0.97;

// Cuántos rendimientos estandarizados se guardan para la forma de las colas.
// Con menos de 100 los cuantiles extremos son ruido; con 400 velas es lo que
// hay.
const MIN_MUESTRA = 100;

// Los cuantiles que se publican. El 50 es la mediana; los extremos son los que
// importan para un stop.
const CUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];

function rendimientos(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1].close;
    const b = candles[i].close;
    out.push(a > 0 && b > 0 ? Math.log(b / a) : null);
  }
  return out;
}

/**
 * Volatilidad condicional por EWMA, valor a valor.
 *
 * sigma²(t) = lambda · sigma²(t-1) + (1 - lambda) · r(t-1)²
 *
 * Devuelve la serie completa para poder estandarizar cada rendimiento con la
 * volatilidad que se conocía ANTES de observarlo. Usar la de después sería
 * mirar el futuro, y saldrían unas colas preciosas e inútiles.
 */
function ewmaSigma(rets, lambda = LAMBDA) {
  const limpios = rets.filter(Number.isFinite);
  if (limpios.length < 10) return [];

  // Arranque: varianza de la primera mitad, para no heredar el primer valor.
  const arranque = limpios.slice(0, Math.max(10, Math.floor(limpios.length / 2)));
  const media = arranque.reduce((a, b) => a + b, 0) / arranque.length;
  let varianza = arranque.reduce((a, b) => a + (b - media) ** 2, 0) / arranque.length;

  const sigmas = [];
  for (const r of rets) {
    sigmas.push(Math.sqrt(varianza));          // la que se conocía ANTES de r
    if (Number.isFinite(r)) varianza = lambda * varianza + (1 - lambda) * r * r;
  }
  // Y una más: la que rige para el rendimiento que aún no ha pasado.
  sigmas.push(Math.sqrt(varianza));
  return sigmas;
}

// Rendimientos estandarizados: r(t) / sigma(t). Si el modelo de volatilidad
// fuera perfecto, esto tendría desviación 1 y su forma sería la de las colas.
//
// Se CENTRAN en su mediana. Sin eso, la mediana de la muestra —que con 400
// velas es ruido— se colaba como deriva y se escalaba con la raíz del
// horizonte: la banda central se separaba del precio actual más cuanto más
// lejos se miraba, que es justo la deriva inventada que este módulo dice no
// tener. Centrar la hace verdad.
function estandarizados(rets, sigmas, { centrar = true } = {}) {
  const out = [];
  for (let i = 0; i < rets.length; i++) {
    const r = rets[i];
    const s = sigmas[i];
    if (Number.isFinite(r) && s > 0) out.push(r / s);
  }
  if (!centrar || out.length < 3) return out;

  const orden = [...out].sort((a, b) => a - b);
  const m = orden.length % 2
    ? orden[(orden.length - 1) / 2]
    : (orden[orden.length / 2 - 1] + orden[orden.length / 2]) / 2;
  return out.map((x) => x - m);
}

/**
 * Distribución del precio dentro de `bloques` velas.
 *
 * @param candles  histórico, la última puede estar en curso
 * @param opciones { bloques, precio, lambda, cuantiles }
 */
function predecir(candles, { bloques = 1, precio = null, lambda = LAMBDA, cuantiles = CUANTILES, persistencia = PERSISTENCIA, conformes = null } = {}) {
  if (!Array.isArray(candles) || candles.length < MIN_MUESTRA) {
    return { ok: false, reason: `hacen falta al menos ${MIN_MUESTRA} velas y hay ${Array.isArray(candles) ? candles.length : 0}` };
  }

  const rets = rendimientos(candles);
  const sigmas = ewmaSigma(rets, lambda);
  if (!sigmas.length) return { ok: false, reason: 'no se pudo estimar la volatilidad condicional' };

  const z = estandarizados(rets, sigmas);
  if (z.length < MIN_MUESTRA) {
    return { ok: false, reason: `sólo ${z.length} rendimientos estandarizados utilizables` };
  }

  const sigma1 = sigmas[sigmas.length - 1];           // para la siguiente vela
  if (!(sigma1 > 0)) return { ok: false, reason: 'volatilidad estimada en cero' };

  const sigmaH = Math.sqrt(varianzaHorizonte(sigma1, varianzaLargoPlazo(rets), bloques, persistencia));

  const p0 = Number.isFinite(precio) && precio > 0 ? precio : candles[candles.length - 1].close;

  // Cada cuantil sale de la forma OBSERVADA, no de una campana. Si vienen
  // cuantiles conformes —los errores que el modelo cometió de verdad a este
  // horizonte— mandan ellos: cubren por construcción.
  const mapaConforme = conformes ? new Map(conformes.cuantiles.map((c) => [c.q, c.z])) : null;
  const bandas = cuantiles.map((q) => {
    const zq = mapaConforme && mapaConforme.has(q) ? mapaConforme.get(q) : quantile(z, q);
    // El rendimiento es logarítmico: se vuelve a precio con la exponencial.
    return { q, price: p0 * Math.exp(zq * sigmaH) };
  });

  return {
    ok: true,
    bloques,
    precio: p0,
    sigmaBloque: sigma1,
    sigmaHorizonte: sigmaH,
    // En tanto por uno sobre el precio, que es como se lee.
    sigmaPct: sigmaH * 100,
    bandas,
    muestra: z.length,
    lambda,
    persistencia,
    conforme: Boolean(mapaConforme),
    muestraConforme: conformes ? conformes.muestra : null,
    // Si la volatilidad de ahora está por debajo de la de largo plazo, el
    // horizonte se ensancha más que por raíz del tiempo. Este número lo dice.
    factorHorizonte: sigmaH / (sigma1 * Math.sqrt(bloques)),
    // Cuánto se apartan las colas de una normal. Por encima de 3 es
    // "sucede mucho más de lo que una campana permitiría".
    curtosis: curtosis(z),
    deriva: 0,
  };
}

// Varianza de largo plazo: hacia dónde revierte. De toda la historia
// disponible, no de una ventana corta, que es lo que la hace "de largo plazo".
function varianzaLargoPlazo(rets) {
  const xs = rets.filter(Number.isFinite);
  if (xs.length < 30) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

/**
 * Varianza acumulada de `bloques` pasos, con la volatilidad revirtiendo.
 *
 * La varianza esperada del paso i es
 *
 *     v(i) = vLargo + persistencia^(i-1) · (v1 − vLargo)
 *
 * y la del horizonte es la suma de todas. Si la persistencia fuera 1 —una EWMA
 * pura, sin reversión— esto se reduce exactamente a v1 · bloques, que es la
 * raíz del tiempo de siempre. La diferencia aparece justo donde importaba: con
 * la volatilidad de ahora por debajo de su nivel normal, los pasos siguientes
 * se ensanchan en vez de repetir el de hoy.
 */
function varianzaHorizonte(sigma1, vLargo, bloques, persistencia = PERSISTENCIA) {
  const v1 = sigma1 * sigma1;
  if (!(vLargo > 0) || !(persistencia > 0) || persistencia >= 1) return v1 * bloques;

  let total = 0;
  for (let i = 1; i <= bloques; i++) total += vLargo + persistencia ** (i - 1) * (v1 - vLargo);
  return Math.max(total, v1); // nunca menos que un solo paso
}

// Curtosis de la muestra estandarizada. Una normal da 3.
function curtosis(xs) {
  const n = xs.length;
  if (n < 4) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  if (!(v > 0)) return null;
  return xs.reduce((a, b) => a + (b - m) ** 4, 0) / n / (v * v);
}

/**
 * Probabilidad de CERRAR por encima de un nivel dentro de `bloques` velas.
 *
 * Distinto de tocarlo: un nivel se puede tocar y devolver. Ésta es la que
 * importa para una apuesta que se liquida a una hora fija, como las de Kalshi.
 */
function probCierreEncima(candles, nivel, opciones = {}) {
  const f = predecir(candles, opciones);
  if (!f.ok) return f;
  if (!(nivel > 0)) return { ok: false, reason: 'nivel no utilizable' };

  const rets = rendimientos(candles);
  const z = estandarizados(rets, ewmaSigma(rets, opciones.lambda || LAMBDA));
  const umbral = Math.log(nivel / f.precio) / f.sigmaHorizonte;

  // Frecuencia observada, no una fórmula: de todos los rendimientos
  // estandarizados del histórico, cuántos superan el umbral.
  const encima = z.filter((x) => x > umbral).length;
  return { ok: true, probabilidad: encima / z.length, umbralZ: umbral, muestra: z.length, ...f };
}

/**
 * Cuantiles CONFORMES: los errores que el modelo cometió de verdad.
 *
 * Es la respuesta a que las bandas salieran estrechas a horizontes largos. En
 * vez de tocar parámetros hasta que cuadre —que es ajustar al histórico
 * concreto que uno mire— se recorre el pasado prediciendo hacia delante, se
 * apunta el error real de cada predicción en unidades de la sigma que el
 * modelo había anunciado, y se usan los cuantiles de ESOS errores.
 *
 * La propiedad es la que interesa: si la banda del 90% viene del cuantil 90 de
 * los errores pasados, contiene el 90% de ellos POR CONSTRUCCIÓN. No hay que
 * creerse ninguna hipótesis sobre la forma de las colas ni sobre cómo escala
 * la volatilidad, porque lo que se mide es el fallo del modelo entero.
 *
 * Es predicción conforme, y necesita historia: sin al menos 60 predicciones
 * comprobadas se devuelve null y se usa la forma de un paso, diciéndolo.
 */
function cuantilesConformes(candles, { bloques = 1, cuantiles = CUANTILES, calentamiento = 150, paso = 1 } = {}) {
  if (!Array.isArray(candles) || candles.length < calentamiento + bloques + 60) return null;

  const errores = [];
  for (let t = calentamiento; t + bloques < candles.length; t += paso) {
    const historia = candles.slice(0, t + 1);
    const real = candles[t + bloques].close;
    if (!(real > 0)) continue;

    // Predicción hecha SÓLO con lo anterior: aquí es donde esto es honesto.
    const f = predecir(historia, { bloques, cuantiles: [0.5] });
    if (!f.ok || !(f.sigmaHorizonte > 0)) continue;

    errores.push(Math.log(real / f.precio) / f.sigmaHorizonte);
  }

  if (errores.length < 60) return null;

  // Se centran en su mediana. La corrección conforme está para calibrar la
  // ANCHURA de las bandas, no la dirección: sin centrar, un tramo de
  // entrenamiento con tendencia mete esa tendencia en el cuantil 50 y la banda
  // central deja de ser el precio de ahora. Sería la deriva inventada que este
  // módulo dice no tener, colándose por la puerta de atrás.
  const orden = [...errores].sort((a, b) => a - b);
  const m = orden.length % 2
    ? orden[(orden.length - 1) / 2]
    : (orden[orden.length / 2 - 1] + orden[orden.length / 2]) / 2;

  return {
    cuantiles: cuantiles.map((q) => ({ q, z: quantile(errores, q) - m })),
    muestra: errores.length,
    derivaDescartada: m,
  };
}

// Los horizontes van en TIEMPO, no en bloques del gráfico.
//
// Antes eran bloques del intervalo elegido, así que con el gráfico en 1h no
// había forma de preguntar por los próximos cinco minutos —que es justo el
// plazo en el que alguien está mirando la pantalla—. Ahora la lista es de
// duraciones, y cada una se calcula con la serie que le corresponde: los
// plazos cortos salen de velas de un minuto, los largos del intervalo del
// gráfico. Predecir cinco minutos con velas de una hora sería inventarse una
// resolución que los datos no tienen.
const CORTOS = [
  { ms: 60_000, bloques: 1 },
  { ms: 300_000, bloques: 5 },
  { ms: 900_000, bloques: 15 },
  { ms: 1_800_000, bloques: 30 },
  { ms: 3_600_000, bloques: 60 },
];

// Y del intervalo del gráfico hacia arriba, en bloques suyos.
const LARGOS = [1, 2, 4, 8, 12, 24];

/**
 * Qué horizontes tiene sentido pedir y de qué serie sale cada uno.
 *
 * Se descartan los que ya cubre la serie de un minuto: con el gráfico en 15m,
 * "1 bloque" son 15 minutos y eso ya está, medido con mejor resolución.
 */
function planDeHorizontes(interval) {
  const paso = INTERVAL_MS[interval] || 3_600_000;
  const plan = CORTOS.map((c) => ({ ...c, interval: '1m', ms: c.ms }));
  const cubierto = Math.max(...CORTOS.map((c) => c.ms));

  for (const b of LARGOS) {
    const ms = b * paso;
    if (ms <= cubierto) continue;
    plan.push({ ms, bloques: b, interval });
  }
  return plan.sort((a, b) => a.ms - b.ms);
}

// Viaja con cada respuesta. Quien consuma la API por su cuenta tiene que leer
// esto antes de hacer nada con los números.
const AVISO =
  'Esto NO predice un precio. La banda central es el precio de ahora a propósito: a estos horizontes la ' +
  'deriva es indistinguible del ruido, y cualquier estimación puntual que se aparte del precio actual está ' +
  'inventada. Lo que se estima es la distribución: dónde caerá el precio con cada probabilidad, con las colas ' +
  'medidas sobre el propio histórico. Cada horizonte trae su calibración: si dice que la banda del 90% ' +
  'contiene el 84%, es que a ese plazo el modelo se queda corto y hay que fiarse menos.';

const API = {
  predecir, probCierreEncima, cuantilesConformes, planDeHorizontes, AVISO,
  CORTOS, LARGOS, INTERVAL_MS, ewmaSigma, estandarizados, rendimientos, curtosis,
  varianzaHorizonte, varianzaLargoPlazo,
  LAMBDA, MIN_MUESTRA, CUANTILES, PERSISTENCIA,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Forecast = API;
})();
