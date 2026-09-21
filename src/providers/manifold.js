'use strict';

const { fetchJson } = require('../http');
const { buildEvent, toIso, paginate, classifyCategory } = require('./base');
const { toNumber } = require('../normalize');

const MANIFOLD_BASE = process.env.MANIFOLD_API || 'https://api.manifold.markets/v0';

const meta = {
  platform: 'manifold',
  platformLabel: 'Manifold',
  // Dinero de juego: sirve como tercera opinión pero no debe mover el consenso
  // tanto como un mercado con dinero real.
  credibility: 0.35,
  homepage: 'https://manifold.markets',
};

function optionsFromMarket(market) {
  const type = market.outcomeType;

  if (type === 'BINARY' || type === 'PSEUDO_NUMERIC') {
    const p = toNumber(market.probability);
    if (p === null) return [];
    return [
      { label: 'Sí', last: p, liquidity: toNumber(market.totalLiquidity) || 0, volume: toNumber(market.volume) || 0 },
      { label: 'No', last: 1 - p, liquidity: toNumber(market.totalLiquidity) || 0, volume: toNumber(market.volume) || 0 },
    ];
  }

  if (Array.isArray(market.answers) && market.answers.length > 0) {
    return market.answers
      .filter((a) => !a.resolution || a.resolution === undefined)
      .map((a) => ({
        label: a.text || a.answer || 'Opción',
        last: toNumber(a.probability),
        liquidity: (toNumber(market.totalLiquidity) || 0) / market.answers.length,
        volume: (toNumber(market.volume) || 0) / market.answers.length,
      }));
  }

  return [];
}

function mapMarket(market) {
  const options = optionsFromMarket(market);
  if (options.length === 0) return null;

  const isMultiChoice = market.outcomeType === 'MULTIPLE_CHOICE';

  return buildEvent({
    ...meta,
    id: market.id || market.slug,
    title: market.question || 'Mercado sin título',
    url: market.url || meta.homepage,
    closesAt: toIso(market.closeTime),
    mutuallyExclusive: isMultiChoice
      ? market.shouldAnswersSumToOne !== false
      : true,
    category: classifyCategory(market.question, (market.groupSlugs || []).join(' ')),
    volume: toNumber(market.volume) || 0,
    liquidity: toNumber(market.totalLiquidity) || 0,
    options,
  });
}

// La búsqueda devuelve mercados "lite" que a veces omiten las respuestas de los
// multi-opción; sólo esos se rehidratan, y con un tope para no abusar de la API.
async function hydrateMultiChoice(markets, { timeoutMs, maxHydrations = 12 }) {
  const pending = markets
    .filter((m) => m.outcomeType === 'MULTIPLE_CHOICE' && !Array.isArray(m.answers))
    .slice(0, maxHydrations);

  const hydrated = new Map();
  await Promise.all(
    pending.map(async (m) => {
      try {
        const full = await fetchJson(`${MANIFOLD_BASE}/market/${m.id}`, { timeoutMs, retries: 1 });
        hydrated.set(m.id, full);
      } catch {
        /* si falla, el mercado se descarta más abajo por no tener opciones */
      }
    })
  );

  return markets.map((m) => hydrated.get(m.id) || m);
}

async function fetchEvents({ limit = 40, query = '', timeoutMs = 10000, full = false } = {}) {
  const pedir = async ({ offset, limit: pageSize }) => {
    const page = await fetchJson(`${MANIFOLD_BASE}/search-markets`, {
      timeoutMs,
      searchParams: {
        term: query || '',
        limit: pageSize,
        offset: offset || undefined,
        sort: 'liquidity',
        filter: 'open',
        contractType: 'ALL',
      },
    });
    return { batch: Array.isArray(page) ? page : page?.data || [] };
  };

  const markets = full
    ? await paginate(pedir, {
        maxPages: Number(process.env.MANIFOLD_MAX_PAGES || 25),
        pageSize: 100,
      })
    : (await pedir({ offset: 0, limit: Math.min(limit, 100) })).batch;

  const usable = markets.filter((m) => m && !m.isResolved);
  const complete = await hydrateMultiChoice(usable, { timeoutMs, maxHydrations: full ? 80 : 12 });
  return complete.map(mapMarket).filter(Boolean);
}

module.exports = { meta, fetchEvents, mapMarket, optionsFromMarket };
