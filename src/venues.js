'use strict';

// Un módulo por mercado al contado, con la misma forma que los proveedores de
// predicción: `meta` + cómo se pregunta el precio. Así añadir un cuarto
// mercado es escribir un adaptador y meterlo en la lista.
//
// Sobre el par: Binance cotiza contra USDT y Kraken y Coinbase tienen su
// liquidez en USD. Se pide a cada uno su par profundo y se informa de cuál
// es, porque parte de la diferencia entre mercados no es desacuerdo sobre el
// bitcoin: es que USDT no vale exactamente un dólar. Esconderlo detrás de una
// media daría una falsa sensación de precisión.

const { fetchJson } = require('./http');
const { buildDemoCandles } = require('./klines');

const BINANCE_API = process.env.BINANCE_API || 'https://data-api.binance.vision';
const KRAKEN_API = process.env.KRAKEN_API || 'https://api.kraken.com';
const COINBASE_API = process.env.COINBASE_API || 'https://api.coinbase.com';

// 'BTCUSDT' -> 'BTC'
function baseAsset(symbol) {
  return String(symbol || '').toUpperCase().replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, '') || 'BTC';
}

function firstFinite(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// --- Binance ---------------------------------------------------------------

const binance = {
  meta: { id: 'binance', label: 'Binance', quote: 'USDT' },
  pairFor: (symbol) => `${baseAsset(symbol)}USDT`,

  async fetchPrice({ symbol, timeoutMs = 6000 }) {
    const pair = binance.pairFor(symbol);
    const data = await fetchJson(`${BINANCE_API}/api/v3/ticker/price`, {
      searchParams: { symbol: pair },
      timeoutMs,
      retries: 1,
    });
    return { price: firstFinite(data && data.price), pair };
  },
};

// --- Kraken ----------------------------------------------------------------

const kraken = {
  meta: { id: 'kraken', label: 'Kraken', quote: 'USD' },
  pairFor: (symbol) => `${baseAsset(symbol)}USD`,

  async fetchPrice({ symbol, timeoutMs = 6000 }) {
    const pair = kraken.pairFor(symbol);
    const data = await fetchJson(`${KRAKEN_API}/0/public/Ticker`, {
      searchParams: { pair },
      timeoutMs,
      retries: 1,
    });

    // Kraken responde 200 con los errores dentro del cuerpo.
    if (data && Array.isArray(data.error) && data.error.length) {
      throw new Error(`Kraken: ${data.error.join(', ')}`);
    }

    // La clave del resultado es su nombre interno del par (XXBTZUSD para
    // BTCUSD), que no coincide con lo que se pidió: se coge el primero.
    const entry = data && data.result ? Object.values(data.result)[0] : null;
    // c = [último precio, volumen de esa operación]
    const last = entry && Array.isArray(entry.c) ? entry.c[0] : null;
    const bid = entry && Array.isArray(entry.b) ? entry.b[0] : null;
    const ask = entry && Array.isArray(entry.a) ? entry.a[0] : null;

    return { price: firstFinite(last, bid && ask ? (Number(bid) + Number(ask)) / 2 : null), pair };
  },
};

// --- Coinbase Advanced Trade ----------------------------------------------

const coinbase = {
  meta: { id: 'coinbase', label: 'Coinbase', quote: 'USD' },
  pairFor: (symbol) => `${baseAsset(symbol)}-USD`,

  async fetchPrice({ symbol, timeoutMs = 6000 }) {
    const pair = coinbase.pairFor(symbol);
    // Endpoint público de Advanced Trade: no necesita clave.
    const data = await fetchJson(`${COINBASE_API}/api/v3/brokerage/market/products/${encodeURIComponent(pair)}/ticker`, {
      searchParams: { limit: 1 },
      timeoutMs,
      retries: 1,
    });

    const trade = data && Array.isArray(data.trades) ? data.trades[0] : null;
    const bid = data && data.best_bid;
    const ask = data && data.best_ask;

    return {
      price: firstFinite(trade && trade.price, bid && ask ? (Number(bid) + Number(ask)) / 2 : null),
      pair,
    };
  },
};

const VENUES = [binance, kraken, coinbase];
const byId = new Map(VENUES.map((v) => [v.meta.id, v]));

function listVenues() {
  return VENUES.map((v) => ({ ...v.meta }));
}

// Pregunta a los tres en paralelo. Que uno caiga no puede dejar sin precio:
// cada mercado informa de su propio estado y la consolidación sigue con los
// que respondieron, igual que hace el agregador de predicciones.
// En demo cada mercado se desvía unos pocos puntos básicos del mismo precio,
// como en la realidad: Binance algo por debajo por cotizar en USDT, y los
// otros dos separados por el ruido normal entre libros distintos.
const DESVIO_DEMO = { binance: -0.00018, kraken: 0.00011, coinbase: 0.00004 };

function demoQuotes({ symbol, now }) {
  const [vela] = buildDemoCandles({ symbol, interval: '1m', limit: 1, now });
  const base = vela ? vela.close : null;

  return VENUES.map((venue) => {
    const desvio = DESVIO_DEMO[venue.meta.id] || 0;
    // Una pizca de ruido para que no se queden clavados unos respecto a otros.
    const ruido = Math.sin(now / 3000 + venue.meta.id.length) * 0.00003;
    return {
      ...venue.meta,
      ok: base !== null,
      price: base === null ? null : base * (1 + desvio + ruido),
      pair: venue.pairFor(symbol),
      at: now,
      elapsedMs: 0,
      demo: true,
    };
  });
}

async function fetchAllPrices({ symbol = 'BTCUSDT', timeoutMs = 6000, venues = null, demo = false, now = Date.now() } = {}) {
  if (demo) return demoQuotes({ symbol, now });

  const selected = venues && venues.length ? VENUES.filter((v) => venues.includes(v.meta.id)) : VENUES;

  return Promise.all(
    selected.map(async (venue) => {
      const startedAt = Date.now();
      try {
        const { price, pair } = await venue.fetchPrice({ symbol, timeoutMs });
        if (!(price > 0)) throw new Error('respuesta sin precio utilizable');
        return { ...venue.meta, ok: true, price, pair, at: now, elapsedMs: Date.now() - startedAt };
      } catch (err) {
        return {
          ...venue.meta,
          ok: false,
          price: null,
          pair: venue.pairFor(symbol),
          error: err.message,
          elapsedMs: Date.now() - startedAt,
        };
      }
    })
  );
}

module.exports = { VENUES, byId, listVenues, fetchAllPrices, demoQuotes, baseAsset, binance, kraken, coinbase };
