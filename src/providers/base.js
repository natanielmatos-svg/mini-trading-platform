'use strict';

const {
  midPrice,
  devig,
  canonicalLabelKey,
  toNumber,
  isNestedThresholds,
  pricesLookExclusive,
} = require('../normalize');

// Forma canónica de un evento, sea cual sea la plataforma de origen:
//
//   { platform, platformLabel, credibility, id, title, url, closesAt,
//     mutuallyExclusive, volume, liquidity, overround, options: [...] }
//
// y cada opción:
//
//   { label, key, price, impliedProb, bid, ask, last, spread, priceSource,
//     volume, liquidity, url }
//
// `price` es el precio crudo del mercado (0..1) e `impliedProb` es ese precio
// después de quitar el vig cuando las opciones son mutuamente excluyentes.

function buildOption(raw) {
  const { price, spread, source } = midPrice(raw);
  return {
    label: raw.label || 'Sin nombre',
    key: canonicalLabelKey(raw.label || ''),
    price,
    impliedProb: price,
    bid: toNumber(raw.bid),
    ask: toNumber(raw.ask),
    last: toNumber(raw.last),
    spread,
    priceSource: source,
    volume: toNumber(raw.volume) || 0,
    liquidity: toNumber(raw.liquidity) || 0,
    url: raw.url || null,
  };
}

// Una plataforma puede listar dos veces el mismo desenlace: Kalshi repite el
// `yes_sub_title` cuando un evento tiene varios contratos con la misma
// condición. Si se dejan pasar, el devig reparte el 100% entre dos copias de lo
// mismo y cada una sale a la mitad de su precio real. Se conserva la más
// líquida, que es la que de verdad se puede negociar.
function dedupeOptions(options) {
  const porClave = new Map();

  for (const option of options) {
    const previa = porClave.get(option.key);
    if (!previa) {
      porClave.set(option.key, option);
      continue;
    }
    const mejor = (option.liquidity || 0) + (option.volume || 0) >
                  (previa.liquidity || 0) + (previa.volume || 0);
    if (mejor) porClave.set(option.key, option);
  }

  return [...porClave.values()];
}

function buildEvent(raw) {
  const options = dedupeOptions(
    (raw.options || []).map(buildOption).filter((opt) => opt.price !== null)
  );

  if (options.length === 0) return null;

  // La plataforma dice que sólo puede ganar una opción, pero a veces lo que
  // tiene son umbrales acumulados ("Above 0.1%", "Above 0.2%"…) que se
  // contienen unos a otros. Dos comprobaciones lo detectan: la forma de las
  // etiquetas y, sobre todo, que los precios sumen lo que tendrían que sumar.
  // Un creador de mercado se queda unos puntos, nunca un 50%.
  const etiquetas = options.map((o) => o.label);
  const precios = options.map((o) => o.price);
  const anidadas =
    Boolean(raw.mutuallyExclusive) &&
    options.length > 1 &&
    (isNestedThresholds(etiquetas) || !pricesLookExclusive(precios));

  const mutuallyExclusive = Boolean(raw.mutuallyExclusive) && !anidadas;

  let overround = null;
  if (mutuallyExclusive && options.length > 1) {
    const { probabilities, overround: over } = devig(precios);
    probabilities.forEach((p, i) => {
      if (p !== null) options[i].impliedProb = p;
    });
    overround = over;
  }

  const sum = (key) => options.reduce((acc, o) => acc + (o[key] || 0), 0);

  return {
    platform: raw.platform,
    platformLabel: raw.platformLabel,
    credibility: raw.credibility,
    id: `${raw.platform}:${raw.id}`,
    title: raw.title,
    url: raw.url || null,
    closesAt: raw.closesAt || null,
    mutuallyExclusive,
    // Se conserva la discrepancia: la plataforma decía excluyente y los precios
    // dicen que no. La interfaz lo avisa en vez de repartir probabilidad que no
    // se puede repartir.
    nestedThresholds: anidadas,
    category: raw.category || 'otros',
    volume: toNumber(raw.volume) ?? sum('volume'),
    liquidity: toNumber(raw.liquidity) ?? sum('liquidity'),
    overround,
    options,
  };
}

