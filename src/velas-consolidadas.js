'use strict';

// Velas consolidadas: la mediana de los mercados elegidos, vela a vela.
//
// Por qué existe. Hasta ahora el análisis de ruptura corría ENTERO sobre
// Binance —niveles, ATR y muestra de excursiones— mientras el titular enseñaba
// la mediana de varios mercados. Eso es mirar un precio y analizar otro: la
// distancia a un nivel, que es de lo que depende una señal de compra, se medía
// en una escala distinta de la que se está viendo.
//
// Cómo. Cada mercado da sus velas, se pasan todas a dólares, y para cada
// instante se toma la mediana de aperturas, máximos, mínimos y cierres. La
// mediana y no la media por lo mismo que en el precio al contado: un mercado
// con un dato disparatado no debe arrastrar al conjunto.
//
// Qué NO hace: inventarse velas. Un instante en el que no responden al menos
// dos mercados no produce vela consolidada, y si no quedan suficientes se dice
// y se vuelve a Binance en vez de servir una serie coja.

const { fetchVelas, soporta } = require('./velas-mercados');
const { byId, baseAsset, fetchStableRate, redondearPrecio, defaultVenues } = require('./venues');
const { TtlCache } = require('./cache');

// Mínimo de mercados por vela. Con uno solo no hay mediana, sólo ese mercado
// disfrazado de consenso.
const MIN_MERCADOS = 2;

// El cambio USDT/USD cambia poquísimo —es una stablecoin— y hasta ahora se
// pedía en cada consulta, sin caché ni reintentos. Con las velas se pediría
// aún más. Un minuto de caché quita casi todas esas llamadas, y servir el
// último bueno ante un fallo evita que Binance quede fuera del consolidado por
// un tropiezo puntual de una API que ni siquiera es la suya.
const cacheCambio = new TtlCache({ ttlMs: 60_000, maxEntries: 2 });

function cambioUsdt({ timeoutMs = 6000 } = {}) {
  return cacheCambio.wrap('usdt', () => fetchStableRate({ timeoutMs }), 60_000, { serveStaleOnError: true });
}

function mediana(valores) {
  const xs = valores.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * Combina varias series en una. Cada serie es { venueId, candles }.
 * Devuelve las velas consolidadas y con cuántos mercados se hizo cada una.
 */
function combinar(series, { minMercados = MIN_MERCADOS } = {}) {
  const porInstante = new Map();

  for (const { venueId, candles } of series) {
    for (const c of candles) {
      if (!porInstante.has(c.openTime)) porInstante.set(c.openTime, []);
      porInstante.get(c.openTime).push({ venueId, ...c });
    }
  }

  const candles = [];
  for (const [openTime, trozos] of [...porInstante.entries()].sort((a, b) => a[0] - b[0])) {
    if (trozos.length < minMercados) continue;

    const open = mediana(trozos.map((t) => t.open));
    const close = mediana(trozos.map((t) => t.close));
    let high = mediana(trozos.map((t) => t.high));
    let low = mediana(trozos.map((t) => t.low));

    // La mediana de máximos y la de mínimos se calculan por separado, así que
    // en teoría podrían cruzarse. Se fuerza la coherencia en vez de dejar
    // pasar una vela imposible que rompería el ATR.
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    if (!(high >= low)) continue;

    candles.push({
      openTime,
      open: redondearPrecio(open),
      high: redondearPrecio(high),
      low: redondearPrecio(low),
      close: redondearPrecio(close),
      // El volumen se suma: no es comparable con el de un solo mercado, pero
      // el análisis sólo lo compara con la media de esta misma serie, y ahí sí
      // es coherente.
      volume: trozos.reduce((a, t) => a + (t.volume || 0), 0),
      closeTime: trozos[0].closeTime,
      closed: trozos.every((t) => t.closed),
      mercados: trozos.length,
    });
  }

  return candles;
}

/**
 * Velas consolidadas de los mercados pedidos.
 *
 * Nunca lanza por un mercado caído: informa de cuáles entraron, cuáles no y
 * por qué, para que la interfaz pueda decirlo en vez de aparentar consenso.
 */
async function getVelasConsolidadas({ symbol, interval, limit = 400, venues = null, timeoutMs = 8000, now = Date.now() } = {}) {
  const elegidos = (venues && venues.length ? venues : defaultVenues().map((v) => v.meta.id))
    // CF Benchmarks es un índice y no publica velas: no tiene sitio aquí.
    .filter((id) => id !== 'cfbenchmarks');

  const hayUsdt = elegidos.some((id) => byId.get(id) && byId.get(id).meta.quote === 'USDT');
  const [resultados, stable] = await Promise.all([
    Promise.all(
      elegidos.map((id) => {
        const venue = byId.get(id);
        if (!venue) return { venueId: id, ok: false, error: 'mercado desconocido', candles: [] };
        return fetchVelas({ venueId: id, pair: venue.pairFor(symbol), interval, limit, timeoutMs, now });
      })
    ),
    hayUsdt ? cambioUsdt({ timeoutMs }).catch(() => null) : Promise.resolve(null),
  ]);

  const detalle = [];
  const series = [];

  for (const r of resultados) {
    const venue = byId.get(r.venueId);
    const enUsdt = venue && venue.meta.quote === 'USDT';

    if (!r.ok) {
      detalle.push({ id: r.venueId, label: venue ? venue.meta.label : r.venueId, usado: false, motivo: r.error, velas: 0 });
      continue;
    }
    // Mezclar USDT con dólares en una mediana es el mismo fallo que en el
    // precio al contado, y aquí contaminaría 400 velas en vez de un número.
    if (enUsdt && !stable) {
      detalle.push({ id: r.venueId, label: venue.meta.label, usado: false, motivo: 'sin cambio USDT/USD', velas: 0 });
      continue;
    }

    const rate = enUsdt ? stable.rate : 1;
    const candles = rate === 1 ? r.candles : r.candles.map((c) => ({
      ...c,
      open: c.open * rate, high: c.high * rate, low: c.low * rate, close: c.close * rate,
    }));

    series.push({ venueId: r.venueId, candles });
    detalle.push({
      id: r.venueId,
      label: venue.meta.label,
      usado: true,
      motivo: null,
      velas: candles.length,
      convertido: enUsdt,
    });
  }

  const candles = series.length >= MIN_MERCADOS ? combinar(series) : [];

  return {
    ok: candles.length > 0,
    candles: candles.slice(-limit),
    venues: detalle,
    usados: series.length,
    stable: stable || null,
    // Por qué no hay consolidado, si no lo hay. La interfaz lo necesita para
    // explicar por qué se está viendo Binance a secas.
    motivo: candles.length
      ? null
      : series.length < MIN_MERCADOS
        ? `hacen falta al menos ${MIN_MERCADOS} mercados con velas de ${interval} y respondieron ${series.length}`
        : 'ningún instante coincide en suficientes mercados',
  };
}

module.exports = { getVelasConsolidadas, combinar, mediana, cambioUsdt, soporta, MIN_MERCADOS, _cacheCambio: cacheCambio };
