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

const app = express();
const PORT = process.env.PORT || 3000;

// Carpeta pública
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Proxy hacia Binance Market Data
app.get('/api/klines', (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
  const interval = req.query.interval || '1h';
  const limit = req.query.limit || '300';

  const binanceUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;

  console.log('>> Proxy a Binance:', binanceUrl);

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
        .status(500)
        .json({ error: 'Error al obtener datos de Binance', details: err.message });
    });
});

// ---------------------------------------------------------------------------
// Analizador de mercados de predicción
// ---------------------------------------------------------------------------

const DEMO_ALWAYS = process.env.DEMO === '1';

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

  return {
    query: String(req.query.q || req.query.query || '').trim(),
    platforms: platforms.length ? platforms : null,
    limit: toInt(req.query.limit, 25, 100),
    fetchLimit: toInt(req.query.fetchLimit, 80, 200),
    minLiquidity: Number(req.query.minLiquidity) || 0,
    threshold: Number(req.query.threshold) || 0.5,
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

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('Trading:     /index.html');
  console.log('Predicciones: /predicciones.html');
  if (DEMO_ALWAYS) console.log('MODO DEMO activo: datos de ejemplo, no precios reales.');
});

module.exports = app;
