'use strict';

const { logit, sigmoid, devig, normalizeText, isCatchAll } = require('./normalize');
const { clusterEvents, canonicalizeOptions } = require('./match');

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_SPREAD = 0.08; // si la plataforma no publica libro, se asume ancho

// Cuánto pesa la cotización de una plataforma en el consenso. Tres factores:
// credibilidad de la plataforma (dinero real vs. de juego), profundidad del
// mercado (liquidez y volumen) y estrechez del spread.
function quoteWeight(quote) {
  const { option, credibility = 0.5 } = quote;
  const depth = 0.5 + Math.log1p((option.liquidity || 0) + (option.volume || 0) * 0.25);
  const spread = option.spread === null || option.spread === undefined ? UNKNOWN_SPREAD : option.spread;
  const spreadPenalty = 1 / (1 + 10 * Math.max(0, spread));
  return Math.max(0.02, credibility * depth * spreadPenalty);
}

// Media ponderada en espacio logit, no aritmética. Promediar 5% y 15% da 10%
// en ambos casos, pero en los extremos (1% vs 10%) la media aritmética
// exagera: el logit trata la probabilidad como lo que es, una razón de momios.
function combineQuotes(quotes) {
  const terms = quotes
    .map((q) => ({ quote: q, weight: quoteWeight(q), l: logit(q.option.impliedProb) }))
    .filter((t) => t.l !== null);

  if (terms.length === 0) {
    return { probability: null, weight: 0, agreement: null, dispersion: null };
  }

  const totalWeight = terms.reduce((acc, t) => acc + t.weight, 0);
  const mean = terms.reduce((acc, t) => acc + t.weight * t.l, 0) / totalWeight;
  const variance = terms.reduce((acc, t) => acc + t.weight * (t.l - mean) ** 2, 0) / totalWeight;
  const dispersion = Math.sqrt(variance);

  return {
    probability: sigmoid(mean),
    weight: totalWeight,
    dispersion,
    // Una desviación de ~1.5 en logit es un desacuerdo serio entre plataformas.
    agreement: terms.length > 1 ? Math.exp(-dispersion / 1.5) : null,
  };
}

function summarizeQuotes(quotes) {
  return quotes.map(({ platform, platformLabel, option, event }) => ({
    platform,
    platformLabel,
    price: option.price,
    impliedProb: option.impliedProb,
    bid: option.bid,
    ask: option.ask,
    spread: option.spread,
    priceSource: option.priceSource,
    liquidity: option.liquidity,
    volume: option.volume,
    url: option.url || event.url,
  }));
}

// Dónde comprar esa opción más barato ahora mismo, y cuánto margen deja frente
// al consenso (edge > 0 = el mercado la ofrece por debajo de lo que el
// conjunto de plataformas cree que vale).
function bestExecution(quotes, consensusProb) {
  let best = null;
  for (const q of quotes) {
    const ask = q.option.ask;
    if (ask === null || ask === undefined || ask <= 0 || ask >= 1) continue;
    if (!best || ask < best.ask) {
      best = { platform: q.platform, platformLabel: q.platformLabel, ask, url: q.option.url || q.event.url };
    }
  }
  if (!best) return null;
  return {
    ...best,
    edge: consensusProb === null ? null : consensusProb - best.ask,
  };
}

