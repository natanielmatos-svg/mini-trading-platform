'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { createHash } = require('node:crypto');
const { TtlCache } = require('./cache');
const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 40 });
const root = path.resolve(__dirname, '..');
let worker = null;
let sequence = 0;
const pending = new Map();

function predictLocal(values, options = {}) {
  if (!fs.existsSync(path.join(root, 'data/models/timesfm-2.5/model.safetensors'))) {
    return Promise.reject(new Error('El modelo local todavía no está descargado.'));
  }
  if (pending.size >= 3) return Promise.reject(new Error('Motor ocupado. Vuelve a intentarlo en unos segundos.'));
  if (!worker) {
    const python = process.env.FORECAST_PYTHON || path.join(root, '.venv-forecast', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const child = spawn(python, ['-u', path.join(root, 'forecast/worker_shared.py')], { cwd: root, windowsHide: true, stdio: ['pipe','pipe','ignore'] });
    worker = child;
    const fail = () => {
      if (worker === child) worker = null;
      for (const [id,p] of pending) if (p.child === child) {
        clearTimeout(p.timer); p.reject(new Error('El motor local se ha detenido.')); pending.delete(id);
      }
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const msg = JSON.parse(line); const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
      } catch { fail(); child.kill(); }
    });
  }
  return new Promise((resolve,reject) => {
    const id = ++sequence;
    const child = worker;
    const timer = setTimeout(() => { child.kill(); }, 180_000);
    pending.set(id, { resolve, reject, timer, child });
    child.stdin.write(JSON.stringify({ ...options, id, values }) + '\n');
  });
}

function prepare(candles, { now = Date.now(), market = 'crypto', clock = null, sessionAligned=false, intervalMs=null } = {}) {
  if (market === 'stocks' && (!clock || !clock.isOpen)) return { ok: false, reason: 'Mercado cerrado o sesión sin verificar.' };
  if (!Array.isArray(candles) || candles.length < 125) return { ok: false, reason: 'Se necesitan al menos 125 velas.' };
  const last = candles.at(-1);
  const step = intervalMs || last.openTime - candles.at(-2).openTime;
  if (!(step > 0) || !(last.openTime <= now && last.closeTime >= now)) return { ok: false, reason: 'No hay una vela actual: datos atrasados.' };
  const closed = candles.filter(c => c.closed !== false && c.closeTime < now);
  if (closed.length < 124 || (!sessionAligned&&closed.at(-1).openTime !== last.openTime - step)) return { ok: false, reason: 'Histórico incompleto.' };
  if (closed.some((c,i) => !Number.isFinite(c.close) || c.close <= 0 || (i && (c.openTime<=closed[i-1].openTime||(!sessionAligned&&c.openTime - closed[i-1].openTime !== step))))) {
    return { ok: false, reason: 'La serie tiene huecos o precios inválidos.' };
  }
  return { ok: true, values: closed.map(c => c.close), closesAt: last.closeTime + 1,
    anchor: closed.at(-1).close, anchorAt: closed.at(-1).closeTime + 1, stepMs: step,
    currentPrice: Number.isFinite(last.close) && last.close > 0 ? last.close : null,
    // Opening time is not the observation time of the mutable candle close.
    observedAt: Number.isFinite(last.observedAt) && last.observedAt >= last.openTime && last.observedAt <= now ? last.observedAt : null };
}

async function forecast(data, { now = Date.now(), predict = predictLocal, market = 'crypto', clock = null } = {}) {
  const startedAt = Date.now();
  let candles=data.candles,sessionAligned=false,intervalMs=null;
  if(market==='stocks'&&clock?.isOpen&&Array.isArray(data.calendar)){
    intervalMs=require('./alpaca').intervalMinutes(data.interval)*60000;
    try{candles=require('./stock-neural-session').align(candles,data.calendar,intervalMs);sessionAligned=true;}catch(e){return {ok:false,reason:e.message};}
  }
  const input = prepare(candles, { now, market, clock, sessionAligned,intervalMs });
  if (!input.ok) return input;
  const digest = createHash('sha256').update(JSON.stringify([data.symbol, data.interval, data.source, input.values])).digest('hex');
  const result = await cache.wrap(digest, () => predict(input.values));
  if (input.closesAt <= now + Date.now() - startedAt) return { ok: false, reason: 'El bloque cerró durante el cálculo. Actualiza para estimar el siguiente.' };
  if (!Number.isFinite(result.estimatedClose) || result.estimatedClose <= 0 || !Array.isArray(result.quantiles) || result.quantiles.length !== 9 || result.quantiles.some(x => !Number.isFinite(x) || x <= 0)) throw new Error('Predicción local inválida.');
  const v = result.validation;
  const useful = v && v.samples >= 100 && v.mae < v.baselineMae && v.directionAccuracy > .55;
  const referenceUnit = market === 'stocks' || data.source === 'consolidado' ? 'USD' : 'USDT';
  const generatedAt = Date.now();
  const effectiveNow = now + generatedAt - startedAt;
  const insufficient = !v || !Number.isFinite(v.samples) || v.samples < 100;
  return { ...result, ok: true, symbol: data.symbol, interval: data.interval, source: data.source,
    referenceUnit,
    demo: String(data.source).includes('demo'), closesAt: input.closesAt,
    anchor: input.anchor, anchorAt: input.anchorAt, generatedAt,
    rawEstimatedClose: result.estimatedClose, intrablockConditioned: false,
    target: { kind: 'candle-close', source: data.source, unit: referenceUnit,
      closesAt: input.closesAt, settlementEquivalent: false },
    horizon: { steps: 1, stepMs: input.stepMs, fromAt: input.anchorAt,
      remainingMs: Math.max(0, input.closesAt - effectiveNow) },
    baseline: { kind: 'current-candle-last-price', price: input.currentPrice,
      observedAt: input.observedAt,
      snapshotAt: Number.isFinite(data.fetchedAt) && data.fetchedAt <= effectiveNow ? data.fetchedAt : null,
      source: data.source, unit: referenceUnit,
      note: 'Referencia sencilla para comparar al cierre; no es el resultado final. Sin observedAt no se conoce la edad del último precio.' },
    validationStatus: { sampleCount: v?.samples || 0, requiredSamples: 100,
      status: insufficient ? 'insufficient-sample' : useful ? 'historical-check-passed' : 'baseline-not-beaten',
      prospective: false,
      reason: insufficient ? 'La validación histórica breve no alcanza 100 casos; no acredita una ventaja.' : 'La validación histórica no sustituye la evaluación prospectiva.' },
    direction: result.estimatedClose === input.anchor ? 'sin cambio estimado' : (result.estimatedClose > input.anchor ? 'subida estimada' : 'bajada estimada'),
    historicalCheckPassed: !!useful, tradingEdgeValidated: false,
    note: 'Estimación experimental desde la última vela cerrada; no incorpora movimientos dentro del bloque. Pronostica el cierre de esta serie, no el índice ni el promedio de liquidación de Kalshi. La validación breve no demuestra una ventaja operativa.' };
}
function stop() { if (worker) worker.kill(); }
process.once('exit', stop);
module.exports = { forecast, prepare, cache, stop, predictExperiment:(values,horizon,contexts)=>predictLocal(values,{mode:'experiment',horizon,contexts}) };