// Las APIs devuelven fechas en formatos distintos (ISO, epoch en segundos o
// milisegundos). Todo sale como ISO o null.
function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Polymarket devuelve varios campos como JSON serializado dentro de un string.
function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Las APIs devuelven dos estilos de paginación: por desplazamiento (offset) y
// por cursor. Esta función recorre ambos hasta agotar el catálogo o llegar al
// tope, con una pausa entre páginas para no chocar con los rate limits.
//
// Una página que falla NO tira las que ya se trajeron. Las tres APIs cortan la
// paginación con un 4xx al pasarse de su tope de offset —Polymarket con un 422,
// Manifold con un 400— y ese error no significa que los miles de eventos ya
// descargados no sirvan. Se para ahí, se devuelve lo que hay y se anota por qué.
async function paginate(fetchPage, { maxPages = 60, pageSize = 100, pauseMs = 120 } = {}) {
  const items = [];
  let cursor = null;
  let stopped = null;

  for (let page = 0; page < maxPages; page++) {
    let result;
    try {
      result = await fetchPage({ offset: page * pageSize, cursor, limit: pageSize });
    } catch (err) {
      stopped = `paginación detenida en la página ${page + 1}: ${err.message}`;
      break;
    }

    const { batch, nextCursor } = result;
    if (!batch || batch.length === 0) break;
    items.push(...batch);

    // Con cursor, el final llega cuando deja de haber uno nuevo. Con offset,
    // cuando la página viene incompleta.
    if (nextCursor !== undefined) {
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    } else if (batch.length < pageSize) {
      break;
    }

    if (page === maxPages - 1) {
      stopped = `tope de ${maxPages} páginas alcanzado; puede haber más contratos`;
    }

    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }

  // La nota viaja con el array para que el estado de cada fuente pueda decir
  // que trajo datos pero no el catálogo entero.
  if (stopped) items.note = stopped;
  return items;
}

// Taxonomía propia, común a las tres plataformas. Cada una clasifica a su
// manera —Kalshi tiene un campo category, Polymarket usa tags, Manifold grupos
// creados por usuarios— así que se normaliza sobre el texto disponible.
const CATEGORIES = [
  ['deportes', /\b(nfl|nba|mlb|nhl|soccer|football|f[uú]tbol|basketball|baseball|hockey|tennis|tenis|golf|ufc|mma|boxing|boxeo|olympic|ol[ií]mpic|world cup|mundial|champions|premier league|la ?liga|super ?bowl|playoffs?|sports?|deportes?|match|partido|season|temporada|race|f1|formula ?1|cricket|rugby)\b/i],
  ['política', /\b(elections?|elecci[oó]n|electorales?|electoral|president|presidente|senate|senado|congress|congreso|house|parliament|parlamento|governor|gobernador|primary|primaria|nominee|nominaci[oó]n|minister|ministro|chancellor|党|politic|pol[ií]tic|vote|voto|ballot|impeach|cabinet|gabinete|referendum|coup|golpe de estado)\b/i],
  ['economía', /\b(fed|fomc|interest rate|tipos de inter[eé]s|inflation|inflaci[oó]n|cpi|gdp|pib|recession|recesi[oó]n|unemployment|desempleo|jobs report|earnings|ipo|s&p|nasdaq|dow|stock|bolsa|tariffs?|aranceles?|trade deal|bank|banco central|treasury|yield|oil|petr[oó]leo|gold|oro)\b/i],
  ['cripto', /\b(bitcoin|btc|ethereum|eth|solana|crypto|cripto|stablecoin|defi|nft|blockchain|token|altcoin|binance|coinbase)\b/i],
  ['tecnología', /\b(ai\b|artificial intelligence|inteligencia artificial|openai|anthropic|claude|gpt|llm|chatgpt|gemini|tesla|spacex|apple|google|microsoft|nvidia|semiconductor|chip|starship|rocket|launch|satellite)\b/i],
  ['ciencia', /\b(nobel|vaccine|vacuna|pandemic|pandemia|virus|disease|enfermedad|fda|clinical trial|cancer|c[aá]ncer|fusion|quantum|cu[aá]ntic|mars|marte|moon|luna|asteroid|theorem|conjecture|prize problem|millennium prize)\b/i],
  ['clima', /\b(temperature|temperatura|weather|clima|hurricane|hurac[aá]n|rain|lluvia|snow|nieve|storm|tormenta|wildfire|incendio|earthquake|terremoto|el ni[nñ]o|climate|co2|emissions)\b/i],
  ['entretenimiento', /\b(oscars?|grammys?|emmys?|golden globes?|box office|taquilla|movies?|film|pel[ií]culas?|best picture|albums?|billboard|spotify|netflix|celebrity|famoso|rotten tomatoes|eurovision|awards?|series|show)\b/i],
  ['geopolítica', /\b(war|guerra|invade|invasi[oó]n|ceasefire|alto el fuego|nato|otan|ukraine|ucrania|russia|rusia|china|taiwan|israel|gaza|iran|ir[aá]n|north korea|corea del norte|sanction|sanci[oó]n|treaty|tratado|nuclear|missile|misil)\b/i],
];

// Se evalúan en orden y gana la primera que encaje, así que las categorías más
// específicas van antes que las generales.
function classifyCategory(...texts) {
  const haystack = texts.filter(Boolean).join(' ');
  if (!haystack) return 'otros';
  for (const [name, pattern] of CATEGORIES) {
    if (pattern.test(haystack)) return name;
  }
  return 'otros';
}

const CATEGORY_NAMES = CATEGORIES.map(([name]) => name).concat('otros');

module.exports = {
  buildEvent,
  buildOption,
  toIso,
  parseMaybeJsonArray,
  paginate,
  classifyCategory,
  CATEGORY_NAMES,
};
