'use strict';

// Indicadores técnicos compartidos por el servidor (análisis de ruptura) y por
// el navegador (gráfico y tabla multi-timeframe). Vivían duplicados dentro de
// public/index.html, donde no había forma de probarlos.
//
// Dos reglas en todo el módulo:
//   - Con datos insuficientes o parámetros inválidos se devuelve null, nunca
//     NaN. Un NaN se propaga en silencio y acaba pintando una tendencia falsa.
//   - Las series devuelven un array de la misma longitud que la entrada, con
//     null en las posiciones que aún no tienen valor. Así el índice i de la
//     serie siempre corresponde a la vela i.

function isValidLength(length, available) {
  return Number.isFinite(length) && length >= 1 && Number.isInteger(length) && available >= length;
}

function numbers(values) {
  return Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
}

// Media simple de los últimos `length` valores.
function sma(values, length) {
  if (!Array.isArray(values) || !isValidLength(length, values.length)) return null;
  const slice = values.slice(-length);
  if (slice.some((v) => !Number.isFinite(v))) return null;
  return slice.reduce((a, b) => a + b, 0) / length;
}

// EMA con arranque por media simple. La versión anterior sembraba con el primer
// valor de la serie, lo que con periodos largos deja un sesgo enorme: sobre 300
// velas una EMA(200) sembrada así todavía arrastra el precio inicial.
function emaSeries(values, length) {
  const out = new Array(Array.isArray(values) ? values.length : 0).fill(null);
  if (!Array.isArray(values) || !isValidLength(length, values.length)) return out;
  if (values.some((v) => !Number.isFinite(v))) return out;

  const k = 2 / (length + 1);
  let prev = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;

  for (let i = length; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function ema(values, length) {
  const series = emaSeries(values, length);
  const last = series[series.length - 1];
  return Number.isFinite(last) ? last : null;
}

// Rango verdadero: el mayor de (max-min), |max-cierre previo| y |min-cierre
// previo|. Cuenta los huecos entre velas, que el rango simple se come.
function trueRange(candle, previous) {
  if (!candle) return null;
  const range = candle.high - candle.low;
  if (!previous) return Number.isFinite(range) ? range : null;
  const values = [range, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close)];
  if (values.some((v) => !Number.isFinite(v))) return null;
  return Math.max(...values);
}

// ATR con suavizado de Wilder (el estándar; no es una media simple).
function atrSeries(candles, length = 14) {
  const out = new Array(Array.isArray(candles) ? candles.length : 0).fill(null);
  if (!Array.isArray(candles) || !isValidLength(length, candles.length)) return out;

  const trs = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1] : null));
  if (trs.some((v) => !Number.isFinite(v))) return out;

  let prev = trs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;

  for (let i = length; i < candles.length; i++) {
    prev = (prev * (length - 1) + trs[i]) / length;
    out[i] = prev;
  }
  return out;
}

function atr(candles, length = 14) {
  const series = atrSeries(candles, length);
  const last = series[series.length - 1];
  return Number.isFinite(last) ? last : null;
}

// RSI de Wilder. Se usa como contexto, no como señal por sí solo.
function rsi(values, length = 14) {
  if (!Array.isArray(values) || !isValidLength(length + 1, values.length)) return null;
  if (values.some((v) => !Number.isFinite(v))) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= length;
  loss /= length;

  for (let i = length + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gain = (gain * (length - 1) + Math.max(diff, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-diff, 0)) / length;
  }

  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

// Pivotes (fractales): una vela es pivote máximo si su máximo supera al de las
// `span` velas de cada lado. Son los puntos donde el precio ya se dio la vuelta,
// que es lo que convierte un precio cualquiera en un nivel.
function pivots(candles, span = 3) {
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles) || candles.length < span * 2 + 1) return { highs, lows };

  for (let i = span; i < candles.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].openTime });
    if (isLow) lows.push({ index: i, price: candles[i].low, time: candles[i].openTime });
  }
  return { highs, lows };
}

// Agrupa pivotes que están a menos de `tolerance` de distancia: tres rechazos
// en 63.980, 64.010 y 64.000 son el mismo nivel tocado tres veces, no tres
// niveles distintos. El número de toques es la fuerza del nivel.
function clusterLevels(points, tolerance) {
  if (!Array.isArray(points) || !points.length || !(tolerance > 0)) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price - current[current.length - 1].price <= tolerance) current.push(sorted[i]);
    else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  return clusters.map((group) => ({
    price: group.reduce((a, p) => a + p.price, 0) / group.length,
    touches: group.length,
    lastTouch: Math.max(...group.map((p) => p.time)),
    lastIndex: Math.max(...group.map((p) => p.index)),
  }));
}

// Desviación típica de los últimos `length` valores (poblacional).
function stdev(values, length) {
  const mean = sma(values, length);
  if (mean === null) return null;
  const slice = values.slice(-length);
  const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / length;
  return Math.sqrt(variance);
}

// Qué fracción de la muestra alcanza o supera `value`. Es la base del cálculo
// de probabilidad de ruptura: frecuencia observada, no un modelo inventado.
function shareAtLeast(sample, value) {
  const clean = numbers(sample);
  if (!clean.length || !Number.isFinite(value)) return null;
  let count = 0;
  for (const v of clean) if (v >= value) count++;
  return count / clean.length;
}

function quantile(sample, q) {
  const clean = numbers(sample).sort((a, b) => a - b);
  if (!clean.length) return null;
  const pos = (clean.length - 1) * Math.min(Math.max(q, 0), 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (pos - lower);
}

// Cuánto recorrido hay que exigirle a lo que queda de vela para alcanzar un
// nivel que está a `distanceAtr` de distancia. La volatilidad de un recorrido
// escala con la raíz del tiempo, así que a media vela el listón sube ~1,41x.
// Vive aquí, y no en el análisis, porque el navegador la vuelve a aplicar con
// cada tick del WebSocket: si hubiera dos copias acabarían divergiendo.
function requiredExcursion(distanceAtr, remainingFraction) {
  if (!Number.isFinite(distanceAtr) || distanceAtr < 0) return null;
  const f = Math.min(Math.max(Number(remainingFraction) || 0.01, 0.01), 1);
  return distanceAtr / Math.sqrt(f);
}

const API = {
  sma,
  ema,
  emaSeries,
  trueRange,
  atr,
  atrSeries,
  rsi,
  pivots,
  clusterLevels,
  stdev,
  shareAtLeast,
  quantile,
  requiredExcursion,
};

// El mismo archivo lo carga Node (análisis de ruptura) y el navegador (gráfico
// y tabla multi-timeframe), servido en /lib/indicators.js. Una sola EMA para
// los dos lados: la duplicada dentro del HTML fue justamente la que acabó
// pintando "Bajista" cuando el parámetro era NaN.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Indicators = API;
