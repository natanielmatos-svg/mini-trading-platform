// server.js
// Backend en Node + Express que:
// - Sirve el frontend desde ./public
// - Expone /api/klines como proxy hacia Binance (market data) para evitar CORS
// - Expone /api/predictions*: analizador de mercados de predicción que agrega
//   Polymarket, Robinhood/Kalshi y Manifold y dice qué opción es más probable

const express = require('express');
const path = require('path');
const https = require('https');

const { getPredictions, getBestAnswer } = require('./src/api');
const { listProviders } = require('./src/providers');
const catalog = require('./src/catalog');
const { CATEGORY_NAMES } = require('./src/providers/base');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();
const DEMO_ALWAYS = process.env.DEMO === '1';

// Detrás de Nginx, el cliente real viene en X-Forwarded-For; sin esto el
// limitador de peticiones vería una sola IP (la del proxy) para todo el mundo.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

// Carpeta pública
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ---------------------------------------------------------------------------
// Límite de peticiones
// ---------------------------------------------------------------------------

// Ventana deslizante por IP, en memoria. No pretende frenar un ataque serio
// —para eso está el proxy de delante— sino evitar que un bucle descontrolado
// del navegador de alguien acabe agotando los rate limits de las APIs ajenas.
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
const RATE_MAX = Number(process.env.RATE_MAX || 120);
const hits = new Map();

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

// Comprobación de vida: no llama a ninguna API externa a propósito, para que
// una caída de Polymarket no haga que el supervisor reinicie el servicio.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    version: require('./package.json').version,
    demo: DEMO_ALWAYS,
  });
});

// Proxy hacia Binance Market Data
app.get('/api/klines', (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const allowedIntervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
  const interval = allowedIntervals.includes(req.query.interval) ? req.query.interval : '1h';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);

  const binanceUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

  https
    .get(binanceUrl, (binRes) => {
      let data = '';

      binRes.on('data', (chunk) => {
        data += chunk;
      });

      binRes.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.status(binRes.statusCode || 200).send(data);
      });
    })
    .on('error', (err) => {
      console.error('Error al llamar a Binance:', err.message);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res
        .status(502)
        .json({ error: 'Error al obtener datos de Binance', details: err.message });
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
    category: String(req.query.category || '').trim().slice(0, 30) || null,
    crossOnly: req.query.crossOnly === '1',
    minConfidence: Math.min(Math.max(Number(req.query.minConfidence) || 0, 0), 1),
    demo: DEMO_ALWAYS || req.query.demo === '1',
  };
}

function sendJson(res, payload) {
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

// Estado del catálogo de fondo: cuántos contratos tiene, de cuándo son y si
// está refrescando ahora mismo. Es lo que hay que vigilar en producción.
app.get('/api/catalog', (req, res) => {
  const snap = catalog.snapshot();
  sendJson(res, {
    ready: snap.ready,
    generatedAt: snap.generatedAt,
    ageSeconds: snap.ageSeconds,
    refreshing: snap.refreshing,
    refreshCount: snap.refreshCount,
    durationMs: snap.durationMs,
    lastError: snap.lastError,
    refreshEveryMs: catalog.REFRESH_MS,
    totals: {
      rawEvents: snap.events.length,
      analyzedEvents: snap.analyses.length,
      crossPlatformEvents: snap.analyses.filter((a) => a.crossPlatform).length,
    },
    sources: snap.sources,
    categories: CATEGORY_NAMES,
  });
});

// Lista de plataformas soportadas y su credibilidad asignada.
app.get('/api/predictions/sources', (req, res) => {
  sendJson(res, { providers: listProviders(), demo: DEMO_ALWAYS });
});

// Respuesta directa: la opción más probable del evento que mejor casa con ?q=
app.get('/api/predictions/best', async (req, res) => {
  try {
    sendJson(res, await getBestAnswer(parseOptions(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// Análisis completo: eventos agrupados entre plataformas con ranking de opciones.
app.get('/api/predictions', async (req, res) => {
  try {
    sendJson(res, await getPredictions(parseOptions(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Arranque y parada
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('Trading:      /index.html');
  console.log('Predicciones: /predicciones.html');
  if (DEMO_ALWAYS) {
    console.log('MODO DEMO activo: datos de ejemplo, no precios reales.');
  } else {
    // El catálogo completo tarda un par de minutos en formarse; hasta entonces
    // las peticiones se sirven con una consulta rápida.
    console.log('Catalogando las tres plataformas en segundo plano...');
    catalog.start();
  }
});

// systemd y Docker mandan SIGTERM al reiniciar: se deja terminar lo que hay en
// vuelo en vez de cortar respuestas a medias.
function shutdown(signal) {
  console.log(`${signal} recibido, cerrando...`);
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

module.exports = app;
