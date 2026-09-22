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
const { priceDecimals } = require('./format');

// Multiplicar por el cambio deja cola de coma flotante: 85600,005 × 0,999735
// da 85577,32099867502, y publicar eso es ruido disfrazado de precisión. Se
// redondea a los decimales que tienen sentido para esa escala de precio.
function redondearPrecio(price) {
  if (!Number.isFinite(price)) return price;
  const f = 10 ** priceDecimals(price);
  return Math.round(price * f) / f;
}

const BINANCE_API = process.env.BINANCE_API || 'https://data-api.binance.vision';
const KRAKEN_API = process.env.KRAKEN_API || 'https://api.kraken.com';
const COINBASE_API = process.env.COINBASE_API || 'https://api.coinbase.com';
const GEMINI_API = process.env.GEMINI_API || 'https://api.gemini.com';
const CFBENCHMARKS_API = process.env.CFBENCHMARKS_API || 'https://www.cfbenchmarks.com';
const CFBENCHMARKS_KEY = process.env.CFBENCHMARKS_API_KEY || '';

// 'BTCUSDT' -> 'BTC'
function baseAsset(symbol) {
  return String(symbol || '').toUpperCase().replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, '') || 'BTC';
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Punto medio si hay libro; si no, la última operación, diciendo cuál se usó.
function midOrLast({ bid, ask, last }) {
  const b = toNum(bid);
  const a = toNum(ask);
  if (b && a && a >= b) return { price: (b + a) / 2, source: 'libro' };

  const l = toNum(last);
  if (l) return { price: l, source: 'última operación' };
  return { price: null, source: null };
}

// --- Binance ---------------------------------------------------------------

const binance = {
  meta: { id: 'binance', label: 'Binance', quote: 'USDT' },
  pairFor: (symbol) => `${baseAsset(symbol)}USDT`,

  async fetchPrice({ symbol, timeoutMs = 6000 }) {
    const pair = binance.pairFor(symbol);
    // bookTicker y no ticker/price: aquél da la mejor compra y venta ahora,
    // éste sólo el último operado.
    const data = await fetchJson(`${BINANCE_API}/api/v3/ticker/bookTicker`, {
      searchParams: { symbol: pair },
      timeoutMs,
      retries: 1,
    });
    return { ...midOrLast({ bid: data && data.bidPrice, ask: data && data.askPrice }), pair };
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
    // a = mejor venta, b = mejor compra, c = [último operado, volumen]
    const ask = entry && Array.isArray(entry.a) ? entry.a[0] : null;
    const bid = entry && Array.isArray(entry.b) ? entry.b[0] : null;
    const last = entry && Array.isArray(entry.c) ? entry.c[0] : null;

    return { ...midOrLast({ bid, ask, last }), pair };
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

    return {
      ...midOrLast({ bid: data && data.best_bid, ask: data && data.best_ask, last: trade && trade.price }),
      pair,
    };
  },
};

// --- Gemini ----------------------------------------------------------------

const gemini = {
  meta: { id: 'gemini', label: 'Gemini', quote: 'USD' },
  // Gemini nombra sus pares en minúsculas y sin separador.
  pairFor: (symbol) => `${baseAsset(symbol).toLowerCase()}usd`,

  async fetchPrice({ symbol, timeoutMs = 6000 }) {
    const pair = gemini.pairFor(symbol);
    const data = await fetchJson(`${GEMINI_API}/v1/pubticker/${encodeURIComponent(pair)}`, {
      timeoutMs,
      retries: 1,
    });

    // Sus errores llegan con un 4xx y fetchJson ya los convierte en excepción,
    // pero el cuerpo también los marca: si viene, se dice por qué.
    if (data && data.result === 'error') {
      throw new Error(`Gemini: ${data.reason || data.message || 'error sin detalle'}`);
    }

    return { ...midOrLast({ bid: data && data.bid, ask: data && data.ask, last: data && data.last }), pair };
  },
};

