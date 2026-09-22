'use strict';

// Precio consolidado de varios mercados.
//
// Se usa la MEDIANA y no la media: con tres mercados, uno que se quede colgado
// con un precio viejo o devuelva una barbaridad no puede arrastrar el
// resultado, mientras que a una media le bastaría. Con dos, la mediana es la
// media de los dos, que es lo único razonable. Con uno, ese.
//
// Y se publica siempre el detalle por mercado con su diferencia: la parte útil
// no es el número consolidado sino ver CUÁNTO discrepan. Buena parte de esa
// diferencia ni siquiera es desacuerdo sobre el activo — Binance cotiza contra
// USDT y Kraken y Coinbase contra dólares, y USDT no vale exactamente un
// dólar.

const STALE_MS = 10_000;

function median(values) {
  if (!values.length) return null;
  const orden = [...values].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

function round(value, decimals) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * @param quotes  [{ id, label, quote, pair, price, at, ok, error }]
 * @returns precio consolidado, detalle por mercado y cuánto discrepan
 */
function consolidate(quotes = [], { now = Date.now(), staleMs = STALE_MS } = {}) {
  const detalle = quotes.map((q) => {
    const ageMs = Number.isFinite(q.at) ? Math.max(now - q.at, 0) : null;
    const usable = q.ok !== false && q.price > 0 && (ageMs === null || ageMs <= staleMs);
    return { ...q, ageMs, usable };
  });

  const usados = detalle.filter((q) => q.usable);
  const precios = usados.map((q) => q.price);
  const price = median(precios);

  if (price === null) {
    return {
      price: null,
      method: null,
      used: 0,
      venues: detalle.map((q) => ({ ...q, diff: null, diffPct: null })),
      spread: null,
      spreadPct: null,
      agreement: 'sin precio',
      staleMs,
    };
  }

  const min = Math.min(...precios);
  const max = Math.max(...precios);
  const spread = max - min;
  const spreadPct = (spread / price) * 100;

  return {
    price: round(price, 8),
    method: usados.length >= 3 ? 'mediana' : usados.length === 2 ? 'media de dos' : 'único mercado',
    used: usados.length,
    venues: detalle.map((q) => ({
      ...q,
      diff: q.price > 0 ? round(q.price - price, 8) : null,
      diffPct: q.price > 0 ? round(((q.price - price) / price) * 100, 4) : null,
    })),
    spread: round(spread, 8),
    spreadPct: round(spreadPct, 4),
    // Umbrales pensados para cripto al contado: por debajo de cinco puntos
    // básicos los mercados están de acuerdo a efectos prácticos. Con uno solo
    // no hay acuerdo posible, y decir "alineados · 0%" sugeriría una
    // confirmación que no existe.
    agreement:
      usados.length < 2
        ? 'sin comparación'
        : spreadPct < 0.05
          ? 'alineados'
          : spreadPct < 0.2
            ? 'ligera diferencia'
            : 'discrepan',
    staleMs,
  };
}

module.exports = { consolidate, median, STALE_MS };
