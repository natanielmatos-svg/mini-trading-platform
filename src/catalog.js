'use strict';

const providers = require('./providers');
const { analyzeEvents } = require('./analyze');

// Catalogar las tres plataformas enteras son miles de eventos y decenas de
// llamadas paginadas: entre uno y dos minutos. Eso no puede pasar dentro de una
// petición HTTP, así que el catálogo se refresca en segundo plano y las
// peticiones se sirven siempre desde la última foto completa.
//
// Mientras un refresco está en curso se sigue sirviendo la foto anterior. Si el
// refresco falla, la foto vieja se mantiene y se marca su antigüedad: es mejor
// mostrar precios de hace diez minutos, diciéndolo, que no mostrar nada.

const REFRESH_MS = Number(process.env.CATALOG_REFRESH_MS || 5 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.CATALOG_TIMEOUT_MS || 25000);

const state = {
  events: [],
  analyses: [],
  sources: [],
  generatedAt: null,
  durationMs: null,
  refreshing: false,
  lastError: null,
  refreshCount: 0,
};

let timer = null;

async function refresh({ full = true } = {}) {
  if (state.refreshing) return state;
  state.refreshing = true;
  const startedAt = Date.now();

  try {
    const { events, sources } = await providers.fetchAll({ full, timeoutMs: TIMEOUT_MS });

    // Si todas las fuentes fallan no se pisa la foto buena con una vacía.
    if (events.length === 0 && state.events.length > 0) {
      state.lastError = 'Ninguna fuente respondió; se conserva el catálogo anterior.';
      state.sources = sources;
      return state;
    }

    // El análisis se calcula una vez por refresco, no una vez por petición:
    // agrupar miles de eventos cuesta segundos.
    const analyses = analyzeEvents(events, { limit: Number.MAX_SAFE_INTEGER });

    state.events = events;
    state.analyses = analyses;
    state.sources = sources;
    state.generatedAt = new Date().toISOString();
    state.durationMs = Date.now() - startedAt;
    state.lastError = null;
    state.refreshCount++;

    console.log(
      `[catálogo] ${events.length} eventos de ${sources.filter((s) => s.ok).length}/${sources.length} ` +
      `fuentes, ${analyses.length} analizados, ${analyses.filter((a) => a.crossPlatform).length} contrastados ` +
      `(${(state.durationMs / 1000).toFixed(1)} s)`
    );
  } catch (err) {
    state.lastError = err.message;
    console.error('[catálogo] refresco fallido:', err.message);
  } finally {
    state.refreshing = false;
  }

  return state;
}

function start({ immediate = true } = {}) {
  if (timer) return;
  if (immediate) refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function ageSeconds() {
  if (!state.generatedAt) return null;
  return Math.round((Date.now() - new Date(state.generatedAt)) / 1000);
}

function snapshot() {
  return {
    events: state.events,
    analyses: state.analyses,
    sources: state.sources,
    generatedAt: state.generatedAt,
    durationMs: state.durationMs,
    ageSeconds: ageSeconds(),
    refreshing: state.refreshing,
    refreshCount: state.refreshCount,
    lastError: state.lastError,
    ready: state.analyses.length > 0,
  };
}

module.exports = { refresh, start, stop, snapshot, REFRESH_MS };
