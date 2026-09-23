'use strict';

// La orquestación del motor de predicción: qué horizontes se piden, con qué
// serie se calcula cada uno, y la calibración que acompaña a todos.
//
// Estaba dentro de `server.js`, y se sacó cuando el bot de Kalshi necesitó lo
// mismo desde un script. Dos implementaciones de esto acabarían discrepando en
// silencio, y la que discrepara sería la que opera con dinero.

const forecast = require('./forecast');
const calibracion = require('./calibracion');
const { TtlCache } = require('./cache');

// Los cuantiles conformes recorren el histórico prediciendo hacia delante: es
// la parte cara, y sólo cambia cuando cambian las velas. La clave lleva la
// última apertura, así que una vela nueva invalida la entrada sola.
const cacheConforme = new TtlCache({ ttlMs: 300_000, maxEntries: 200 });

/**
 * Un horizonte: sus bandas, su rejilla y su nota.
 *
 * @param nivel  opcional; añade la probabilidad de acabar por encima de él.
 *               El navegador NO lo usa —recibe la rejilla y la resuelve en
 *               cada tick— pero la API y los scripts sí.
 */
async function predecirActivo({ candles, interval, precio, bloques, nivel = null }) {
  const clave = `${interval}:${bloques}:${candles.length}:${candles[candles.length - 1].openTime}`;
  const conformes = await cacheConforme.wrap(clave, async () => forecast.cuantilesConformes(candles, { bloques }), 300_000);

  const f = forecast.predecir(candles, { bloques, precio, conformes });
  if (!f.ok) return f;

  const cal = calibracion.calibrar(candles, { bloques, paso: Math.max(1, Math.floor(candles.length / 300)) });
  const salida = { ...f, calibracion: cal.ok ? { ...cal, veredicto: calibracion.veredicto(cal) } : { ok: false, reason: cal.reason } };

  // La probabilidad de acabar por encima de un nivel, para quien consuma la API
  // por su cuenta. El navegador NO usa esto: la respuesta ya trae la rejilla de
  // la distribución y resuelve cualquier nivel en cada tick, sin volver a
  // preguntar. Responder aquí a diez ticks por segundo sería absurdo.
  if (nivel > 0) {
    const r = forecast.probabilidadEncima({ precio: f.precio, nivel, sigmaHorizonte: f.sigmaHorizonte, rejilla: f.rejilla });
    if (r) salida.probabilidad = { nivel, encima: r.p, debajo: 1 - r.p, fuera: r.fuera, resolucion: r.resolucion };
  }

  return salida;
}

/**
 * Todos los horizontes del plan, cada uno con la serie que le toca.
 *
 * @param series  { '1m': [velas], '1h': [velas], … } — una por intervalo que el
 *                plan necesite. Quien llama decide de dónde salen: el servidor
 *                las consolida entre mercados, un script puede tirar de una
 *                sola casa.
 */
async function predecirHorizontes({ series, interval, precio = null, nivel = null }) {
  const plan = forecast.planDeHorizontes(interval);
  const salida = [];

  for (const h of plan) {
    const velas = series[h.interval];
    if (!velas || !velas.length) continue;
    salida.push({
      bloques: h.bloques,
      ms: h.ms,
      desde: h.interval,
      ...(await predecirActivo({ candles: velas, interval: h.interval, precio, bloques: h.bloques, nivel })),
    });
  }

  return salida;
}

// Qué intervalos hacen falta para cubrir el plan de un intervalo dado.
function seriesNecesarias(interval) {
  return [...new Set(forecast.planDeHorizontes(interval).map((h) => h.interval))];
}

module.exports = { predecirActivo, predecirHorizontes, seriesNecesarias, cacheConforme };
