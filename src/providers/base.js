'use strict';

const { midPrice, devig, canonicalLabelKey, toNumber } = require('../normalize');

// Forma canónica de un evento, sea cual sea la plataforma de origen:
//
//   { platform, platformLabel, credibility, id, title, url, closesAt,
//     mutuallyExclusive, volume, liquidity, overround, options: [...] }
//
// y cada opción:
//
//   { label, key, price, impliedProb, bid, ask, last, spread, priceSource,
//     volume, liquidity, url }
//
// `price` es el precio crudo del mercado (0..1) e `impliedProb` es ese precio
// después de quitar el vig cuando las opciones son mutuamente excluyentes.

function buildOption(raw) {
  const { price, spread, source } = midPrice(raw);
  return {
    label: raw.label || 'Sin nombre',
    key: canonicalLabelKey(raw.label || ''),
    price,
    impliedProb: price,
    bid: toNumber(raw.bid),
    ask: toNumber(raw.ask),
    last: toNumber(raw.last),
    spread,
    priceSource: source,
    volume: toNumber(raw.volume) || 0,
    liquidity: toNumber(raw.liquidity) || 0,
    url: raw.url || null,
  };
}

function buildEvent(raw) {
  const options = (raw.options || [])
    .map(buildOption)
    .filter((opt) => opt.price !== null);

  if (options.length === 0) return null;

  let overround = null;
  if (raw.mutuallyExclusive && options.length > 1) {
    const { probabilities, overround: over } = devig(options.map((o) => o.price));
    probabilities.forEach((p, i) => {
      if (p !== null) options[i].impliedProb = p;
    });
    overround = over;
  }

  const sum = (key) => options.reduce((acc, o) => acc + (o[key] || 0), 0);

  return {
    platform: raw.platform,
    platformLabel: raw.platformLabel,
    credibility: raw.credibility,
    id: `${raw.platform}:${raw.id}`,
    title: raw.title,
    url: raw.url || null,
    closesAt: raw.closesAt || null,
    mutuallyExclusive: Boolean(raw.mutuallyExclusive),
    volume: toNumber(raw.volume) ?? sum('volume'),
    liquidity: toNumber(raw.liquidity) ?? sum('liquidity'),
    overround,
    options,
  };
}

// Las APIs devuelven fechas en formatos distintos (ISO, epoch en segundos o
// milisegundos). Todo sale como ISO o null.
function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Polymarket devuelve varios campos como JSON serializado dentro de un string.
function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = { buildEvent, buildOption, toIso, parseMaybeJsonArray };
