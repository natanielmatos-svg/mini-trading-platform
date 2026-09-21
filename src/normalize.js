'use strict';

// Utilidades de normalización: precios -> probabilidad, texto -> tokens
// comparables, y eliminación del "vig" (sobre-redondeo) dentro de un evento.

const EPS = 0.005; // probabilidad mínima/máxima al pasar a logit

function clampProb(p, eps = EPS) {
  if (!Number.isFinite(p)) return null;
  return Math.min(1 - eps, Math.max(eps, p));
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Precio medio a partir del libro. Si sólo hay último operado, se usa ese pero
// se marca spread desconocido (penalizado luego al ponderar).
function midPrice({ bid, ask, last } = {}) {
  const b = toNumber(bid);
  const a = toNumber(ask);
  const l = toNumber(last);

  const validBid = b !== null && b > 0 && b < 1 ? b : null;
  const validAsk = a !== null && a > 0 && a < 1 ? a : null;

  if (validBid !== null && validAsk !== null && validAsk >= validBid) {
    return { price: (validBid + validAsk) / 2, spread: validAsk - validBid, source: 'book' };
  }
  if (validBid !== null && validAsk === null) {
    return { price: validBid, spread: null, source: 'bid' };
  }
  if (validAsk !== null && validBid === null) {
    return { price: validAsk, spread: null, source: 'ask' };
  }
  if (l !== null && l > 0 && l < 1) {
    return { price: l, spread: null, source: 'last' };
  }
  return { price: null, spread: null, source: 'none' };
}

function logit(p) {
  const c = clampProb(p);
  return c === null ? null : Math.log(c / (1 - c));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Reparte el exceso de probabilidad entre opciones mutuamente excluyentes.
// La suma de precios "Sí" de un evento suele pasar de 1 (el margen del
// creador de mercado); dividir por la suma devuelve probabilidades honestas.
function devig(prices) {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  const total = valid.reduce((acc, p) => acc + p, 0);
  if (valid.length === 0 || total <= 0) {
    return { probabilities: prices.map(() => null), overround: null };
  }
  return {
    probabilities: prices.map((p) => (Number.isFinite(p) && p > 0 ? p / total : null)),
    overround: total - 1,
  };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'will', 'be', 'is',
  'are', 'was', 'were', 'do', 'does', 'did', 'and', 'or', 'with', 'this', 'that',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'en', 'y',
  'o', 'que', 'se', 'por', 'para', 'con', 'al', 'ser', 'sera',
]);

// Minúsculas, sin acentos, sin puntuación. Base para comparar títulos entre
// plataformas que redactan la misma pregunta de forma distinta.
function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text, { keepStopwords = false } = {}) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  return new Set(keepStopwords ? words : words.filter((w) => !STOPWORDS.has(w)));
}

// Coeficiente de Dice sobre conjuntos de tokens: 0 = nada en común, 1 = iguales.
function diceSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

function textSimilarity(a, b) {
  return diceSimilarity(tokenize(a), tokenize(b));
}

const YES_LABELS = new Set(['yes', 'si', 'sí', 'true', 'a favor']);
const NO_LABELS = new Set(['no', 'false', 'en contra']);
// "Yes"/"Sí"/"True" son la misma opción en plataformas distintas; sin esto el
// emparejamiento binario entre Polymarket y Kalshi falla en la mitad de casos.
function canonicalLabelKey(label) {
  const normalized = normalizeText(label);
  if (YES_LABELS.has(normalized)) return 'yes';
  if (NO_LABELS.has(normalized)) return 'no';
  return normalized;
}

// En un mercado de predicción el año es parte del contrato, no un detalle del
// enunciado: "la Cámara en 2026" y "las presidenciales de 2032" no son el mismo
// evento por mucho que compartan el molde de la pregunta.
function extractYears(text) {
  const years = new Set();
  for (const match of String(text || '').matchAll(/\b(19|20)\d{2}\b/g)) {
    years.add(match[0]);
  }
  return years;
}

// Dos enunciados se refieren a periodos incompatibles si ambos citan años y no
// comparten ninguno. Basta con que coincida uno: un título puede mencionar de
// paso otro año ("el campeón de 2024, ¿repite en 2026?").
function yearsConflict(a, b) {
  const ya = extractYears(a);
  const yb = extractYears(b);
  if (ya.size === 0 || yb.size === 0) return false;
  for (const year of ya) if (yb.has(year)) return false;
  return true;
}

// Cajones de sastre: agrupan "cualquier otro" y no son una respuesta. Aparecen
// sobre todo en Manifold, cuyos mercados de varias opciones suelen cerrar la
// lista con "Other" en vez de enumerar la cola entera como hace Polymarket.
const CATCH_ALL_LABELS = new Set([
  'other', 'others', 'otro', 'otros', 'another', 'someone else', 'anyone else',
  'field', 'the field', 'any other', 'none of the above', 'ninguno', 'ninguna',
  'otra opcion', 'otro candidato',
]);

function isCatchAll(label) {
  return CATCH_ALL_LABELS.has(normalizeText(label));
}

// Los números que no son años suelen ser el umbral que distingue un contrato
// de su vecino: "Bitcoin por encima de 100k" y "por encima de 110k" son la
// misma frase salvo por la cifra que lo cambia todo. Lo mismo con las escaleras
// de temperatura, de tipos de interés o de escaños.
function extractNumbers(text) {
  const numbers = new Set();
  for (const match of String(text || '').matchAll(/\d+/g)) {
    const value = match[0];
    // Los años se tratan aparte, con su propia regla.
    if (/^(19|20)\d{2}$/.test(value)) continue;
    numbers.add(String(Number(value)));
  }
  return numbers;
}

// Aquí no basta con que compartan uno: han de coincidir todos. "S&P 500 por
// encima de 7000" y "S&P 500 por encima de 7500" comparten el 500 y aun así son
// contratos distintos. Ante la duda se prefiere no emparejar: una fusión falsa
// inventa un consenso entre mercados que no hablan de lo mismo, mientras que un
// emparejamiento perdido sólo resta un evento contrastado.
function numbersConflict(a, b) {
  const na = extractNumbers(a);
  const nb = extractNumbers(b);
  if (na.size !== nb.size) return true;
  for (const n of na) if (!nb.has(n)) return true;
  return false;
}

module.exports = {
  EPS,
  clampProb,
  toNumber,
  midPrice,
  logit,
  sigmoid,
  devig,
  normalizeText,
  tokenize,
  diceSimilarity,
  textSimilarity,
  canonicalLabelKey,
  extractYears,
  yearsConflict,
  isCatchAll,
  extractNumbers,
  numbersConflict,
};
