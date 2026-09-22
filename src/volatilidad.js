'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// Volatilidad, medida con nuestros datos.
//
// PRIMERO LO QUE NO ES: esto no es un índice como el BVX de CF Benchmarks ni
// como el VIX. Aquéllos son volatilidad IMPLÍCITA, sacada del precio de las
// opciones, y dicen lo que el mercado está pagando por cubrirse de aquí a un
// mes. Nosotros no tenemos datos de opciones, así que no se puede replicar y
// llamarlo igual sería mentir.
//
// Lo que sí se puede medir con velas es la volatilidad REALIZADA: cuánto se ha
// movido de hecho. Responde a otra pregunta —qué ha pasado, no qué se espera—
// y para lo que hace esta aplicación es la que importa, porque el análisis de
// ruptura ya razona en recorridos pasados.
//
// Tres números, y cada uno contesta algo distinto:
//
//   1. **Anualizada.** La desviación típica de los rendimientos logarítmicos,
//      escalada a un año. Es la unidad en la que todo el mundo habla de
//      volatilidad, y permite comparar un timeframe con otro.
//   2. **Percentil.** El mismo número comparado con su propio histórico. Un
//      40% anual no dice nada suelto; "más alta que el 85% de las últimas 200
//      velas" sí. Es lo que convierte un número en una señal.
//   3. **Dispersión entre mercados.** Cuánto discrepan las casas entre sí.
//      Esto no lo puede calcular quien mira un solo exchange, y sube cuando el
//      mercado se tensiona: es la señal propia que nos dan los datos que ya
//      estábamos recogiendo.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;

// Cuántas velas entran en la ventana de volatilidad. 30 es suficiente para que
// la desviación típica signifique algo y corta lo bastante para reaccionar.
const VENTANA = 30;

// Cuántas ventanas se guardan para situar la actual en su histórico.
const HISTORICO = 200;

// Velas por año en cada timeframe: es el factor de escalado. La raíz de este
// número es lo que convierte la volatilidad por vela en anual.
const POR_ANIO = {
  '1m': 525_600, '3m': 175_200, '5m': 105_120, '15m': 35_040, '30m': 17_520,
  '1h': 8_760, '2h': 4_380, '4h': 2_190, '6h': 1_460, '8h': 1_095, '12h': 730,
  '1d': 365, '3d': 121.67, '1w': 52, '1M': 12,
};