// --- CF Benchmarks ---------------------------------------------------------
//
// Esto NO es un mercado, es un índice: el BRTI agrega varios exchanges con una
// metodología publicada y regulada. Eso trae dos consecuencias.
//
// La primera es que no tiene libro ni operaciones: publica un valor. Por eso
// su `source` es "índice" y no pasa por la regla del punto medio.
//
// La segunda es que, si ya agrega a Coinbase y Kraken, meterlo en la misma
// mediana que ellos los cuenta dos veces. Por eso viene marcado `optIn`: no
// entra en la selección por defecto. Si lo que quieres es seguir el índice,
// lo lógico es marcarlo a él y desmarcar los exchanges que agrega.
//
// Sólo cubre los activos para los que publica índice en tiempo real.

const CF_INDICES = { BTC: 'BRTI', ETH: 'ETHUSD_RTI' };

const cfbenchmarks = {
  meta: { id: 'cfbenchmarks', label: 'CF Benchmarks', quote: 'USD', optIn: true, kind: 'índice' },
  pairFor: (symbol) => CF_INDICES[baseAsset(symbol)] || null,

  async fetchPrice({ symbol, timeoutMs = 6000 }) {
    const pair = cfbenchmarks.pairFor(symbol);
    if (!pair) throw new Error(`CF Benchmarks no publica índice en tiempo real para ${baseAsset(symbol)}`);

    const data = await fetchJson(`${CFBENCHMARKS_API}/api/v1/values/latest`, {
      searchParams: { id: pair },
      headers: CFBENCHMARKS_KEY ? { authorization: `Bearer ${CFBENCHMARKS_KEY}` } : {},
      timeoutMs,
      retries: 1,
    });

    const entrada = data && Array.isArray(data.payload) ? data.payload[0] : data;
    const valor = toNum(entrada && (entrada.value !== undefined ? entrada.value : entrada.price));

    // Un índice no tiene libro: o hay valor o no hay nada que promediar.
    return { price: valor, source: valor ? 'índice' : null, pair };
  },
};

const VENUES = [binance, kraken, coinbase, gemini, cfbenchmarks];

// Los mercados que entran cuando no se pide nada en concreto: todos menos los
// marcados `optIn`, que hay que elegir a propósito.
function defaultVenues() {
  return VENUES.filter((v) => !v.meta.optIn);
}

// --- USDT contra dólares ---------------------------------------------------
//
// Binance cotiza en USDT y las otras tres en dólares, y eso no es un detalle:
// en la primera medición real las tres en dólares coincidían dentro del
// 0,011% y Binance se iba sola un 0,044%. Meter ese desvío en la mediana es
// contaminar el consolidado con el precio del USDT, no con el del bitcoin —
// y quien liquide en dólares (Kalshi, entre otros) no lo tiene.
//
// Así que se mide el USDT/USD y se convierte. Si no se puede medir, no se
// inventa una paridad: se deja el precio como está y se dice que no se
// convirtió.

async function fetchStableRate({ timeoutMs = 6000 } = {}) {
  // Kraken primero por ser el mismo sitio del que ya se fía el consolidado.
  try {
    const data = await fetchJson(`${KRAKEN_API}/0/public/Ticker`, {
      searchParams: { pair: 'USDTZUSD' },
      timeoutMs,
      retries: 0,
    });
    if (!(data && Array.isArray(data.error) && data.error.length)) {
      const entry = data && data.result ? Object.values(data.result)[0] : null;
      const { price } = midOrLast({
        bid: entry && entry.b && entry.b[0],
        ask: entry && entry.a && entry.a[0],
        last: entry && entry.c && entry.c[0],
      });
      if (sensata(price)) return { rate: price, source: 'kraken', pair: 'USDTUSD' };
    }
  } catch {
    /* se prueba el siguiente */
  }

  try {
    const data = await fetchJson(`${COINBASE_API}/api/v3/brokerage/market/products/USDT-USD/ticker`, {
      searchParams: { limit: 1 },
      timeoutMs,
      retries: 0,
    });
    const trade = data && Array.isArray(data.trades) ? data.trades[0] : null;
    const { price } = midOrLast({ bid: data && data.best_bid, ask: data && data.best_ask, last: trade && trade.price });
    if (sensata(price)) return { rate: price, source: 'coinbase', pair: 'USDT-USD' };
  } catch {
    /* sin conversión */
  }

  return null;
}

