'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fetchJson } = require('./http');
const { signedHeaders } = require('./kalshi-reference');
function normalizar(raw, at = Date.now()) {
  function niveles(rows) {
    if (!Array.isArray(rows)) throw new Error('Libro sin profundidad verificable');
    return rows.map(row => {
      const precio = Number(row[0]), cantidad = Number(row[1]);
      if (!(precio > 0 && precio < 1 && Number.isFinite(cantidad) && cantidad >= 0)) throw new Error('Nivel de libro inválido');
      return { precio, cantidad };
    }).filter(r => r.cantidad > 0).sort((a, b) => b.precio - a.precio);
  }
  const yes = niveles(raw?.orderbook_fp?.yes_dollars), no = niveles(raw?.orderbook_fp?.no_dollars);
  return { at, yes, no };
}
function aplicar(m, book) {
  const y = book.yes[0], n = book.no[0];
  return { ...m, bookAt: book.at, yesBid: y?.precio ?? null, noBid: n?.precio ?? null,
    yesAsk: n ? Number((1 - n.precio).toFixed(4)) : null,
    noAsk: y ? Number((1 - y.precio).toFixed(4)) : null,
    libro: { yesAsk: n?.cantidad ?? 0, noAsk: y?.cantidad ?? 0, yesBid: y?.cantidad ?? 0, noBid: n?.cantidad ?? 0 } };
}
async function obtener(ticker) {
  const url = 'https://external-api.kalshi.com/trade-api/v2/markets/' + encodeURIComponent(ticker) + '/orderbook';
  const key = fs.readFileSync(path.resolve(__dirname, '..', process.env.KALSHI_PRIVATE_KEY_PATH || 'missing'));
  // Usar inicio de petición: una respuesta lenta no rejuvenece una cotización antigua.
  const at = Date.now();
  const raw = await fetchJson(url, { headers: signedHeaders(process.env.KALSHI_API_KEY_ID, key, url), timeoutMs: 6000, retries: 0 });
  return normalizar(raw, at);
}
module.exports = { normalizar, aplicar, obtener };
