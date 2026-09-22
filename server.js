// server.js
// Backend en Node + Express que:
// - Sirve el frontend desde ./public
// - Expone /api/klines   velas OHLCV cacheadas (proxy a Binance, evita CORS)
// - Expone /api/stream   precio en vivo por SSE, alimentado por un WebSocket
//                        compartido hacia Binance
// - Expone /api/breakout análisis de ruptura de la vela en curso
// - Expone /api/predictions*: analizador de mercados de predicción que agrega
//   Polymarket, Robinhood/Kalshi y Manifold y dice qué opción es más probable

const express = require('express');
const path = require('path');

const { getPredictions, getBestAnswer } = require('./src/api');
const { listProviders } = require('./src/providers');
const { getKlines, parseSymbol, parseInterval, parseLimit, INTERVALS } = require('./src/klines');
const { analyzeBreakout } = require('./src/breakout');
const { MarketStream, sseClient } = require('./src/stream');
const { verifySymbols, groups } = require('./src/symbols');
const { fetchAllPrices, listVenues, parseVenues } = require('./src/venues');
const { consolidate } = require('./src/consolidated');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();
const DEMO_ALWAYS = process.env.DEMO === '1';

// Detrás de Nginx, el cliente real viene en X-Forwarded-For; sin esto el
// limitador de peticiones vería una sola IP (la del proxy) para todo el mundo.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

// Cabeceras de seguridad en la propia app y no sólo en Nginx: así valen también
// cuando alguien arranca el proceso a pelo para probar.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Tres módulos los comparten servidor y navegador: los indicadores, el formato
// de números y el motor de señales. El navegador carga exactamente el mismo
// archivo que ejecuta el análisis, así que no puede haber dos versiones de la
// misma regla. Lista blanca explícita y no `express.static('src')`: ahí dentro
// están también los proveedores y la orquestación.
const SHARED_MODULES = ['indicators.js', 'format.js', 'signals.js'];

app.get('/lib/:file', (req, res) => {
  if (!SHARED_MODULES.includes(req.params.file)) {
    return res.status(404).json({ error: 'Ese módulo no se publica al navegador' });
  }
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'src', req.params.file));
});

// Carpeta pública. El HTML se revalida siempre —si no, un despliegue no se ve
// hasta que el usuario fuerza la recarga— y el resto se cachea un rato.
const publicDir = path.join(__dirname, 'public');
app.use(
  express.static(publicDir, {
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// ---------------------------------------------------------------------------
// Límite de peticiones
// ---------------------------------------------------------------------------

// Ventana deslizante por IP, en memoria. No pretende frenar un ataque serio
// —para eso está el proxy de delante— sino evitar que un bucle descontrolado
// del navegador de alguien acabe agotando los rate limits de las APIs ajenas.
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
const RATE_MAX = Number(process.env.RATE_MAX || 120);
// Las conexiones SSE son largas y escasas: se limitan por número simultáneo,
// no por frecuencia, que es lo que de verdad consume recursos del servidor.
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP || 6);

const hits = new Map();
const streamsByIp = new Map();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, stamps] of hits) {
    const live = stamps.filter((t) => t > cutoff);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || 'desconocida';
  const now = Date.now();
  const stamps = (hits.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);

  if (stamps.length >= RATE_MAX) {
    res.setHeader('Retry-After', Math.ceil(RATE_WINDOW_MS / 1000));
    return res.status(429).json({
      error: 'Demasiadas peticiones',
      details: `Máximo ${RATE_MAX} por ${RATE_WINDOW_MS / 1000} s. Espera un momento.`,
    });
  }

  stamps.push(now);
  hits.set(ip, stamps);
  next();
}

app.use('/api', rateLimit);

// ---------------------------------------------------------------------------
// Salud
// ---------------------------------------------------------------------------

const stream = new MarketStream({ demo: DEMO_ALWAYS });

