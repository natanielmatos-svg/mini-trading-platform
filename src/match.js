'use strict';

const {
  textSimilarity,
  tokenize,
  diceSimilarity,
  canonicalLabelKey,
  yearsConflict,
} = require('./normalize');

const DAY_MS = 24 * 60 * 60 * 1000;

// Peso aproximado de un evento como "ancla" de su grupo: la fuente más líquida
// y creíble es la que fija el título y el conjunto de opciones canónicas.
function eventWeight(event) {
  const depth = Math.log1p((event.liquidity || 0) + (event.volume || 0) * 0.25);
  return (event.credibility || 0.5) * (0.5 + depth);
}

// Se tokeniza la clave canónica, no la etiqueta cruda: así "Yes" de una
// plataforma y "Sí" de otra cuentan como la misma opción al comparar eventos.
function optionLabelTokens(event) {
  const tokens = new Set();
  for (const option of event.options) {
    for (const token of tokenize(option.key || canonicalLabelKey(option.label))) {
      tokens.add(token);
    }
  }
  return tokens;
}

// Un mercado Sí/No no dice nada por sus opciones: todos tienen las mismas.
function isGenericBinary(event) {
  return (
    event.options.length <= 2 &&
    event.options.every((o) => o.key === 'yes' || o.key === 'no')
  );
}

// Dos plataformas casi nunca escriben la pregunta igual ("Will X win the 2028
// election?" vs "2028 Presidential Election Winner"), así que el título por sí
// solo no basta: el conjunto de opciones aporta la otra mitad de la señal.
//
// Salvo entre binarios. Ahí las opciones son {Sí, No} en ambos lados y ese
// término puntúa 1,0 pase lo que pase, regalando 0,35 a cualquier pareja: con
// eso, "Hantavirus pandemic in 2026?" y "US recession in 2026?" superaban el
// umbral. Entre binarios decide el título y nada más.
function eventSimilarity(a, b) {
  // El año no es un matiz de la puntuación: es el contrato. Dos mercados que
  // citan años distintos no son el mismo evento por mucho que compartan el
  // molde de la pregunta ("Which party will win the House in 2026?" contra
  // "Which party will win the 2032 Presidential Election?" llegaba a 0,705,
  // porque el año queda sepultado entre las palabras comunes y los nombres de
  // partido idénticos rematan la nota).
  if (yearsConflict(a.title, b.title)) return 0;

  const titleScore = textSimilarity(a.title, b.title);
  if (isGenericBinary(a) && isGenericBinary(b)) return titleScore;

  const optionScore = diceSimilarity(optionLabelTokens(a), optionLabelTokens(b));
  return 0.65 * titleScore + 0.35 * optionScore;
}

function closeDatesCompatible(a, b, maxGapDays) {
  if (!a.closesAt || !b.closesAt) return true; // sin fecha no se descarta
  const gap = Math.abs(new Date(a.closesAt) - new Date(b.closesAt));
  return gap <= maxGapDays * DAY_MS;
}

// Agrupación voraz: los eventos se ordenan por relevancia y cada uno se une al
// primer grupo compatible. Es O(n·grupos) y suficiente para unos cientos de
// eventos; un clustering jerárquico no cambiaría el resultado en la práctica.
// El margen entre fechas de cierre es amplio a propósito. El error grave —
// emparejar comicios de años distintos— ya lo ataja yearsConflict, que es una
// señal más fiable: la fecha de cierre de Manifold la fija quien crea el
// mercado y suele ir suelta. Con 30 días de margen se perdían emparejamientos
// legítimos, como las primarias demócratas de 2028 entre dos plataformas.
function clusterEvents(events, { threshold = 0.5, maxCloseGapDays = 365 } = {}) {
  const sorted = [...events].sort((a, b) => eventWeight(b) - eventWeight(a));
  const clusters = [];

  for (const event of sorted) {
    let best = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      // Una plataforma aporta como mucho un evento por grupo; como vamos de más
      // a menos líquido, el primero en entrar es el mejor de esa plataforma.
      if (cluster.events.some((e) => e.platform === event.platform)) continue;

      const score = Math.min(
        ...cluster.events.map((e) =>
          closeDatesCompatible(e, event, maxCloseGapDays) ? eventSimilarity(e, event) : 0
        )
      );

      if (score >= threshold && score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (best) {
      best.events.push(event);
      best.matchScores.push(bestScore);
    } else {
      clusters.push({ events: [event], matchScores: [] });
    }
  }

  return clusters.map((cluster) => ({
    events: cluster.events,
    anchor: cluster.events[0],
    matchScore: cluster.matchScores.length
      ? cluster.matchScores.reduce((a, b) => a + b, 0) / cluster.matchScores.length
      : 1,
  }));
}

const OPTION_MATCH_THRESHOLD = 0.6;

// Une las opciones equivalentes de todas las plataformas del grupo.
//
// El ancla —la fuente más profunda y creíble— define el universo: su lista de
// opciones ya reparte el 100% entre ellas. Las demás plataformas sólo afinan el
// precio de opciones que ya existen; las suyas propias se descartan.
//
// Sin esa regla, unir 52 candidatos de una plataforma con 45 de otra daba 65
// opciones de las que 35 sólo cotizaba una, contando esa masa dos veces: la
// suma llegaba a 1,30 y al renormalizar hundía todos los porcentajes un 30%.
function canonicalizeOptions(cluster) {
  const anchor = cluster.anchor || cluster.events[0];
  const groups = [];
  let descartadas = 0;

  const findGroup = (option) => {
    let best = null;
    let bestScore = OPTION_MATCH_THRESHOLD;

    for (const group of groups) {
      if (group.key && option.key && group.key === option.key) return group;
      const score = textSimilarity(group.label, option.label);
      if (score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    return best;
  };

  const addQuote = (group, option, event) => {
    const already = group.quotes.find((q) => q.platform === event.platform);
    if (already) {
      // Misma plataforma cotizando dos veces la misma opción: nos quedamos con
      // la más líquida en lugar de contarla dos veces.
      if ((option.liquidity || 0) > (already.option.liquidity || 0)) {
        already.option = option;
        already.event = event;
      }
      return;
    }
    group.quotes.push({
      platform: event.platform,
      platformLabel: event.platformLabel,
      credibility: event.credibility,
      option,
      event,
    });
  };

  for (const option of anchor.options) {
    const key = option.key || canonicalLabelKey(option.label);
    const existing = findGroup(option);
    if (existing) {
      addQuote(existing, option, anchor);
      continue;
    }
    const group = {
      // Una opción binaria se muestra siempre igual, venga de la plataforma que
      // venga ("Yes", "Sí" y "True" son la misma respuesta).
      label: key === 'yes' ? 'Sí' : key === 'no' ? 'No' : option.label,
      key,
      quotes: [],
    };
    groups.push(group);
    addQuote(group, option, anchor);
  }

  for (const event of cluster.events) {
    if (event === anchor) continue;
    for (const option of event.options) {
      const group = findGroup(option);
      if (!group) {
        descartadas++;
        continue;
      }
      addQuote(group, option, event);
    }
  }

  return { options: groups, descartadas };
}

module.exports = {
  eventWeight,
  isGenericBinary,
  eventSimilarity,
  clusterEvents,
  canonicalizeOptions,
  OPTION_MATCH_THRESHOLD,
};
