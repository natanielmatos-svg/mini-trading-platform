'use strict';

// Velas OHLCV: validación de parámetros, caché y modo demo.
//
// Antes esto era un `https.get` suelto dentro de server.js: sin caché, sin
// timeout y sin reintentos, mientras el analizador de predicciones sí usaba
// ambas cosas. Cada pestaña abierta eran cinco llamadas por minuto a Binance
// desde la IP del servidor, compartida por todos los usuarios.

const { TtlCache } = require('./cache');
const { fetchJson } = require('./http');

const BINANCE_API = process.env.BINANCE_API || 'https://data-api.binance.vision';

const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000, // aproximación: sólo se usa para el reloj de la vela
};

const INTERVALS = Object.keys(INTERVAL_MS);

// Cuántas velas se piden a Binance por ciclo. Es una constante del servidor y
// no el `limit` del cliente, por el mismo motivo que en el analizador: si el
// cliente fijara el tamaño, cada valor sería una clave de caché distinta y
// bastaría recorrerlos para multiplicar las llamadas salientes.
const FETCH_LIMIT = Math.min(Math.max(Number(process.env.KLINES_FETCH_LIMIT || 500), 100), 1000);

const cache = new TtlCache({ ttlMs: 30_000 });

function intervalMs(interval) {
  return INTERVAL_MS[interval] || INTERVAL_MS['1h'];
}

// La caché se ajusta al timeframe: no tiene sentido refrescar velas diarias
// cada cinco segundos. El precio al segundo llega por /api/stream, no por aquí.
function ttlFor(interval) {
  return Math.min(Math.max(Math.round(intervalMs(interval) / 60), 5_000), 60_000);
}

function parseSymbol(raw, fallback = 'BTCUSDT') {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  return clean || fallback;
}

function parseInterval(raw, fallback = '1h') {
  return INTERVALS.includes(raw) ? raw : fallback;
}

function parseLimit(raw, fallback = 300) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, FETCH_LIMIT);
}

// Binance devuelve arrays posicionales; esto los pasa a la forma que usa el
// resto de la app. `closed` distingue la vela en formación de las cerradas: el
// análisis de ruptura sólo aprende de las cerradas.
function toCandle(row, now) {
  const closeTime = Number(row[6]);
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime,
    trades: Number(row[8]) || 0,
    closed: closeTime <= now,
  };
}

function isUsable(candle) {
  return (
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.high >= candle.low &&
    candle.open > 0
  );
}

// ---------------------------------------------------------------------------
// Modo demo
// ---------------------------------------------------------------------------

// El modo demo del analizador de predicciones existía desde el principio, pero
// el gráfico seguía saliendo a Internet: `npm run demo` prometía "sin salida a
// Internet" y no era cierto para /index.html. Estas velas son sintéticas y
// deterministas —la misma vela histórica vale siempre lo mismo— pero la vela en
// curso avanza con el reloj, así que la página se ve viva sin red.

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function noise(seed) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1; // -1..1
}

function basePrice(symbol) {
  if (symbol.startsWith('BTC')) return 64000;
  if (symbol.startsWith('ETH')) return 3200;
  if (symbol.startsWith('SOL')) return 150;
  return 10 + (hash(symbol) % 4000) / 10;
}

// Nivel de precio en un instante dado: suma de ondas de distinto periodo, sin
// estado acumulado, así que es estable aunque avance el reloj. Va en horas y no
// en número de vela para que 1m, 1h y 1d muestren el mismo precio a la misma
// hora, como pasaría con un activo de verdad.
function demoLevel(symbol, timeMs) {
  const base = basePrice(symbol);
  const seed = hash(symbol);
  const phase = (seed % 1000) / 1000;
  const h = timeMs / 3_600_000;
  const wave =
    0.18 * Math.sin(h / 260 + phase * 6.28) +
    0.06 * Math.sin(h / 71 + 1.3 + phase) +
    0.018 * Math.sin(h / 19 + 0.5);
  return base * (1 + wave);
}

// Ruido propio de cada vela, proporcional a la raíz de su duración: una vela de
// un día se mueve más que una de un minuto, y lo hace en esa proporción.
function demoNoiseAmplitude(step) {
  return 0.004 * Math.sqrt(step / 3_600_000);
}

