'use strict';

// Velas de cada mercado al contado, para poder consolidarlas.
//
// Hasta ahora TODO el análisis salía de Binance: los niveles, el ATR y la
// muestra de excursiones. El precio consolidado entre mercados sólo alimentaba
// el titular. Eso deja una incoherencia: se mira un precio y se analiza otro,
// y la distancia a un nivel —que es de lo que depende una señal de compra— se
// mide en la escala equivocada.
//
// Aquí cada mercado devuelve sus velas en la forma que ya usa la aplicación.
// Combinarlas es cosa de src/velas-consolidadas.js.
//
// Tres cosas que no son iguales entre mercados y hay que tratar una por una:
//
//   1. **Los intervalos.** Kraken va en minutos, Coinbase en nombres
//      (ONE_HOUR), Gemini en abreviaturas (1hr). Y ninguno cubre todos los
//      nuestros: 4h, 12h y 3d no existen en varios. El que no puede, no
//      contribuye, y se dice cuál.
//   2. **Cuántas devuelven.** Coinbase da como mucho 350 por petición, así que
//      pedir 400 no basta: o se pagina o se acepta lo que haya. Se acepta y se
//      informa, porque 350 velas siguen sobrando para un ATR de 14.
//   3. **La unidad.** Binance cotiza en USDT. Sus velas se convierten a
//      dólares con el mismo cambio que el precio, o quedan fuera: mezclar
//      unidades en una mediana es exactamente el fallo que evita todo esto.

const { fetchJson } = require('./http');
const { INTERVAL_MS } = require('./klines');

const BINANCE_API = process.env.BINANCE_API || 'https://data-api.binance.vision';
const KRAKEN_API = process.env.KRAKEN_API || 'https://api.kraken.com';
const COINBASE_API = process.env.COINBASE_API || 'https://api.coinbase.com';
const GEMINI_API = process.env.GEMINI_API || 'https://api.gemini.com';

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Una vela sólo sirve si sus cuatro precios son coherentes. Una corrupta
// envenena el ATR y los niveles, y es más barato tirarla que detectarlo luego.
function usable(c) {
  return (
    c &&
    Number.isFinite(c.openTime) &&
    [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) &&
    c.high >= c.low &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );
}

function armar({ openTime, open, high, low, close, volume, interval, now }) {
  const step = INTERVAL_MS[interval];
  const closeTime = openTime + step - 1;
  return {
    openTime,
    open: toNum(open),
    high: toNum(high),
    low: toNum(low),
    close: toNum(close),
    volume: toNum(volume) || 0,
    closeTime,
    closed: closeTime <= now,
  };
}

// --- Binance ---------------------------------------------------------------

const binance = {
  id: 'binance',
  // Los suyos son los nuestros: de aquí salió la lista.
  intervalo: (tf) => tf,

  async fetch({ pair, interval, limit, timeoutMs, now }) {
    const filas = await fetchJson(`${BINANCE_API}/api/v3/klines`, {
      searchParams: { symbol: pair, interval, limit },
      timeoutMs,
      retries: 1,
    });
    if (!Array.isArray(filas)) throw new Error('Binance: respuesta que no es una lista de velas');

    return filas.map((f) =>
      armar({ openTime: Number(f[0]), open: f[1], high: f[2], low: f[3], close: f[4], volume: f[5], interval, now })
    );
  },
};

// --- Kraken ----------------------------------------------------------------

// Su parámetro va en minutos, y sólo acepta estos.
const KRAKEN_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };

const kraken = {
  id: 'kraken',
  intervalo: (tf) => KRAKEN_MIN[tf] || null,

  async fetch({ pair, interval, timeoutMs, now }) {
    const data = await fetchJson(`${KRAKEN_API}/0/public/OHLC`, {
      searchParams: { pair, interval: KRAKEN_MIN[interval] },
      timeoutMs,
      retries: 1,
    });
    // Kraken manda sus errores dentro de un 200: hay que mirarlos a mano.
    if (data && Array.isArray(data.error) && data.error.length) {
      throw new Error(`Kraken: ${data.error.join(', ')}`);
    }

    // La clave del resultado es el nombre interno del par, no el que se pidió.
    const entradas = data && data.result ? Object.entries(data.result).find(([k]) => k !== 'last') : null;
    if (!entradas) throw new Error('Kraken: respuesta sin velas');

    return entradas[1].map((f) =>
      // [tiempo(s), open, high, low, close, vwap, volume, count]
      armar({ openTime: Number(f[0]) * 1000, open: f[1], high: f[2], low: f[3], close: f[4], volume: f[6], interval, now })
    );
  },
};

