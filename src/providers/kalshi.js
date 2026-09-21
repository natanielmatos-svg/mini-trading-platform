'use strict';

const { fetchJson } = require('../http');
const { buildEvent, toIso } = require('./base');
const { toNumber } = require('../normalize');

// Los "prediction markets" de Robinhood son contratos de evento listados en la
// bolsa Kalshi: Robinhood es el bróker, el libro de órdenes y el precio son los
// de Kalshi. Por eso esta fuente cubre ambas plataformas a la vez.
const KALSHI_BASE = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';

const meta = {
  platform: 'robinhood_kalshi',
  platformLabel: 'Robinhood / Kalshi',
  credibility: 1, // dinero real, exchange regulado (CFTC)
  homepage: 'https://kalshi.com',
};

// Kalshi cotiza en centavos (1-99). Todo el resto del sistema trabaja en 0..1.
function centsToProb(value) {
  const n = toNumber(value);
  if (n === null || n <= 0 || n >= 100) return null;
  return n / 100;
}

function optionsFromEvent(event) {
  const markets = (event.markets || []).filter(
    (m) => m && (m.status === undefined || m.status === 'active' || m.status === 'open')
  );
  if (markets.length === 0) return [];

  const asDollars = (cents) => (toNumber(cents) || 0) / 100;

  if (markets.length === 1) {
    const m = markets[0];
    return [
      {
        label: m.yes_sub_title || 'Sí',
        bid: centsToProb(m.yes_bid),
        ask: centsToProb(m.yes_ask),
        last: centsToProb(m.last_price),
        volume: toNumber(m.volume) || 0,
        liquidity: asDollars(m.liquidity),
      },
      {
        label: m.no_sub_title || 'No',
        bid: centsToProb(m.no_bid),
        ask: centsToProb(m.no_ask),
        last: centsToProb(m.last_price) === null ? null : 1 - centsToProb(m.last_price),
        volume: toNumber(m.volume) || 0,
        liquidity: asDollars(m.liquidity),
      },
    ];
  }

  return markets.map((m) => ({
    label: m.yes_sub_title || m.subtitle || m.title || m.ticker,
    bid: centsToProb(m.yes_bid),
    ask: centsToProb(m.yes_ask),
    last: centsToProb(m.last_price),
    volume: toNumber(m.volume) || 0,
    liquidity: asDollars(m.liquidity),
  }));
}

function mapEvent(event) {
  const options = optionsFromEvent(event);
  if (options.length === 0) return null;

  const markets = event.markets || [];
  const closesAt = markets
    .map((m) => toIso(m.close_time))
    .filter(Boolean)
    .sort()[0] || null;

  return buildEvent({
    ...meta,
    id: event.event_ticker || event.series_ticker,
    title: event.title || markets[0]?.title || 'Evento sin título',
    url: `https://kalshi.com/markets/${String(event.series_ticker || event.event_ticker || '').toLowerCase()}`,
    closesAt,
    // Kalshi expone explícitamente si el evento admite un solo ganador.
    mutuallyExclusive: markets.length === 1 || Boolean(event.mutually_exclusive),
    options,
  });
}

async function fetchEvents({ limit = 100, timeoutMs = 10000 } = {}) {
  const raw = await fetchJson(`${KALSHI_BASE}/events`, {
    timeoutMs,
    searchParams: {
      status: 'open',
      limit: Math.min(limit, 200),
      with_nested_markets: 'true',
    },
  });

  const events = Array.isArray(raw?.events) ? raw.events : [];
  return events.map(mapEvent).filter(Boolean);
}

module.exports = { meta, fetchEvents, mapEvent, optionsFromEvent, centsToProb };