function desviacion(valores) {
  const xs = valores.filter(Number.isFinite);
  if (xs.length < 2) return null;
  const media = xs.reduce((a, b) => a + b, 0) / xs.length;
  // Divisor n-1: es una muestra, no la población entera.
  const varianza = xs.reduce((a, b) => a + (b - media) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(varianza);
}

// Rendimientos logarítmicos entre cierres. Logarítmicos y no porcentuales
// porque se suman al componer periodos, que es lo que permite escalar a año.
function rendimientos(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1].close;
    const b = candles[i].close;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

// Volatilidad anualizada de una ventana de velas.
function anualizada(candles, interval) {
  const r = rendimientos(candles);
  const s = desviacion(r);
  const porAnio = POR_ANIO[interval];
  if (s === null || !porAnio) return null;
  return s * Math.sqrt(porAnio);
}

// En qué percentil de su propio histórico cae el valor actual.
function percentil(valor, historico) {
  const xs = historico.filter(Number.isFinite);
  if (!Number.isFinite(valor) || xs.length < 10) return null;
  const debajo = xs.filter((x) => x < valor).length;
  return debajo / xs.length;
}

/**
 * Volatilidad realizada de una serie, con su contexto histórico.
 *
 * @param candles   las velas (consolidadas o de un mercado)
 * @param interval  para escalar a año
 */
function medir(candles, interval, { ventana = VENTANA, historico = HISTORICO } = {}) {
  if (!Array.isArray(candles) || candles.length < ventana + 2) {
    return { ok: false, reason: `hacen falta al menos ${ventana + 2} velas y hay ${Array.isArray(candles) ? candles.length : 0}` };
  }

  const actual = anualizada(candles.slice(-ventana), interval);
  if (actual === null) return { ok: false, reason: `no se puede anualizar el timeframe ${interval}` };

  // La misma medida en cada punto del pasado, para saber si la de ahora es
  // alta o baja PARA ESTE ACTIVO. Un 40% anual es muchísimo en un índice y
  // poco en una cripto: sin esta comparación el número no dice nada.
  const serie = [];
  for (let i = candles.length - 1; i >= ventana && serie.length < historico; i--) {
    const v = anualizada(candles.slice(i - ventana, i), interval);
    if (v !== null) serie.push(v);
  }

  const pct = percentil(actual, serie);
  const mediana = serie.length ? [...serie].sort((a, b) => a - b)[Math.floor(serie.length / 2)] : null;

  return {
    ok: true,
    anualizada: actual,
    percentil: pct,
    mediana,
    muestra: serie.length,
    ventana,
    // Etiqueta legible. Los cortes son los cuartiles de siempre: por debajo
    // del 25% es calma, por encima del 75% es tensión.
    regimen: pct === null ? 'sin referencia' : pct < 0.25 ? 'calma' : pct > 0.75 ? 'tensión' : 'normal',
  };
}

/**
 * Dispersión entre mercados: cuánto discrepan sobre el mismo activo.
 *
 * Es la medida que no puede calcular quien mira un solo exchange. Sube cuando
 * el mercado se tensiona y cuando alguna casa se queda descolgada, y las dos
 * cosas interesan.
 */
function dispersion(quotes = []) {
  const precios = quotes.filter((q) => q && q.usable && q.price > 0).map((q) => q.price);
  if (precios.length < 2) return { ok: false, reason: 'hacen falta al menos dos mercados' };

  const min = Math.min(...precios);
  const max = Math.max(...precios);
  const media = precios.reduce((a, b) => a + b, 0) / precios.length;

  return {
    ok: true,
    mercados: precios.length,
    rangoPct: ((max - min) / media) * 100,
    desviacionPct: (desviacion(precios) / media) * 100,
  };
}

// Frase para el panel. Un número sin interpretación no lo usa nadie.
function describir(vol, disp) {
  if (!vol || !vol.ok) return null;

  const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
  const partes = [
    `Volatilidad realizada ${pct(vol.anualizada)} anual sobre las últimas ${vol.ventana} velas`,
  ];

  if (vol.percentil !== null) {
    partes.push(
      `más ${vol.percentil >= 0.5 ? 'alta' : 'baja'} que el ${Math.round((vol.percentil >= 0.5 ? vol.percentil : 1 - vol.percentil) * 100)}% ` +
        `de las ${vol.muestra} ventanas anteriores (${vol.regimen})`
    );
  }

  if (disp && disp.ok) {
    partes.push(`los ${disp.mercados} mercados discrepan un ${F.num(disp.rangoPct, 3)}% entre sí`);
  }

  return `${partes.join(' · ')}.`;
}

// Cómo leerlo, para el desplegable de método.
const EXPLICACION =
  'Volatilidad REALIZADA: cuánto se ha movido de hecho, no cuánto se espera que se mueva. ' +
  'No es comparable con el VIX ni con el índice de volatilidad de CF Benchmarks, que salen del precio de las opciones ' +
  'y dicen lo que el mercado paga hoy por cubrirse del mes que viene. Aquí no hay datos de opciones, así que esto ' +
  'mira al pasado. Sirve para lo que sirve: si la volatilidad está en tensión, los niveles se rompen más a menudo y ' +
  'también se devuelven más a menudo.';

const API = { medir, dispersion, describir, anualizada, rendimientos, desviacion, percentil, EXPLICACION, VENTANA, POR_ANIO };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Volatilidad = API;
})();