// --- Coinbase --------------------------------------------------------------

const COINBASE_TF = {
  '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR', '2h': 'TWO_HOUR', '6h': 'SIX_HOUR', '1d': 'ONE_DAY',
};
const COINBASE_MAX = 350; // tope suyo por petición

const coinbase = {
  id: 'coinbase',
  intervalo: (tf) => COINBASE_TF[tf] || null,

  async fetch({ pair, interval, limit, timeoutMs, now }) {
    const step = INTERVAL_MS[interval];
    const cuantas = Math.min(limit, COINBASE_MAX);
    const fin = Math.floor(now / 1000);
    const inicio = fin - Math.ceil((cuantas * step) / 1000);

    const data = await fetchJson(`${COINBASE_API}/api/v3/brokerage/market/products/${encodeURIComponent(pair)}/candles`, {
      searchParams: { start: String(inicio), end: String(fin), granularity: COINBASE_TF[interval], limit: String(cuantas) },
      timeoutMs,
      retries: 1,
    });

    const filas = data && Array.isArray(data.candles) ? data.candles : null;
    if (!filas) throw new Error('Coinbase: respuesta sin velas');

    // Las devuelve de la más nueva a la más vieja.
    return filas
      .map((c) => armar({ openTime: Number(c.start) * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, interval, now }))
      .sort((a, b) => a.openTime - b.openTime);
  },
};

// --- Gemini ----------------------------------------------------------------

const GEMINI_TF = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1hr', '6h': '6hr', '1d': '1day' };

const gemini = {
  id: 'gemini',
  intervalo: (tf) => GEMINI_TF[tf] || null,

  async fetch({ pair, interval, timeoutMs, now }) {
    const filas = await fetchJson(`${GEMINI_API}/v2/candles/${encodeURIComponent(pair)}/${GEMINI_TF[interval]}`, {
      timeoutMs,
      retries: 1,
    });
    if (!Array.isArray(filas)) throw new Error('Gemini: respuesta que no es una lista de velas');

    // [tiempo(ms), open, high, low, close, volume], de la más nueva a la más vieja.
    return filas
      .map((f) => armar({ openTime: Number(f[0]), open: f[1], high: f[2], low: f[3], close: f[4], volume: f[5], interval, now }))
      .sort((a, b) => a.openTime - b.openTime);
  },
};

const ADAPTADORES = { binance, kraken, coinbase, gemini };

function soporta(venueId, interval) {
  const a = ADAPTADORES[venueId];
  return Boolean(a && a.intervalo(interval));
}

/**
 * Velas de un mercado. Nunca lanza: devuelve el motivo, porque una casa que no
 * puede no debe llevarse por delante a las demás.
 */
async function fetchVelas({ venueId, pair, interval, limit = 400, timeoutMs = 8000, now = Date.now() }) {
  const adaptador = ADAPTADORES[venueId];
  if (!adaptador) return { venueId, ok: false, error: `mercado desconocido: ${venueId}`, candles: [] };
  if (!adaptador.intervalo(interval)) {
    return { venueId, ok: false, error: `no publica velas de ${interval}`, candles: [] };
  }

  try {
    const crudas = await adaptador.fetch({ pair, interval, limit, timeoutMs, now });
    const candles = crudas.filter(usable).slice(-limit);
    if (!candles.length) return { venueId, ok: false, error: 'ninguna vela utilizable', candles: [] };
    return { venueId, ok: true, error: null, candles, pair };
  } catch (err) {
    return { venueId, ok: false, error: err.message, candles: [] };
  }
}

module.exports = { ADAPTADORES, INTERVAL_MS, soporta, fetchVelas, usable, armar, COINBASE_MAX };
