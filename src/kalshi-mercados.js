'use strict';

// Los contratos de Kalshi, traducidos a algo que el motor sepa valorar.
//
// Se lee de los CAMPOS ESTRUCTURADOS que devuelve la API —`strike_type`,
// `floor_strike`, `cap_strike`, `expiration_time`— y nunca del título. Deducir
// «por encima de 88.000» del texto funciona hasta que Kalshi cambia una palabra
// y el bot empieza a apostar al revés sin que nada falle. Lo que no se pueda
// mapear con seguridad se descarta: no operar un mercado cuesta cero, y
// operarlo al revés cuesta todo.

const { fetchJson } = require('./http');
const { centsToProb } = require('./providers/kalshi');

const KALSHI_BASE = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';

// Kalshi renombró los precios de céntimos enteros (`yes_bid`) a dólares
// decimales (`yes_bid_dollars`). Se prefieren los nuevos y se cae a los viejos,
// igual que hace el proveedor de lectura.
function precio(market, campo) {
  const dolares = Number(market[`${campo}_dollars`]);
  if (Number.isFinite(dolares) && dolares > 0 && dolares < 1) return dolares;
  return centsToProb(market[campo]);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function fecha(v) {
  if (!v) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * De un mercado de la API a la forma que entiende el motor.
 *
 * Devuelve null cuando falta cualquier cosa necesaria. La lista de tipos es
 * deliberadamente corta: los que se sabe leer.
 */
function normalizar(market) {
  if (!market || market.status === 'closed' || market.status === 'settled') return null;

  const vencimiento = fecha(market.expiration_time) || fecha(market.close_time);
  if (!vencimiento) return null;

  const suelo = num(market.floor_strike);
  const techo = num(market.cap_strike);
  const tipoApi = String(market.strike_type || '').toLowerCase();

  let tipo = null;
  if ((tipoApi === 'greater' || tipoApi === 'greater_or_equal') && suelo > 0) tipo = 'mayor';
  else if ((tipoApi === 'less' || tipoApi === 'less_or_equal') && techo > 0) tipo = 'menor';
  else if (tipoApi === 'between' && suelo > 0 && techo > suelo) tipo = 'franja';
  // Sin `strike_type` pero con un solo extremo, la forma es inequívoca.
  else if (!tipoApi && suelo > 0 && !(techo > 0)) tipo = 'mayor';
  else if (!tipoApi && techo > 0 && !(suelo > 0)) tipo = 'menor';

  if (!tipo) return null;

  const yesBid = precio(market, 'yes_bid');
  const yesAsk = precio(market, 'yes_ask');

  return {
    ticker: market.ticker,
    titulo: market.title || market.yes_sub_title || market.ticker,
    tipo,
    suelo,
    techo,
    vencimiento,
    yesBid,
    yesAsk,
    // Kalshi publica los dos lados; cuando falta uno se deriva, porque comprar
    // NO a `n` es exactamente lo mismo que vender SÍ a `1 − n`.
    noBid: precio(market, 'no_bid') ?? (yesAsk !== null ? 1 - yesAsk : null),
    noAsk: precio(market, 'no_ask') ?? (yesBid !== null ? 1 - yesBid : null),
    libro: {
      yesAsk: num(market.yes_ask_quantity),
      noAsk: num(market.no_ask_quantity),
    },
    volumen: num(market.volume) || 0,
    interesAbierto: num(market.open_interest) || 0,
  };
}

/**
 * Los mercados abiertos de una serie (por ejemplo la de bitcoin por horas).
 *
 * `serie` es el `series_ticker` de Kalshi. No se adivina: se pasa, y el CLI lo
 * enseña, porque un ticker equivocado devolvería una lista vacía en silencio y
 * eso parecería «hoy no hay oportunidades».
 */
async function listarMercados({ serie, limit = 200, timeoutMs = 10_000 } = {}) {
  if (!serie) throw new Error('hace falta el series_ticker de Kalshi');

  const raw = await fetchJson(`${KALSHI_BASE}/markets`, {
    timeoutMs,
    searchParams: { series_ticker: serie, status: 'open', limit: Math.min(limit, 1000) },
  });

  const crudos = Array.isArray(raw?.markets) ? raw.markets : [];
  const mercados = crudos.map(normalizar).filter(Boolean);

  return {
    serie,
    total: crudos.length,
    // Los descartados importan: si de 40 mercados se entienden 0, el problema
    // es nuestro y hay que verlo, no quedarse esperando oportunidades.
    entendidos: mercados.length,
    descartados: crudos.length - mercados.length,
    mercados,
  };
}

/**
 * Mercados de mentira, para probar el camino entero sin red.
 *
 * Los precios salen de NUESTRA propia distribución, redondeados al céntimo y
 * con una horquilla de dos: el mercado nos da exactamente la razón. Con
 * `sesgo` a cero no hay nada que operar, y eso es lo honesto —un mercado que
 * piensa lo mismo que tú no te debe dinero—. Con sesgo se ve funcionar el
 * camino positivo, y lo que se ve entonces es una ventaja INVENTADA.
 */
function mercadosDemo({ precio, horizontes, sesgo = 0, symbol = 'BTCUSDT', ahora = Date.now() } = {}) {
  const forecast = require('./forecast');
  const mercados = [];

  // El plazo cortísimo va a propósito: con velas de ejemplo suele ser el único
  // horizonte bien calibrado, y sin él el filtro descarta todo.
  for (const minutos of [2.5, 10, 30, 60]) {
    const falta = minutos * 60_000;
    const dist = forecast.distribucionEn(horizontes, falta);
    if (!dist) continue;

    for (const desvio of [-0.004, -0.002, 0, 0.002, 0.004]) {
      const suelo = Math.round((precio * (1 + desvio)) / 50) * 50;
      const r = forecast.probabilidadEncima({ precio, nivel: suelo, sigmaHorizonte: dist.sigmaHorizonte, rejilla: dist.rejilla });
      if (!r || r.fuera) continue;

      const medio = Math.min(Math.max(Math.round((r.p + sesgo / 100) * 100), 3), 97);
      const yesBid = (medio - 1) / 100;
      const yesAsk = (medio + 1) / 100;

      mercados.push({
        ticker: `DEMO-${String(minutos).replace('.', 'M')}M-${suelo}`,
        titulo: `DEMO: ${symbol} por encima de ${suelo} dentro de ${minutos} min`,
        tipo: 'mayor', suelo, techo: null,
        vencimiento: ahora + falta,
        yesBid, yesAsk, noBid: 1 - yesAsk, noAsk: 1 - yesBid,
        libro: { yesAsk: 500, noAsk: 500 },
        volumen: 1000, interesAbierto: 500,
      });
    }
  }

  return { serie: 'DEMO', total: mercados.length, entendidos: mercados.length, descartados: 0, mercados };
}

module.exports = { listarMercados, normalizar, precio, mercadosDemo, KALSHI_BASE };
