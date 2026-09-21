'use strict';

const path = require('path');
const fs = require('fs');

const { TtlCache } = require('./cache');
const providers = require('./providers');
const polymarket = require('./providers/polymarket');
const kalshi = require('./providers/kalshi');
const manifold = require('./providers/manifold');
const { analyzeEvents } = require('./analyze');
const { normalizeText } = require('./normalize');
const catalog = require('./catalog');

// Los datos de mercado se refrescan cada 30s: suficiente para seguir el precio
// sin castigar los rate limits de las APIs públicas.
const cache = new TtlCache({ ttlMs: Number(process.env.PREDICTIONS_TTL_MS || 30000) });

const DEMO_DIR = path.join(__dirname, '..', 'data', 'demo');

function readDemoFile(name) {
  return JSON.parse(fs.readFileSync(path.join(DEMO_DIR, name), 'utf8'));
}

// Modo demo: mismos parsers, datos de ejemplo. Sirve para desarrollar sin red
// y nunca se activa solo — hay que pedirlo con DEMO=1 o ?demo=1, para que
// nadie confunda datos de ejemplo con precios reales.
function loadDemoEvents() {
  const events = [
    ...readDemoFile('polymarket-events.json').map(polymarket.mapEvent),
    ...(readDemoFile('kalshi-events.json').events || []).map(kalshi.mapEvent),
    ...readDemoFile('manifold-markets.json').map(manifold.mapMarket),
  ].filter(Boolean);

  const sources = providers.listProviders().map((meta) => ({
    platform: meta.platform,
    platformLabel: meta.platformLabel,
    ok: true,
    events: events.filter((e) => e.platform === meta.platform).length,
    elapsedMs: 0,
    error: null,
    demo: true,
  }));

  return { events, sources };
}

async function loadEvents({ platforms, fetchLimit, timeoutMs, demo }) {
  if (demo) return loadDemoEvents();

  const key = `events:${(platforms || ['*']).join(',')}:${fetchLimit}`;
  return cache.wrap(key, () =>
    providers.fetchAll({ limit: fetchLimit, platforms, timeoutMs })
  );
}

// Filtra el análisis ya calculado del catálogo. Aquí no se vuelve a agrupar
// nada: agrupar miles de eventos cuesta segundos y eso ya se hizo en el último
// refresco de fondo.
function filterAnalyses(analyses, { query, category, platforms, crossOnly, minConfidence }) {
  const tokens = normalizeText(query || '').split(' ').filter(Boolean);

  return analyses.filter((a) => {
    if (category && category !== 'todas' && a.category !== category) return false;
    if (crossOnly && !a.crossPlatform) return false;
    if (minConfidence && a.confidence < minConfidence) return false;

    if (platforms && platforms.length) {
      if (!a.sources.some((s) => platforms.includes(s.platform))) return false;
    }

    if (tokens.length) {
      const haystack = normalizeText(
        [a.title, ...a.options.map((o) => o.label)].join(' ')
      );
      if (!tokens.every((t) => haystack.includes(t))) return false;
    }

    return true;
  });
}

/**
 * Punto de entrada del analizador: descarga los mercados abiertos de todas las
 * plataformas, agrupa los que son el mismo evento y devuelve, para cada uno,
 * qué opción es la más probable según el consenso ponderado.
 *
 * Si el catálogo de fondo ya tiene una foto completa, se sirve de ahí. Si no
 * —arranque en frío, o modo demo— se hace una consulta rápida en el momento.
 */
async function getPredictions({
  query = '',
  category = null,
  platforms = null,
  limit = 25,
  minLiquidity = 0,
  fetchLimit = 80,
  threshold = 0.5,
  timeoutMs = 10000,
  crossOnly = false,
  minConfidence = 0,
  demo = false,
} = {}) {
  const snap = catalog.snapshot();

  if (!demo && snap.ready) {
    const filtradas = filterAnalyses(snap.analyses, {
      query, category, platforms, crossOnly, minConfidence,
    });

    return {
      generatedAt: snap.generatedAt,
      ageSeconds: snap.ageSeconds,
      refreshing: snap.refreshing,
      source: 'catálogo',
      demo: false,
      query,
      category,
      sources: snap.sources,
      counts: {
        rawEvents: snap.events.length,
        analyzedEvents: snap.analyses.length,
        crossPlatformEvents: snap.analyses.filter((a) => a.crossPlatform).length,
        matching: filtradas.length,
      },
      categories: countByCategory(snap.analyses),
      events: filtradas.slice(0, limit),
    };
  }

  const { events, sources } = await loadEvents({ platforms, fetchLimit, timeoutMs, demo });
  const analyses = analyzeEvents(events, { query, limit: 5000, minLiquidity, threshold });
  const filtradas = filterAnalyses(analyses, { category, platforms: null, crossOnly, minConfidence });

  return {
    generatedAt: new Date().toISOString(),
    ageSeconds: 0,
    refreshing: snap.refreshing,
    source: demo ? 'ejemplo' : 'consulta directa',
    demo: Boolean(demo),
    query,
    category,
    sources,
    counts: {
      rawEvents: events.length,
      analyzedEvents: analyses.length,
      crossPlatformEvents: analyses.filter((a) => a.crossPlatform).length,
      matching: filtradas.length,
    },
    categories: countByCategory(analyses),
    events: filtradas.slice(0, limit),
  };
}

function countByCategory(analyses) {
  const counts = {};
  for (const a of analyses) counts[a.category] = (counts[a.category] || 0) + 1;
  return Object.entries(counts)
    .sort((x, y) => y[1] - x[1])
    .map(([name, total]) => ({ name, total }));
}

// Versión "respuesta directa": la mejor opción del evento que mejor encaja con
// la búsqueda, para consumo rápido desde otra app o desde la CLI.
async function getBestAnswer(options = {}) {
  const result = await getPredictions({ ...options, limit: 1 });
  const event = result.events[0] || null;

  return {
    generatedAt: result.generatedAt,
    demo: result.demo,
    query: result.query,
    sources: result.sources,
    found: Boolean(event),
    event: event
      ? {
          id: event.id,
          title: event.title,
          url: event.url,
          closesAt: event.closesAt,
          mostLikely: event.mostLikely,
          confidence: event.confidence,
          verdict: event.verdict,
          flags: event.flags,
          options: event.options.map((o) => ({
            label: o.label,
            probability: o.probability,
            platformCount: o.platformCount,
          })),
        }
      : null,
  };
}

module.exports = { getPredictions, getBestAnswer, cache, loadDemoEvents, filterAnalyses, catalog };
