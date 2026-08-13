'use strict';

const { fetchJson } = require('../http');
const { buildEvent, toIso, parseMaybeJsonArray } = require('./base');
const { canonicalLabelKey, toNumber } = require('../normalize');

const GAMMA_BASE = process.env.POLYMARKET_API || 'https://gamma-api.polymarket.com';

const meta = {
  platform: 'polymarket',
  platformLabel: 'Polymarket',
  credibility: 1, // dinero real, libro profundo
  homepage: 'https://polymarket.com',
};

function pickNumber(...values) {
  for (const value of values) {
    const n = toNumber(value);
    if (n !== null) return n;
  }
  return 0;
}

function yesIndex(outcomes) {
  const idx = outcomes.findIndex((o) => canonicalLabelKey(o) === 'yes');
  return idx === -1 ? 0 : idx;
}

// Un evento de Polymarket con un solo mercado es un binario Sí/No; con varios
// mercados, cada mercado es un candidato/opción y el precio relevante es su
// pata "Yes".
function optionsFromEvent(event) {
  const markets = (event.markets || []).filter((m) => m && m.closed !== true);
  if (markets.length === 0) return [];

  if (markets.length === 1) {
    const market = markets[0];
    const outcomes = parseMaybeJsonArray(market.outcomes);
    const prices = parseMaybeJsonArray(market.outcomePrices);
    const bestBid = toNumber(market.bestBid);
    const bestAsk = toNumber(market.bestAsk);
    const yes = yesIndex(outcomes);

    return outcomes.map((label, i) => {
      const isYes = i === yes;
      return {
        label,
        // El libro sólo se publica para la pata "Yes"; la pata contraria se
        // deriva por complemento (comprar No a X == vender Yes a 1-X).
        bid: isYes ? bestBid : bestAsk === null ? null : 1 - bestAsk,
        ask: isYes ? bestAsk : bestBid === null ? null : 1 - bestBid,
        last: toNumber(prices[i]),
        volume: pickNumber(market.volumeNum, market.volume),
        liquidity: pickNumber(market.liquidityNum, market.liquidity),
      };
    });
  }

  return markets.map((market) => {
    const outcomes = parseMaybeJsonArray(market.outcomes);
    const prices = parseMaybeJsonArray(market.outcomePrices);
    const yes = yesIndex(outcomes);
    return {
      label: market.groupItemTitle || market.question || 'Opción',
      bid: toNumber(market.bestBid),
      ask: toNumber(market.bestAsk),
      last: toNumber(prices[yes]),
      volume: pickNumber(market.volumeNum, market.volume),
      liquidity: pickNumber(market.liquidityNum, market.liquidity),
    };
  });
}

function mapEvent(event) {
  const options = optionsFromEvent(event);
  if (options.length === 0) return null;

  const markets = (event.markets || []).filter((m) => m && m.closed !== true);
  // negRisk marca los eventos donde exactamente una opción puede resolver Sí.
  // Un binario de un solo mercado también lo es por construcción.
  const mutuallyExclusive = markets.length === 1 || Boolean(event.negRisk);

  return buildEvent({
    ...meta,
    id: event.slug || event.id || event.ticker,
    title: event.title || markets[0]?.question || 'Evento sin título',
    url: event.slug ? `https://polymarket.com/event/${event.slug}` : meta.homepage,
    closesAt: toIso(event.endDate || markets[0]?.endDate),
    mutuallyExclusive,
    volume: pickNumber(event.volume, event.volumeNum),
    liquidity: pickNumber(event.liquidity, event.liquidityNum),
    options,
  });
}

async function fetchEvents({ limit = 60, timeoutMs = 10000 } = {}) {
  const raw = await fetchJson(`${GAMMA_BASE}/events`, {
    timeoutMs,
    searchParams: {
      closed: 'false',
      active: 'true',
      archived: 'false',
      limit: Math.min(limit, 100),
      order: 'volume24hr',
      ascending: 'false',
    },
  });

  const events = Array.isArray(raw) ? raw : raw?.data || [];
  return events.map(mapEvent).filter(Boolean);
}

module.exports = { meta, fetchEvents, mapEvent, optionsFromEvent };
