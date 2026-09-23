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

  // CUÁL DE LAS CUATRO FECHAS. Kalshi publica `close_time`,
  // `expected_expiration_time`, `expiration_time` y `latest_expiration_time`, y
  // no significan lo mismo: la primera es cuándo deja de poder operarse, y las
  // últimas son plazos administrativos que pueden caer mucho después.
  //
  // Esto empezó prefiriendo `expiration_time` y los datos reales lo
  // desmintieron: un contrato titulado «Bitcoin price on Sep 25» salía con
  // vencimiento a SIETE días mirándolo el día 23. Cinco días de más, en un
  // motor cuyo límite son veinticuatro horas — o sea, rechazarlo todo por un
  // plazo inventado.
  //
  // Manda `close_time`, y por dos razones que apuntan igual: es el instante en
  // que el precio queda fijado para estos contratos de «precio en la fecha X»,
  // y además es cuando dejamos de poder actuar. Modelar más allá sería estimar
  // la incertidumbre de un rato en el que ya no se puede ni comprar ni vender.
  const cierre = fecha(market.close_time);
  const expira = fecha(market.expected_expiration_time) || fecha(market.expiration_time);
  const vencimiento = cierre || expira;
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
    // Las dos por separado, para poder verlas cuando discrepen. Que discrepen
    // es normal; que discrepen MUCHO suele querer decir que estamos leyendo la
    // fecha equivocada, y sin enseñarlas eso no se detecta.
    cierre,
    expira,
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
 * Qué series hay abiertas, y de cuáles entendemos los contratos.
 *
 * Existe porque el primer obstáculo real para probar esto es acertar el
 * `series_ticker`, y un ticker equivocado devuelve una lista vacía en silencio
 * —que se lee como «hoy no hay oportunidades» cuando en realidad es «te has
 * equivocado de nombre»—. Aquí se pide el listado general y se agrupa por
 * serie, diciendo de cada una cuántos contratos se entienden.
 *
 * Lo que importa de la tabla no es el volumen: es la columna de «entendidos».
 * Una serie con mil mercados de los que entendemos cero no se puede operar.
 */
// Un mercado "MVE" es una combinada de varias patas ("sí Toronto, sí Detroit,
// …"): no es una opción de un evento, es una apuesta múltiple. El analizador de
// predicciones ya las descartaba, y aquí también sobran.
//
// Cuánto sobran, medido contra Kalshi de verdad: pedir /markets sin filtro
// devolvió 5000 mercados y los 5000 eran combinadas de la NFL. Por eso la
// exploración va por /events con mercados anidados —la ruta que el analizador
// de predicciones lleva usando en producción— y no por el listado general.
function esMve(m) {
  return Boolean(m && (m.mve_collection_ticker || (Array.isArray(m.mve_selected_legs) && m.mve_selected_legs.length)));
}

async function explorarSeries({ paginas = 25, porPagina = 200, timeoutMs = 15_000, filtro = null, ahora = Date.now() } = {}) {
  const series = new Map();
  let cursor = null;
  let total = 0;

  // Con qué se encontró de verdad, para poder DECIRLO cuando no sale nada.
  // Antes, una respuesta con otra forma dejaba la lista vacía y el escáner
  // enseñaba una tabla en blanco: indistinguible de «hoy no hay mercados», que
  // es la conclusión equivocada y la que más tiempo hace perder.
  // `agotado` importa tanto como el resto: sin él no se distingue «he visto
  // todo lo que hay» de «me quedé sin páginas», y son conclusiones opuestas.
  // La primera dice que esa serie no existe; la segunda, que hay que seguir
  // mirando.
  const diagnostico = { url: `${KALSHI_BASE}/events`, envoltura: null, muestra: null, paginas: 0, mve: 0, eventos: 0, agotado: false };

  for (let i = 0; i < paginas; i++) {
    const raw = await fetchJson(diagnostico.url, {
      timeoutMs,
      searchParams: { status: 'open', limit: porPagina, with_nested_markets: 'true', cursor: cursor || undefined },
    });

    if (!diagnostico.envoltura) {
      diagnostico.envoltura = raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw;
      diagnostico.muestra = JSON.stringify(raw).slice(0, 600);
    }
    diagnostico.paginas++;

    const eventos = Array.isArray(raw?.events) ? raw.events : [];
    if (!eventos.length) { diagnostico.agotado = true; break; }
    diagnostico.eventos += eventos.length;

    for (const ev of eventos) {
      const serie = String(ev.series_ticker || ev.event_ticker || '').split('-')[0];
      if (!serie) continue;

      const mercados = Array.isArray(ev.markets) ? ev.markets : [];
      total += mercados.length;

      if (filtro) {
        const texto = `${serie} ${ev.title || ''} ${ev.sub_title || ''}`.toUpperCase();
        if (!texto.includes(filtro.toUpperCase())) continue;
      }

      for (const m of mercados) {
        if (esMve(m)) { diagnostico.mve++; continue; }
        if (!diagnostico.campos) diagnostico.campos = Object.keys(m);

        const e = series.get(serie) || {
          serie, mercados: 0, entendidos: 0, volumen: 0, ejemplo: null,
          formas: new Set(), vencePronto: null, dentroDeUnDia: 0,
        };
        e.mercados++;
        e.volumen += Number(m.volume) || 0;

        const n = normalizar(m);
        if (n) {
          e.entendidos++;
          e.formas.add(n.tipo);

          // El plazo es lo que decide si una serie es operable POR ESTE motor,
          // y sin esta columna no se ve: una serie de contratos a ocho días y
          // otra de contratos a una hora se parecen en todo lo demás, y la
          // primera se descarta entera por vencer más allá de donde el modelo
          // está medido. Enterarse ahí abajo, mercado a mercado, es tarde.
          const falta = n.vencimiento - ahora;
          if (falta > 0) {
            if (e.vencePronto === null || falta < e.vencePronto) e.vencePronto = falta;
            if (falta <= 24 * 3600_000) e.dentroDeUnDia++;
          }

          // Cuánto se separan las dos fechas. Una separación grande es la
          // señal de estar leyendo la equivocada, y costó cinco días de plazo
          // fantasma descubrirlo la primera vez.
          if (n.cierre && n.expira) {
            const brecha = Math.abs(n.expira - n.cierre);
            if (brecha > (e.brecha || 0)) e.brecha = brecha;
          }
        }
        // Aunque no se entienda, el título ayuda a saber qué es esa serie y si
        // merece la pena enseñarle al traductor a leerla.
        if (!e.ejemplo) e.ejemplo = (n && n.titulo) || ev.title || m.title || m.yes_sub_title || '';
        series.set(serie, e);
      }
    }

    cursor = raw?.cursor || null;
    if (!cursor) { diagnostico.agotado = true; break; }
  }

  const lista = [...series.values()]
    .map((e) => ({ ...e, formas: [...e.formas] }))
    .sort((a, b) => b.entendidos - a.entendidos || b.volumen - a.volumen);

  return { total, series: lista, diagnostico };
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

module.exports = { listarMercados, explorarSeries, esMve, normalizar, precio, mercadosDemo, KALSHI_BASE };