function analyzeCluster(cluster) {
  const { options: groups, descartadas } = canonicalizeOptions(cluster);
  const anchor = cluster.anchor;

  let options = groups
    .map((group) => {
      const combined = combineQuotes(group.quotes);
      if (combined.probability === null) return null;

      const probs = group.quotes
        .map((q) => q.option.impliedProb)
        .filter((p) => Number.isFinite(p));

      return {
        label: group.label,
        key: group.key,
        probability: combined.probability,
        weight: combined.weight,
        agreement: combined.agreement,
        dispersion: combined.dispersion,
        range: probs.length ? { min: Math.min(...probs), max: Math.max(...probs) } : null,
        divergence: probs.length > 1 ? Math.max(...probs) - Math.min(...probs) : null,
        platformCount: group.quotes.length,
        platforms: summarizeQuotes(group.quotes),
        bestPrice: bestExecution(group.quotes, combined.probability),
      };
    })
    .filter(Boolean);

  // Si sólo puede ganar una opción, las probabilidades del consenso también
  // deben sumar 1: sin este paso el ranking sigue siendo correcto pero los
  // porcentajes mostrados no son comparables entre eventos.
  const mutuallyExclusive = cluster.events.some((e) => e.mutuallyExclusive);
  let consensusOverround = null;
  if (mutuallyExclusive && options.length > 1) {
    const { probabilities, overround } = devig(options.map((o) => o.probability));
    probabilities.forEach((p, i) => {
      if (p !== null) options[i].probability = p;
    });
    consensusOverround = overround;
  }

  options.sort((a, b) => b.probability - a.probability);

  // "Other" y compañía agrupan a todos los demás: son informativos, pero no son
  // una respuesta a "cuál es más probable". Se muestran en la lista y cuentan
  // para el reparto de probabilidad, pero nunca encabezan el veredicto.
  options.forEach((o) => {
    o.catchAll = isCatchAll(o.label);
  });
  const rankeables = options.filter((o) => !o.catchAll);

  const top = rankeables[0] || null;
  const runnerUp = rankeables[1] || null;
  const margin = top && runnerUp ? top.probability - runnerUp.probability : null;
  const catchAll = options.find((o) => o.catchAll) || null;

  const totalWeight = options.reduce((acc, o) => acc + o.weight, 0);
  const platformsInvolved = cluster.events.length;
  const agreementValues = options.map((o) => o.agreement).filter((a) => a !== null);
  const meanAgreement = agreementValues.length
    ? agreementValues.reduce((a, b) => a + b, 0) / agreementValues.length
    : null;

  const confidence = scoreConfidence({ totalWeight, platformsInvolved, meanAgreement });
  const closesAt = cluster.events.map((e) => e.closesAt).filter(Boolean).sort()[0] || null;
  const daysToClose = closesAt ? (new Date(closesAt) - Date.now()) / DAY_MS : null;

  const analysis = {
    id: anchor.id,
    title: anchor.title,
    url: anchor.url,
    closesAt,
    daysToClose,
    matchScore: cluster.matchScore,
    category: anchor.category || 'otros',
    mutuallyExclusive,
    crossPlatform: platformsInvolved > 1,
    consensusOverround,
    totalLiquidity: cluster.events.reduce((acc, e) => acc + (e.liquidity || 0), 0),
    totalVolume: cluster.events.reduce((acc, e) => acc + (e.volume || 0), 0),
    sources: cluster.events.map((e) => ({
      platform: e.platform,
      platformLabel: e.platformLabel,
      title: e.title,
      url: e.url,
      overround: e.overround,
      optionCount: e.options.length,
    })),
    options,
    mostLikely: top
      ? {
          label: top.label,
          probability: top.probability,
          margin,
          runnerUp: runnerUp ? { label: runnerUp.label, probability: runnerUp.probability } : null,
          bestPrice: top.bestPrice,
        }
      : null,
    catchAll: catchAll ? { label: catchAll.label, probability: catchAll.probability } : null,
    confidence,
    arbitrage: findArbitrage(options, mutuallyExclusive),
  };

  analysis.flags = buildFlags(analysis);
  analysis.verdict = buildVerdict(analysis);
  return analysis;
}

function scoreConfidence({ totalWeight, platformsInvolved, meanAgreement }) {
  const depthScore = 1 - Math.exp(-totalWeight / 25);
  const platformScore = platformsInvolved >= 3 ? 1 : platformsInvolved === 2 ? 0.75 : 0.45;
  const agreementScore = meanAgreement === null ? 0.5 : meanAgreement;
  const score = 0.4 * depthScore + 0.35 * agreementScore + 0.25 * platformScore;
  return Math.min(1, Math.max(0, score));
}

// Si se puede comprar "Sí" en todas las opciones de un evento excluyente por
// menos de 1$ en total, una de ellas paga 1$ pase lo que pase.
function findArbitrage(options, mutuallyExclusive) {
  if (!mutuallyExclusive || options.length < 2) return null;
  if (!options.every((o) => o.bestPrice && Number.isFinite(o.bestPrice.ask))) return null;

  const cost = options.reduce((acc, o) => acc + o.bestPrice.ask, 0);
  if (cost >= 0.995) return null; // por debajo de eso, las comisiones se lo comen

  return {
    cost,
    profit: 1 - cost,
    returnPct: (1 - cost) / cost,
    legs: options.map((o) => ({
      label: o.label,
      platform: o.bestPrice.platformLabel,
      ask: o.bestPrice.ask,
    })),
  };
}

