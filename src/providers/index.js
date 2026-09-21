'use strict';

const polymarket = require('./polymarket');
const kalshi = require('./kalshi');
const manifold = require('./manifold');

const PROVIDERS = [polymarket, kalshi, manifold];

const byPlatform = new Map(PROVIDERS.map((p) => [p.meta.platform, p]));

function listProviders() {
  return PROVIDERS.map((p) => ({ ...p.meta }));
}

// Consulta todas las plataformas en paralelo. Que una caiga no puede tumbar el
// análisis: cada fuente reporta su propio estado y el agregador sigue con las
// que respondieron.
async function fetchAll({ limit = 60, query = '', platforms = null, timeoutMs = 10000, full = false } = {}) {
  const selected = platforms && platforms.length
    ? PROVIDERS.filter((p) => platforms.includes(p.meta.platform))
    : PROVIDERS;

  const results = await Promise.all(
    selected.map(async (provider) => {
      const startedAt = Date.now();
      try {
        const events = await provider.fetchEvents({ limit, query, timeoutMs, full });
        return {
          status: {
            platform: provider.meta.platform,
            platformLabel: provider.meta.platformLabel,
            ok: true,
            events: events.length,
            elapsedMs: Date.now() - startedAt,
            error: null,
          },
          events,
        };
      } catch (err) {
        return {
          status: {
            platform: provider.meta.platform,
            platformLabel: provider.meta.platformLabel,
            ok: false,
            events: 0,
            elapsedMs: Date.now() - startedAt,
            error: err.message,
          },
          events: [],
        };
      }
    })
  );

  return {
    events: results.flatMap((r) => r.events),
    sources: results.map((r) => r.status),
  };
}

module.exports = { PROVIDERS, byPlatform, listProviders, fetchAll };
