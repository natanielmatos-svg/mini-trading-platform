// server.js
// Backend simple en Node + Express que:
// - Sirve index.html desde ./public
// - Expone /api/klines como proxy hacia Binance (market data) para evitar CORS

const express = require('express');
const path = require('path');
const https = require('https');

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

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('Sirviendo frontend desde ./public');
});