// Precio en la frontera entre dos velas. Que el cierre de una sea la apertura
// de la siguiente sale gratis usando la misma función para las dos.
function demoBoundary(symbol, bucket, step) {
  const seed = hash(symbol);
  const level = demoLevel(symbol, bucket * step);
  return level * (1 + demoNoiseAmplitude(step) * noise(seed ^ (bucket * 2654435761)));
}

function buildDemoCandles({ symbol, interval, limit, now }) {
  const step = intervalMs(interval);
  const currentBucket = Math.floor(now / step);
  const seed = hash(`${symbol}|${interval}`);
  const candles = [];

  for (let n = limit - 1; n >= 0; n--) {
    const bucket = currentBucket - n;
    const openTime = bucket * step;
    const closeTime = openTime + step - 1;
    const open = demoBoundary(symbol, bucket, step);
    const target = demoBoundary(symbol, bucket + 1, step);
    const forming = n === 0;

    // La vela en curso se interpola con el tiempo transcurrido: al principio es
    // un doji y va abriéndose hasta su rango completo al cerrar.
    const progress = forming ? Math.min(Math.max((now - openTime) / step, 0.01), 1) : 1;
    const close = open + (target - open) * progress;

    const amplitude = Math.abs(target - open) + open * demoNoiseAmplitude(step) * (1 + Math.abs(noise(seed ^ (bucket * 7))));
    const high = Math.max(open, close) + amplitude * 0.45 * (0.4 + Math.abs(noise(seed ^ (bucket * 13)))) * progress;
    const low = Math.min(open, close) - amplitude * 0.45 * (0.4 + Math.abs(noise(seed ^ (bucket * 29)))) * progress;

    const volumeBase = 500 + (seed % 500);
    const swing = Math.abs(close - open) / (open * demoNoiseAmplitude(step));
    const volume = volumeBase * (0.6 + Math.abs(noise(seed ^ (bucket * 31)))) * (1 + swing / 4) * progress;

    candles.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime,
      trades: Math.round(volume),
      closed: !forming,
    });
  }

  return candles;
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

async function fetchFromBinance({ symbol, interval, now }) {
  const rows = await fetchJson(`${BINANCE_API}/api/v3/klines`, {
    searchParams: { symbol, interval, limit: FETCH_LIMIT },
    timeoutMs: 8000,
    retries: 2,
  });
  if (!Array.isArray(rows)) throw new Error('Respuesta inesperada de Binance: no es una lista de velas');
  return rows.map((row) => toCandle(row, now)).filter(isUsable);
}

// Devuelve las últimas `limit` velas. Todas las peticiones a un mismo
// símbolo+timeframe comparten una sola llamada saliente (caché con TTL y
// single-flight), así que N pestañas abiertas no son N veces el tráfico.
async function getKlines({ symbol, interval, limit = 300, demo = false, now = Date.now() } = {}) {
  const sym = parseSymbol(symbol);
  const tf = parseInterval(interval);
  const take = parseLimit(limit);

  if (demo) {
    const candles = buildDemoCandles({ symbol: sym, interval: tf, limit: FETCH_LIMIT, now });
    return { symbol: sym, interval: tf, source: 'demo', fetchedAt: now, candles: candles.slice(-take) };
  }

  const key = `klines:${sym}:${tf}`;
  const entry = await cache.wrap(
    key,
    async () => ({ candles: await fetchFromBinance({ symbol: sym, interval: tf, now }), fetchedAt: Date.now() }),
    ttlFor(tf),
    { serveStaleOnError: true }
  );

  return {
    symbol: sym,
    interval: tf,
    source: 'binance',
    fetchedAt: entry.fetchedAt,
    candles: entry.candles.slice(-take),
  };
}

module.exports = {
  INTERVALS,
  INTERVAL_MS,
  FETCH_LIMIT,
  BINANCE_API,
  intervalMs,
  ttlFor,
  parseSymbol,
  parseInterval,
  parseLimit,
  buildDemoCandles,
  getKlines,
  toCandle,
  _cache: cache,
};