// Una stablecoin fuera de este rango no es una cotización, es un error de
// lectura — y convertir con ella estropearía el consolidado en vez de
// arreglarlo.
function sensata(rate) {
  return Number.isFinite(rate) && rate > 0.9 && rate < 1.1;
}
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
const DESVIO_DEMO = { binance: -0.00018, kraken: 0.00011, coinbase: 0.00004, gemini: 0.00021, cfbenchmarks: 0.00002 };

function demoQuotes({ symbol, now, venues = null }) {
  const [vela] = buildDemoCandles({ symbol, interval: '1m', limit: 1, now });
  const base = vela ? vela.close : null;
  const elegidos = venues && venues.length ? VENUES.filter((v) => venues.includes(v.meta.id)) : defaultVenues();

  return elegidos.map((venue) => {
    const desvio = DESVIO_DEMO[venue.meta.id] || 0;
    // Una pizca de ruido para que no se queden clavados unos respecto a otros.
    const ruido = Math.sin(now / 3000 + venue.meta.id.length) * 0.00003;
    return {
      ...venue.meta,
      ok: base !== null,
      price: base === null ? null : base * (1 + desvio + ruido),
      source: venue.meta.kind === 'índice' ? 'índice' : 'libro',
      pair: venue.pairFor(symbol),
      at: now,
      elapsedMs: 0,
      demo: true,
    };
  });
}

async function fetchAllPrices({ symbol = 'BTCUSDT', timeoutMs = 6000, venues = null, demo = false, now = Date.now() } = {}) {
  if (demo) return demoQuotes({ symbol, now, venues });

  const selected = venues && venues.length ? VENUES.filter((v) => venues.includes(v.meta.id)) : defaultVenues();
  const hayUsdt = selected.some((v) => v.meta.quote === 'USDT');

  // El cambio se pide a la vez que los precios, no después: si no, el
  // consolidado llevaría precios de un instante y un cambio de otro.
  const [quotes, stable] = await Promise.all([
    fetchQuotes(selected, { symbol, timeoutMs, now }),
    hayUsdt ? fetchStableRate({ timeoutMs }) : Promise.resolve(null),
  ]);

  return quotes.map((q) => {
    if (q.quote !== 'USDT' || !q.ok || !stable) {
      return { ...q, priceRaw: q.price, converted: false, stable: q.quote === 'USDT' ? stable : null };
    }
    return {
      ...q,
      priceRaw: q.price,
      price: redondearPrecio(q.price * stable.rate),
      converted: true,
      stable,
    };
  });
}

function fetchQuotes(selected, { symbol, timeoutMs, now }) {
  return Promise.all(
    selected.map(async (venue) => {
      const startedAt = Date.now();
      try {
        const { price, pair, source } = await venue.fetchPrice({ symbol, timeoutMs });
        if (!(price > 0)) throw new Error('respuesta sin precio utilizable');
        return { ...venue.meta, ok: true, price, pair, source, at: now, elapsedMs: Date.now() - startedAt };
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

// Filtra una lista de identificadores pedida por el cliente: se queda con los
// que existen y, si no queda ninguno, devuelve null para que se usen todos.
// Mejor todos que ninguno: un parámetro mal escrito no debe dejar sin precio.
function parseVenues(raw) {
  const pedidos = String(raw || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const validos = pedidos.filter((id) => byId.has(id));
  return validos.length ? [...new Set(validos)] : null;
}

module.exports = {
  VENUES, byId, listVenues, fetchAllPrices, demoQuotes, midOrLast, parseVenues, baseAsset,
  fetchStableRate, sensata, redondearPrecio, defaultVenues,
  binance, kraken, coinbase, gemini, cfbenchmarks,
};