// Comprobación de vida: no llama a ninguna API externa a propósito, para que
// una caída de Polymarket no haga que el supervisor reinicie el servicio.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    version: require('./package.json').version,
    demo: DEMO_ALWAYS,
    streams: stream.stats(),
  });
});

// ---------------------------------------------------------------------------
// Mercado: velas, ruptura y precio en vivo
// ---------------------------------------------------------------------------

function marketParams(req) {
  return {
    symbol: parseSymbol(req.query.symbol),
    interval: parseInterval(req.query.interval),
    demo: DEMO_ALWAYS || req.query.demo === '1',
  };
}

function sendJson(res, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
}

function marketError(res, err, what) {
  console.error(`Error en ${what}:`, err.message);
  res.status(502).json({ error: `No se pudieron obtener los datos de mercado (${what})`, details: err.message });
}

// Velas OHLCV. A diferencia de la versión anterior esto ya no es un proxy
// transparente: la respuesta viene cacheada y normalizada. `format=raw`
// devuelve el array posicional de Binance para lo que aún espere aquel formato.
app.get('/api/klines', async (req, res) => {
  const { symbol, interval, demo } = marketParams(req);
  const limit = parseLimit(req.query.limit);

  try {
    const data = await getKlines({ symbol, interval, limit, demo });

    if (req.query.format === 'raw') {
      return sendJson(
        res,
        data.candles.map((c) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime])
      );
    }

    sendJson(res, { ...data, count: data.candles.length, intervals: INTERVALS });
  } catch (err) {
    marketError(res, err, '/api/klines');
  }
});

// Criptomonedas del desplegable. Cuando hay red se contrasta con Binance para
// no ofrecer un par que haya dejado de cotizar.
app.get('/api/symbols', async (req, res) => {
  const demo = DEMO_ALWAYS || req.query.demo === '1';
  const { symbols, verified, reason } = await verifySymbols({ demo });
  const disponibles = new Set(symbols.filter((s) => s.available !== false).map((s) => s.symbol));

  sendJson(res, {
    verified,
    reason,
    count: symbols.length,
    groups: groups().map((g) => ({
      name: g.name,
      symbols: g.symbols
        .map((s) => ({ ...s, available: !verified || disponibles.has(s.symbol) }))
        .filter((s) => s.available),
    })),
  });
});

// Precio consolidado de los mercados al contado. Devuelve el número y, sobre
// todo, el detalle: cuánto se separa cada mercado. Esa diferencia es la razón
// de que este endpoint exista.
app.get('/api/price', async (req, res) => {
  const { symbol, demo } = marketParams(req);
  const venues = parseVenues(req.query.venues);

  try {
    const quotes = await fetchAllPrices({ symbol, demo, venues });
    sendJson(res, { symbol, requested: venues, ...consolidate(quotes), venuesSupported: listVenues() });
  } catch (err) {
    marketError(res, err, '/api/price');
  }
});

// Análisis de ruptura de la vela en curso: niveles, distancia en ATR y la
// frecuencia histórica de recorridos equivalentes. El método está explicado en
// la cabecera de src/breakout.js y en el README.
app.get('/api/breakout', async (req, res) => {
  const { symbol, interval, demo } = marketParams(req);
  const livePrice = Number(req.query.price);

  try {
    const { candles, source, fetchedAt } = await getKlines({ symbol, interval, limit: 400, demo });
    const analysis = analyzeBreakout(candles, {
      interval,
      livePrice: Number.isFinite(livePrice) && livePrice > 0 ? livePrice : null,
    });
    sendJson(res, { symbol, interval, source, fetchedAt, ...analysis });
  } catch (err) {
    marketError(res, err, '/api/breakout');
  }
});

