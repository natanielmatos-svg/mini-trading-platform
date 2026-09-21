'use strict';

const {
  textSimilarity,
  tokenize,
  diceSimilarity,
  canonicalLabelKey,
  extractYears,
  extractNumbers,
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
// Comparación suelta de dos eventos. Sin catálogo detrás no hay frecuencias,
// así que se construye un corpus mínimo con los dos: basta para que una palabra
// presente en ambos pese menos que una exclusiva de uno.
function eventSimilarity(a, b) {
  const pa = prepareEvent(a);
  const pb = prepareEvent(b);
  return similarityOf(pa, pb, buildIdf([pa, pb]));
}

// Tokenizar un título cuesta poco, pero hacerlo dentro de un bucle cuadrático
// sobre miles de eventos se convierte en el gasto dominante. Se prepara una vez
// por evento y se reutiliza en todas sus comparaciones.
function prepareEvent(event) {
  return {
    event,
    tokens: tokenize(event.title),
    optTokens: optionLabelTokens(event),
    years: extractYears(event.title),
    numbers: extractNumbers(event.title),
    binary: isGenericBinary(event),
    weight: eventWeight(event),
  };
}

function yearsConflictSets(ya, yb) {
  if (ya.size === 0 || yb.size === 0) return false;
  for (const year of ya) if (yb.has(year)) return false;
  return true;
}

// Dice cuenta todas las palabras igual, y ahí estaba el fallo: en "FL-11 House
// Election Winner" contra "NJ-11 House winner?" las únicas que deciden son "fl"
// y "nj", y pesaban lo mismo que el relleno compartido. Sobre datos reales eso
// emparejaba Florida con Nueva Jersey, Grecia con Turquía, Manchin con
// Zuckerberg y el canal de Panamá con Canadá.
//
// La frecuencia en el catálogo las distingue: "election" sale en cientos de
// contratos y no discrimina nada, "manchin" sale en uno y lo discrimina todo.
function buildIdf(preparados) {
  const df = new Map();
  for (const p of preparados) {
    for (const token of p.tokens) df.set(token, (df.get(token) || 0) + 1);
    for (const token of p.optTokens) df.set(token, (df.get(token) || 0) + 1);
  }

  const total = preparados.length || 1;
  const idf = new Map();
  for (const [token, count] of df) idf.set(token, Math.log(1 + total / count));
  return idf;
}

// Una palabra ausente del catálogo es, por definición, de las más raras.
const IDF_DESCONOCIDA = Math.log(1 + 1000);

function weightedDice(a, b, idf) {
  if (!idf) return diceSimilarity(a, b);
  if (a.size === 0 || b.size === 0) return 0;

  let compartido = 0;
  let totalA = 0;
  let totalB = 0;

  for (const token of a) {
    const w = idf.get(token) ?? IDF_DESCONOCIDA;
    totalA += w;
    if (b.has(token)) compartido += w;
  }
  for (const token of b) totalB += idf.get(token) ?? IDF_DESCONOCIDA;

  const denom = totalA + totalB;
  return denom === 0 ? 0 : (2 * compartido) / denom;
}

function setsDiffer(a, b) {
  if (a.size !== b.size) return true;
  for (const v of a) if (!b.has(v)) return true;
  return false;
}

function similarityOf(a, b, idf) {
  // El año no es un matiz de la puntuación: es el contrato.
  if (yearsConflictSets(a.years, b.years)) return 0;
  // Y el resto de cifras suele ser el umbral que separa un contrato de su
  // vecino en una escalera de strikes.
  if (setsDiffer(a.numbers, b.numbers)) return 0;

  const titleScore = weightedDice(a.tokens, b.tokens, idf);
  if (a.binary && b.binary) return titleScore;

  return 0.65 * titleScore + 0.35 * weightedDice(a.optTokens, b.optTokens, idf);
}

function closeDatesCompatible(a, b, maxGapDays) {
  if (!a.closesAt || !b.closesAt) return true; // sin fecha no se descarta
  const gap = Math.abs(new Date(a.closesAt) - new Date(b.closesAt));
  return gap <= maxGapDays * DAY_MS;
}

// Cuántos grupos candidatos se puntúan por evento. Una palabra muy común
// ("2026") aparece en cientos de grupos; se puntúan sólo aquellos con los que
// más palabras se comparten, que es donde puede estar la coincidencia real.
const MAX_CANDIDATOS = 60;

// Agrupación voraz con índice invertido: los eventos se ordenan por relevancia
// y cada uno se une al mejor grupo compatible.
//
// Sin índice habría que comparar cada evento contra cada grupo ya formado, y
// catalogar las tres plataformas enteras son varios miles de eventos: decenas
// de millones de comparaciones. El índice reduce cada evento a la docena de
// grupos que comparten alguna palabra con él.
//
// El margen entre fechas de cierre es amplio a propósito. El error grave
// —emparejar comicios de años distintos— ya lo ataja el descarte por año, que
// es más fiable: la fecha de cierre de Manifold la fija quien crea el mercado
// y va suelta. Con 30 días se perdían emparejamientos legítimos.
// Un multi-opción lleva corroboración incorporada: si dos plataformas listan
// los mismos veinte candidatos, es que hablan del mismo evento. Un binario Sí/No
// no tiene nada que corrobore el título, así que se le exige más.
//
// Sobre parejas reales etiquetadas a mano, los falsos positivos que más
// puntuaban eran todos binarios —Manchin con Zuckerberg, Ucrania-OTAN con el
// fin de la guerra, Grecia con Turquía, Panamá con Canadá— y ninguno llegaba a
// 0,75. Los multi-opción falsos se quedaban por debajo de 0,66.
const UMBRAL_BINARIO = 0.75;
const UMBRAL_MULTIOPCION = 0.62;

function umbralDe(a, b, base) {
  const estricto = a.binary && b.binary;
  const suelo = estricto ? UMBRAL_BINARIO : UMBRAL_MULTIOPCION;
  // Si quien llama pide un umbral más alto, manda el suyo.
  return Math.max(suelo, base);
}

function clusterEvents(events, { threshold = 0, maxCloseGapDays = 365 } = {}) {
  const preparados = events.map(prepareEvent).sort((a, b) => b.weight - a.weight);
  const idf = buildIdf(preparados);

  const clusters = [];
  const porToken = new Map(); // palabra -> índices de los grupos que la contienen

  const indexar = (tokens, idx) => {
    for (const token of tokens) {
      let set = porToken.get(token);
      if (!set) porToken.set(token, (set = new Set()));
      set.add(idx);
    }
  };

  for (const p of preparados) {
    const compartidos = new Map();
    for (const token of p.tokens) {
      const set = porToken.get(token);
      if (!set) continue;
      for (const idx of set) compartidos.set(idx, (compartidos.get(idx) || 0) + 1);
    }

    const candidatos = [...compartidos.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, MAX_CANDIDATOS);

    let best = null;
    let bestScore = 0;

    for (const [idx] of candidatos) {
      const cluster = clusters[idx];
      // Una plataforma aporta como mucho un evento por grupo; como vamos de más
      // a menos líquido, el primero en entrar es el mejor de esa plataforma.
      if (cluster.platforms.has(p.event.platform)) continue;

      // El grupo entero debe parecerse, no sólo su ancla: basta un miembro por
      // debajo del umbral para descartarlo.
      let score = Infinity;
      let exigido = 0;
      for (const miembro of cluster.miembros) {
        const s = closeDatesCompatible(miembro.event, p.event, maxCloseGapDays)
          ? similarityOf(miembro, p, idf)
          : 0;
        if (s < score) score = s;
        exigido = Math.max(exigido, umbralDe(miembro, p, threshold));
        if (score < exigido) break;
      }

      if (score >= exigido && score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (best) {
      best.miembros.push(p);
      best.platforms.add(p.event.platform);
      best.matchScores.push(bestScore);
      indexar(p.tokens, best.idx);
    } else {
      const idx = clusters.length;
      clusters.push({
        idx,
        miembros: [p],
        platforms: new Set([p.event.platform]),
        matchScores: [],
      });
      indexar(p.tokens, idx);
    }
  }

  return clusters.map((cluster) => ({
    events: cluster.miembros.map((m) => m.event),
    anchor: cluster.miembros[0].event,
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
