'use strict';

const { fetchJson } = require('../http');
const { buildEvent, toIso, paginate, classifyCategory } = require('./base');
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

function validProb(p) {
  return p !== null && p > 0 && p < 1 ? p : null;
}

// Kalshi cotiza en centavos (1-99). Todo el resto del sistema trabaja en 0..1.
function centsToProb(value) {
  const n = toNumber(value);
  return n === null ? null : validProb(n / 100);
}

// Kalshi renombró sus campos de precio: antes enteros en centavos (`yes_bid`),
// ahora decimales en dólares (`yes_bid_dollars`). Se prefieren los nuevos y se
// cae a los viejos, de modo que un despliegue contra cualquiera de las dos
// generaciones de la API sigue funcionando.
function priceOf(market, campo) {
  const dollars = toNumber(market[`${campo}_dollars`]);
  if (dollars !== null) return validProb(dollars);
  return centsToProb(market[campo]);
}

// El volumen sólo entra en la ponderación, y lo hace en escala logarítmica:
// una unidad distinta desplaza el peso, no invierte el resultado.
function volumeOf(market) {
  return toNumber(market.volume_fp) ?? toNumber(market.volume) ?? 0;
}

function liquidityOf(market) {
  const dollars = toNumber(market.liquidity_dollars);
  if (dollars !== null) return dollars;
  return (toNumber(market.liquidity) || 0) / 100; // la API vieja daba centavos
}

function usableMarkets(event) {
  return (event.markets || []).filter((m) => {
    if (!m) return false;
    if (m.status !== undefined && m.status !== 'active' && m.status !== 'open') return false;
    // Los mercados "MVE" son combinadas de varias patas ("yes Toronto, yes
    // Detroit, …"): no son una opción de un evento, son una apuesta múltiple.
    if (m.mve_collection_ticker || (Array.isArray(m.mve_selected_legs) && m.mve_selected_legs.length)) {
      return false;
    }
    return true;
  });
}

function optionsFromEvent(event) {
  const markets = usableMarkets(event);
  if (markets.length === 0) return [];

  if (markets.length === 1) {
    const m = markets[0];
    const yesLast = priceOf(m, 'last_price');
    return [
      {
        label: m.yes_sub_title || 'Sí',
        bid: priceOf(m, 'yes_bid'),
        ask: priceOf(m, 'yes_ask'),
        last: yesLast,
        volume: volumeOf(m),
        liquidity: liquidityOf(m),
      },
      {
        label: m.no_sub_title || 'No',
        bid: priceOf(m, 'no_bid'),
        ask: priceOf(m, 'no_ask'),
        last: yesLast === null ? null : 1 - yesLast,
        volume: volumeOf(m),
        liquidity: liquidityOf(m),
      },
    ];
  }

  return markets.map((m) => ({
    label: m.yes_sub_title || m.subtitle || m.title || m.ticker,
    bid: priceOf(m, 'yes_bid'),
    ask: priceOf(m, 'yes_ask'),
    last: priceOf(m, 'last_price'),
    volume: volumeOf(m),
    liquidity: liquidityOf(m),
  }));
}

function mapEvent(event) {
  const options = optionsFromEvent(event);
  if (options.length === 0) return null;

  const markets = usableMarkets(event);
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
    category: classifyCategory(event.category, event.title, event.sub_title),
    options,
  });
}

async function fetchEvents({ limit = 100, timeoutMs = 10000, full = false } = {}) {
  const pedir = async ({ cursor, limit: pageSize }) => {
    const page = await fetchJson(`${KALSHI_BASE}/events`, {
      timeoutMs,
      searchParams: {
        status: 'open',
        limit: pageSize,
        with_nested_markets: 'true',
        cursor: cursor || undefined,
      },
    });
    return { batch: Array.isArray(page?.events) ? page.events : [], nextCursor: page?.cursor || null };
  };

  if (full) {
    // Kalshi pagina por cursor, no por offset.
    const raw = await paginate(pedir, {
      maxPages: Number(process.env.KALSHI_MAX_PAGES || 100),
      pageSize: 200,
    });
    const mapped = raw.map(mapEvent).filter(Boolean);
    if (raw.note) mapped.note = raw.note;
    return mapped;
  }

  const { batch } = await pedir({ cursor: null, limit: Math.min(limit, 200) });
  return batch.map(mapEvent).filter(Boolean);
}

module.exports = {
  meta,
  fetchEvents,
  mapEvent,
  optionsFromEvent,
  centsToProb,
  priceOf,
};