function buildFlags(analysis) {
  const flags = [];

  if (!analysis.crossPlatform) {
    flags.push({
      level: 'warn',
      code: 'single_source',
      message: 'Sólo una plataforma cotiza este evento: no hay contraste de precios.',
    });
  }

  const top = analysis.options.find((o) => !o.catchAll);
  if (top && top.divergence !== null && top.divergence > 0.08) {
    flags.push({
      level: 'warn',
      code: 'divergence',
      message: `Las plataformas discrepan ${(top.divergence * 100).toFixed(0)} pts en "${top.label}".`,
    });
  }

  if (analysis.mostLikely && analysis.mostLikely.margin !== null && analysis.mostLikely.margin < 0.05) {
    flags.push({
      level: 'warn',
      code: 'too_close',
      message: 'Las dos primeras opciones están casi empatadas: el favorito no es fiable.',
    });
  }

  if (analysis.arbitrage) {
    flags.push({
      level: 'good',
      code: 'arbitrage',
      message: `Comprar todas las opciones cuesta ${(analysis.arbitrage.cost * 100).toFixed(1)}¢ y paga 100¢.`,
    });
  }

  if (top && top.bestPrice && top.bestPrice.edge !== null && top.bestPrice.edge > 0.03) {
    flags.push({
      level: 'good',
      code: 'value',
      message: `"${top.label}" se compra en ${top.bestPrice.platformLabel} ${(top.bestPrice.edge * 100).toFixed(1)} pts por debajo del consenso.`,
    });
  }

  if (analysis.daysToClose !== null && analysis.daysToClose < 1) {
    flags.push({
      level: 'info',
      code: 'closing_soon',
      message: 'El evento cierra en menos de 24 horas.',
    });
  }

  // Si el cajón de sastre pesa más que el favorito, el mercado está diciendo
  // que lo más probable es alguien que no está en la lista.
  if (analysis.catchAll && top && analysis.catchAll.probability > top.probability) {
    flags.push({
      level: 'warn',
      code: 'wide_field',
      message:
        `"${analysis.catchAll.label}" (${(analysis.catchAll.probability * 100).toFixed(0)}%) supera al favorito: ` +
        'el mercado apunta a alguien fuera de las opciones listadas.',
    });
  }

  return flags;
}

function confidenceLabel(score) {
  if (score >= 0.75) return 'alta';
  if (score >= 0.5) return 'media';
  return 'baja';
}

function buildVerdict(analysis) {
  if (!analysis.mostLikely) {
    return { text: 'Sin datos suficientes para elegir una opción.', confidenceLabel: 'baja' };
  }

  const { label, probability, margin, runnerUp } = analysis.mostLikely;
  const pct = (probability * 100).toFixed(1);
  const platforms = analysis.sources.map((s) => s.platformLabel).join(', ');
  const decisive = margin === null ? false : margin >= 0.05;

  // Confianza y margen responden a preguntas distintas: cuánto me fío del
  // análisis, y si hay ganador. Decir "17,4%, 1,2 pts por delante, confianza
  // alta" se lee como si hubiera respuesta cuando lo que hay es un empate.
  let text;
  if (!decisive && runnerUp) {
    text =
      `Empate técnico entre "${label}" (${pct}%) y "${runnerUp.label}" ` +
      `(${(runnerUp.probability * 100).toFixed(1)}%): ${(margin * 100).toFixed(1)} pts los separan ` +
      `según ${platforms}, demasiado poco para dar un favorito.`;
  } else {
    text = `"${label}" es la opción más probable con ${pct}% según ${platforms}`;
    if (runnerUp && margin !== null) {
      text += `, ${(margin * 100).toFixed(1)} pts por encima de "${runnerUp.label}"`;
    }
    text += '.';
  }

  text += ` Confianza ${confidenceLabel(analysis.confidence)} en los datos.`;

  return {
    text,
    confidenceLabel: confidenceLabel(analysis.confidence),
    decisive,
  };
}

function matchesQuery(event, query) {
  if (!query) return true;
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeText(
    [event.title, ...event.options.map((o) => o.label)].join(' ')
  );
  return tokens.every((token) => haystack.includes(token));
}

// Pipeline completo: filtrar -> agrupar equivalentes -> consenso y ranking.
function analyzeEvents(events, { query = '', limit = 25, minLiquidity = 0, threshold = 0.5 } = {}) {
  const filtered = events
    .filter((e) => matchesQuery(e, query))
    .filter((e) => (e.liquidity || 0) + (e.volume || 0) >= minLiquidity);

  const clusters = clusterEvents(filtered, { threshold });
  const analyses = clusters.map(analyzeCluster).filter((a) => a.mostLikely !== null);

  // Prioriza lo que se puede contrastar entre plataformas y lo más líquido:
  // un evento con tres fuentes de acuerdo vale más que uno enorme y solitario.
  analyses.sort((a, b) => {
    const score = (x) =>
      (x.crossPlatform ? 1.5 : 1) * Math.log1p(x.totalLiquidity + x.totalVolume * 0.25);
    return score(b) - score(a);
  });

  return analyses.slice(0, limit);
}

module.exports = {
  quoteWeight,
  combineQuotes,
  analyzeCluster,
  analyzeEvents,
  findArbitrage,
  scoreConfidence,
  matchesQuery,
};
