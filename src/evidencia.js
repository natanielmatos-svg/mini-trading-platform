'use strict';
// Solo observaciones prospectivas: nunca reconstruir pronósticos después del resultado.
const path = require('node:path');
const registro = require('./registro');
const forecast = require('./forecast');
const edge = require('./kalshi-edge');
const RUTA = path.join(__dirname, '..', 'datos', 'evidencia.jsonl');
const VERSION = 'stat-v2-reference-audit';
function crear({ ruta = RUTA, reloj = Date.now } = {}) {
  const history = registro.leer({ ruta });
  if (history.rotas) throw new Error('Registro de evidencia dañado');
  const observaciones = new Map(history.entradas.filter(e => e.tipo === 'observacion').map(e => [e.id, e]));
  const resueltos = new Set(history.entradas.filter(e => e.tipo === 'resultado').map(e => e.ticker));
  const intentos = new Map();
  function guardar(e) {
    if (!registro.anotar({ ...e, t: new Date(reloj()).toISOString() }, { ruta })) throw new Error('No se pudo guardar evidencia');
  }
  function observar({ mercado: m, prediccion, precio, decision, cruda, referencia, ahora = reloj() }) {
    const plazo = m.vencimiento - ahora;
    if (!(plazo > 120000 && plazo <= 86400000) || resueltos.has(m.ticker)) return;
    // Primera observación por contrato y tramo de plazo, no una muestra nueva por ciclo.
    const tramo = plazo <= 900000 ? '2-15m' : plazo <= 3600000 ? '15-60m' : '1-24h';
    const id = [VERSION, m.ticker, tramo].join('|');
    if (observaciones.has(id)) return;
    const dist = forecast.distribucionEn(prediccion?.horizontes, plazo, { ruidoBase: edge.LIMITES.ruidoBase });
    const r = dist ? edge.probabilidadYes(m, precio, dist) : null;
    const p = r?.ok && Number.isFinite(r.p) ? r.p : null;
    const baseline = Number.isFinite(m.yesBid) && Number.isFinite(m.yesAsk) && m.yesBid <= m.yesAsk ? (m.yesBid + m.yesAsk) / 2 : null;
    const e = { tipo: 'observacion', id, version: VERSION, ticker: m.ticker, tramo, observadoEn: ahora,
      vencimiento: m.vencimiento, p, baseline, precio, fuente: prediccion?.fuente || 'no declarada',
      objetivo: prediccion?.objetivo || 'precio instantáneo; liquidación pendiente de verificar',
      referencia: referencia?.ok ? { price: referencia.price, at: referencia.at, index: referencia.index } : null,
      mercado: { yesBid: m.yesBid, yesAsk: m.yesAsk, noBid: m.noBid, noAsk: m.noAsk, libro: m.libro },
      decision: { operar: !!decision.operar, vetado: !!decision.vetado, motivo: decision.motivo || null },
      sinVeto: { operar: !!cruda.operar, motivo: cruda.motivo || null },
      costesOperativosUSD: null, comisiones: 'estimadas; verificar tarifa por serie' };
    guardar(e); observaciones.set(id, e);
  }
  async function resolver(obtenerResultado) {
    const ahora = reloj();
    const pendientes = [...new Set([...observaciones.values()].filter(e => e.vencimiento <= ahora && !resueltos.has(e.ticker)).map(e => e.ticker))];
    let consultados = 0, recuperados = 0, errores = 0;
    for (const ticker of pendientes) {
      if ((intentos.get(ticker) || 0) > ahora || consultados >= 20) continue;
      consultados++; intentos.set(ticker, ahora + 300000);
      try {
        const official = await obtenerResultado(ticker);
        const resultado = typeof official==='string'?official:official?.resultado;
        if (!['yes', 'no'].includes(resultado)) continue;
        guardar({ tipo: 'resultado', ticker, resultado, fuente: typeof official==='string'?'Kalshi resultado oficial':`Kalshi status=${official.status}`, settlementAt:typeof official==='object'?official.settlementAt:null });
        resueltos.add(ticker);
        recuperados++;
      } catch { errores++; /* Reintento acotado sin impedir reconciliar los demás. */ }
    }
    return {consultados,recuperados,errores};
  }
  return { observar, resolver };
}
function resumir(entradas) {
  const obs = new Map(), resultados = new Map();
  for (const e of entradas) {
    if (e.tipo === 'observacion' && e.observadoEn < e.vencimiento && !obs.has(e.id)) obs.set(e.id, e);
    if (e.tipo === 'resultado' && ['yes', 'no'].includes(e.resultado)) resultados.set(e.ticker, e.resultado === 'yes' ? 1 : 0);
  }
  const grupos = new Map();
  let resueltas = 0;
  for (const e of obs.values()) {
    if (!resultados.has(e.ticker)) continue;
    resueltas++;
    if (![e.p, e.baseline].every(p => Number.isFinite(p) && p >= 0 && p <= 1)) continue;
    const key = e.version + '/' + e.tramo;
    if (!grupos.has(key)) grupos.set(key, { grupo: key, n: 0, brierModelo: 0, brierKalshi: 0, contratos: new Set() });
    const g = grupos.get(key), y = resultados.get(e.ticker);
    g.n++; g.contratos.add(e.ticker); g.brierModelo += (e.p - y) ** 2; g.brierKalshi += (e.baseline - y) ** 2;
  }
  return { observaciones: obs.size, contratos: new Set([...obs.values()].map(e => e.ticker)).size,
    resueltas, pendientes: obs.size - resueltas,
    comparaciones: [...grupos.values()].map(g => ({ grupo: g.grupo, n: g.n, contratos: g.contratos.size, brierModelo: g.brierModelo / g.n, brierKalshi: g.brierKalshi / g.n })),
    rentabilidadDemostrada: false, beneficioNetoUSD: null,
    nota: 'Brier menor es mejor. Franjas del mismo evento están correlacionadas. Costes de IA y ejecución aún sin validar: no se acredita rentabilidad.' };
}
function leerResumen() {
  const { entradas, rotas } = registro.leer({ ruta: RUTA });
  if (rotas) throw new Error('Registro de evidencia dañado');
  const ledger = registro.leer();
  if (ledger.rotas) throw new Error('Cuaderno de operaciones dañado');
  let pnl = 0, peak = 0, drawdown = 0, cierres = 0;
  for (const e of ledger.entradas) {
    if (!['salida','liquidacion'].includes(e.tipo) || !Number.isFinite(e.pnl)) continue;
    pnl += e.pnl; peak = Math.max(peak, pnl); drawdown = Math.max(drawdown, peak - pnl); cierres++;
  }
  return { ...resumir(entradas), papel: { cierres, pnlRealizadoEstimadoUSD: pnl, drawdownRealizadoUSD: drawdown,
    nota: 'Solo cierres simulados, con comisión estimada. Excluye costes de IA y pérdidas no realizadas.' } };
}
module.exports = { crear, resumir, leerResumen, RUTA };
