'use strict';

// Acciones a través de Alpaca.
//
// La mitad del sistema —indicadores, ruptura, señales— no sabe qué es una
// cripto: opera sobre velas. Esto le da velas de bolsa con la misma forma, y
// con eso el análisis funciona igual.
//
// Dos diferencias de fondo con las criptos, y ninguna es de formato:
//
//   1. **Hace falta clave.** No existe el equivalente al endpoint público de
//      Binance: los datos de bolsa están licenciados. La clave gratuita da
//      tiempo real de IEX, que es un mercado con poca cuota, así que su
//      precio puede separarse algo del consolidado oficial. Se dice en la
//      respuesta en vez de fingir que es el precio de mercado.
//   2. **La bolsa cierra.** Alpaca publica el reloj del mercado, así que en
//      vez de mantener un calendario de festivos a mano se le pregunta.

const { fetchJson } = require('./http');
const { TtlCache } = require('./cache');

const DATA_API = process.env.ALPACA_DATA_API || 'https://data.alpaca.markets';
const TRADING_API = process.env.ALPACA_API || 'https://api.alpaca.markets';
const KEY_ID = process.env.ALPACA_KEY_ID || '';
const SECRET = process.env.ALPACA_SECRET_KEY || '';
// iex: gratis, un solo mercado. sip: la cinta consolidada, de pago.
const FEED = process.env.ALPACA_FEED || 'iex';

// Nuestros intervalos a los suyos. Alpaca acepta [1-59]Min, [1-23]Hour, 1Day,
// 1Week y [1-12]Month.
const TIMEFRAMES = {
  '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
  '1h': '1Hour', '2h': '2Hour', '4h': '4Hour',
  '1d': '1Day', '1w': '1Week',
};

const MINUTOS = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240,
  '1d': 1440, '1w': 10080,
};

const relojCache = new TtlCache({ ttlMs: 30_000, maxEntries: 4 });

function hayClave() {
  return Boolean(KEY_ID && SECRET);
}

function cabeceras() {
  return { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET };
}

function exigirClave(que) {
  if (hayClave()) return;
  throw new Error(
    `Alpaca necesita clave para ${que}: los datos de bolsa están licenciados y no hay endpoint público. ` +
      'Se configura con ALPACA_KEY_ID y ALPACA_SECRET_KEY (la cuenta gratuita sirve).'
  );
}

function parseSymbol(raw, fallback = 'AAPL') {
  // Los tickers de EE. UU. son letras, con punto en algunas clases (BRK.B).
  const limpio = String(raw || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 12);
  return limpio || fallback;
}

function parseInterval(raw, fallback = '1h') {
  return TIMEFRAMES[raw] ? raw : fallback;
}

function intervalMinutes(interval) {
  return MINUTOS[interval] || 60;
}

// Una barra de Alpaca a la forma que usa el resto de la aplicación. Sus
// marcas de tiempo son ISO, no milisegundos.
function toCandle(bar, interval, now) {
  const openTime = Date.parse(bar.t);
  const closeTime = openTime + intervalMinutes(interval) * 60_000 - 1;
  return {
    openTime,
    open: Number(bar.o),
    high: Number(bar.h),
    low: Number(bar.l),
    close: Number(bar.c),
    volume: Number(bar.v),
    closeTime,
    trades: Number(bar.n) || 0,
    closed: closeTime <= now,
  };
}

function usable(c) {
  return (
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) &&
    c.high >= c.low && c.open > 0
  );
}

/**
 * Velas de una acción. `limit` es cuántas se quieren de vuelta; se pide un
 * rango holgado porque la bolsa cierra y un día natural no trae un día de
 * barras.
 */
async function fetchCandles({ symbol, interval = '1h', limit = 400, timeoutMs = 10_000, now = Date.now() }) {
  exigirClave('las velas');

  const sym = parseSymbol(symbol);
  const tf = parseInterval(interval);

  // Con sesiones de 6,5 horas, un día natural rinde como mucho un tercio de
  // las barras intradía que rendiría en cripto: se pide margen de sobra y se
  // recorta al final.
  const minutos = intervalMinutes(tf);
  const diasNecesarios = Math.ceil((limit * minutos) / 390) + 5;
  const desde = new Date(now - diasNecesarios * 86_400_000).toISOString();

  const data = await fetchJson(`${DATA_API}/v2/stocks/bars`, {
    searchParams: { symbols: sym, timeframe: TIMEFRAMES[tf], start: desde, limit: limit * 2, feed: FEED, adjustment: 'split' },
    headers: cabeceras(),
    timeoutMs,
    retries: 2,
  });

  // Acepta las dos formas: el endpoint de varios símbolos devuelve un mapa, el
  // de uno solo una lista.
  const bruto = data && data.bars ? (Array.isArray(data.bars) ? data.bars : data.bars[sym]) : null;
  if (!Array.isArray(bruto)) {
    throw new Error(`Alpaca no devolvió barras para ${sym} (¿ticker inexistente o sin datos en ese feed?)`);
  }

  const candles = bruto.map((b) => toCandle(b, tf, now)).filter(usable);
  return { symbol: sym, interval: tf, source: `alpaca:${FEED}`, fetchedAt: now, candles: candles.slice(-limit) };
}

// Mejor compra y venta ahora mismo. Se prefiere el libro a la última
// operación por lo mismo que en cripto: en un valor poco líquido la última
// puede ser de hace rato.
async function fetchQuote({ symbol, timeoutMs = 6_000 }) {
  exigirClave('el precio');

  const sym = parseSymbol(symbol);
  const data = await fetchJson(`${DATA_API}/v2/stocks/quotes/latest`, {
    searchParams: { symbols: sym, feed: FEED },
    headers: cabeceras(),
    timeoutMs,
    retries: 1,
  });

  const q = data && data.quotes ? data.quotes[sym] : null;
  const bid = Number(q && q.bp);
  const ask = Number(q && q.ap);

  if (!(bid > 0 && ask > 0 && ask >= bid)) {
    throw new Error(`Alpaca no devolvió libro utilizable para ${sym}`);
  }

  return { symbol: sym, price: (bid + ask) / 2, bid, ask, at: q.t ? Date.parse(q.t) : Date.now(), feed: FEED };
}

// Reloj del mercado. Esto es lo que evita mantener un calendario de festivos:
// Alpaca dice si está abierto y cuándo abre o cierra.
async function fetchClock({ timeoutMs = 6_000 } = {}) {
  exigirClave('el reloj del mercado');

  return relojCache.wrap(
    'clock',
    async () => {
      const data = await fetchJson(`${TRADING_API}/v2/clock`, {
        headers: cabeceras(),
        timeoutMs,
        retries: 1,
      });

      return {
        isOpen: Boolean(data.is_open),
        now: data.timestamp ? Date.parse(data.timestamp) : Date.now(),
        nextOpen: data.next_open ? Date.parse(data.next_open) : null,
        nextClose: data.next_close ? Date.parse(data.next_close) : null,
      };
    },
    30_000,
    { serveStaleOnError: true }
  );
}

module.exports = {
  TIMEFRAMES, FEED, hayClave, parseSymbol, parseInterval, intervalMinutes,
  toCandle, fetchCandles, fetchQuote, fetchClock, _relojCache: relojCache,
};