// Precio en vivo por SSE. El servidor mantiene una sola conexión con Binance
// por símbolo+timeframe y la reparte; ver src/stream.js.
app.get('/api/stream', (req, res) => {
  const { symbol, interval } = marketParams(req);
  const ip = req.ip || 'desconocida';
  const open = streamsByIp.get(ip) || 0;

  if (open >= MAX_STREAMS_PER_IP) {
    return res.status(429).json({
      error: 'Demasiadas conexiones en vivo',
      details: `Máximo ${MAX_STREAMS_PER_IP} simultáneas por IP. Cierra alguna pestaña.`,
    });
  }

  streamsByIp.set(ip, open + 1);
  const client = sseClient(res);
  const unsubscribe = stream.subscribe(symbol, interval, client);

  client.send('status', { symbol, interval, state: 'conectado', message: `Suscrito a ${symbol} ${interval}` });

  client.onGone(() => {
    unsubscribe();
    const left = (streamsByIp.get(ip) || 1) - 1;
    if (left > 0) streamsByIp.set(ip, left);
    else streamsByIp.delete(ip);
  });
});

// ---------------------------------------------------------------------------
// Analizador de mercados de predicción
// ---------------------------------------------------------------------------

// Cuántos eventos se piden a cada plataforma. Es una constante del servidor, no
// un parámetro de la petición: si el cliente pudiera elegirlo, cada valor sería
// una clave de caché distinta y bastaría recorrerlos para multiplicar por
// doscientas las llamadas a las APIs ajenas.
const FETCH_LIMIT = Math.min(Number(process.env.PREDICTIONS_FETCH_LIMIT || 120), 200);

function parseOptions(req) {
  const platforms = String(req.query.platforms || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const toInt = (value, fallback, max) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return max ? Math.min(n, max) : n;
  };

  const threshold = Number(req.query.threshold);

  return {
    query: String(req.query.q || req.query.query || '').trim().slice(0, 120),
    platforms: platforms.length ? platforms : null,
    limit: toInt(req.query.limit, 25, 100),
    fetchLimit: FETCH_LIMIT,
    minLiquidity: Math.max(Number(req.query.minLiquidity) || 0, 0),
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.5,
    demo: DEMO_ALWAYS || req.query.demo === '1',
  };
}

function sendPredictionJson(res, payload) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
}

function handleError(res, err) {
  console.error('Error en /api/predictions:', err);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(502).json({
    error: 'No se pudo completar el análisis de predicciones',
    details: err.message,
  });
}

// Lista de plataformas soportadas y su credibilidad asignada.
app.get('/api/predictions/sources', (req, res) => {
  sendPredictionJson(res, { providers: listProviders(), demo: DEMO_ALWAYS });
});

// Respuesta directa: la opción más probable del evento que mejor casa con ?q=
app.get('/api/predictions/best', async (req, res) => {
  try {
    sendPredictionJson(res, await getBestAnswer(parseOptions(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// Análisis completo: eventos agrupados entre plataformas con ranking de opciones.
app.get('/api/predictions', async (req, res) => {
  try {
    sendPredictionJson(res, await getPredictions(parseOptions(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Arranque y parada
// ---------------------------------------------------------------------------

// Sólo se escucha cuando el archivo se ejecuta directamente. Al requerirlo
// —los tests lo hacen— se obtiene la app sin puerto ni manejadores de señal,
// que es lo que permite levantarla en un puerto efímero y cerrarla.
function start(port = PORT) {
  const server = app.listen(port, () => {
    const address = server.address();
    console.log(`Servidor escuchando en http://localhost:${address.port}`);
    console.log('Trading:      /index.html');
    console.log('Predicciones: /predicciones.html');
    if (DEMO_ALWAYS) console.log('MODO DEMO activo: datos de ejemplo, no precios reales.');
  });

  // systemd y Docker mandan SIGTERM al reiniciar: se deja terminar lo que hay
  // en vuelo en vez de cortar respuestas a medias. Las conexiones SSE son
  // eternas por definición, así que ésas se cierran a mano o el proceso no
  // saldría nunca.
  function shutdown(signal) {
    console.log(`${signal} recibido, cerrando...`);
    stream.closeAll();
    server.close(() => {
      console.log('Servidor cerrado.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Cierre forzado tras 10 s de espera.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) start();

module.exports = app;
module.exports.start = start;
module.exports.stream = stream;
