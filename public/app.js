'use strict';

// Plataforma de trading: gráfico, tabla multi-timeframe y panel de ruptura.
//
// Antes esto vivía dentro de index.html con su propia copia de la EMA. Ahora
// los indicadores llegan de /lib/indicators.js, que es el mismo archivo que
// usa el servidor para el análisis: no puede haber dos EMAs que discrepen.

// Todo el archivo va dentro de una función: indicators.js declara sus funciones
// en el ámbito global y sin esto `emaSeries` chocaría con la copia local.
(function () {
const { emaSeries, ema, shareAtLeast, requiredExcursion } = globalThis.Indicators;

const MTF = ['1h', '4h', '1d', '1w'];
const CANDLES = 300;

const state = {
  symbol: 'BTCUSDT',
  interval: '1h',
  candles: [],
  mtf: {},          // timeframe -> array de velas
  breakout: null,
  live: null,       // último tick del WebSocket
  source: null,     // 'binance' | 'demo'
  fetchedAt: null,
  loading: false,
  failures: 0,
  streamState: 'desconectado',
  sse: null,
  refreshTimer: null,
  hover: null,      // índice de la vela bajo el cursor
};

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('priceChart'),
  symbol: $('symbolInput'),
  interval: $('intervalSelect'),
  load: $('loadBtn'),
  emaFast: $('emaFast'),
  emaSlow: $('emaSlow'),
  emaWarning: $('emaWarning'),
  status: $('statusText'),
  price: $('livePrice'),
  priceChange: $('priceChange'),
  streamDot: $('streamDot'),
  streamLabel: $('streamLabel'),
  tooltip: $('tooltip'),
  breakout: $('breakoutPanel'),
  countdown: $('countdown'),
};

const ctx = el.canvas.getContext('2d');

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

function decimalsFor(price) {
  if (!(price > 0)) return 2;
  if (price >= 1000) return 1;
  if (price >= 10) return 2;
  if (price >= 1) return 4;
  return 6;
}

function fmtPrice(value) {
  if (!Number.isFinite(value)) return '—';
  const d = decimalsFor(Math.abs(value));
  return value.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtNum(value, decimals = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('es-ES', { maximumFractionDigits: decimals });
}

function fmtPct(fraction, decimals = 1) {
  if (!Number.isFinite(fraction)) return '—';
  return `${fmtNum(fraction * 100, decimals)}%`;
}

function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtTimeAxis(ms, interval) {
  const d = new Date(ms);
  if (['1d', '3d', '1w', '1M'].includes(interval)) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function intervalToMs(interval) {
  const table = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '8h': 288e5, '12h': 432e5, '1d': 864e5, '3d': 2592e5, '1w': 6048e5 };
  return table[interval] || 36e5;
}

// Longitudes de EMA validadas. El bug que teníamos: con el campo vacío
// parseInt daba NaN, la EMA devolvía NaN, y `NaN > NaN` es false, así que la
// tabla pintaba "Bajista" en rojo en los cuatro timeframes.
function emaLengths() {
  const fast = parseInt(el.emaFast.value, 10);
  const slow = parseInt(el.emaSlow.value, 10);
  const valid = (n) => Number.isInteger(n) && n >= 1 && n <= 500;

  if (!valid(fast) || !valid(slow)) {
    return { fast: null, slow: null, warning: 'Las EMAs deben ser números enteros entre 1 y 500.' };
  }
  if (fast >= slow) {
    return { fast, slow, warning: 'La EMA rápida debería ser más corta que la lenta; con estos valores la señal se invierte.' };
  }
  return { fast, slow, warning: '' };
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

async function getJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json();
      detail = body.details || body.error || '';
    } catch {
      /* la respuesta no era JSON */
    }
    throw new Error(`HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`);
  }
  return resp.json();
}

function klinesUrl(interval, limit = CANDLES) {
  return `/api/klines?symbol=${encodeURIComponent(state.symbol)}&interval=${interval}&limit=${limit}`;
}

async function loadAll({ silent = false } = {}) {
  if (state.loading) return; // sin esto, una carga lenta se solapa con la siguiente
  state.loading = true;
  if (!silent) setStatus(`Cargando ${state.symbol}…`);

  try {
    // El timeframe del gráfico suele ser uno de los de la tabla: pedirlo dos
    // veces era una llamada de cada cinco tirada a la basura.
    const needed = [...new Set([state.interval, ...MTF])];
    const results = await Promise.all(needed.map((tf) => getJson(klinesUrl(tf))));

    const byInterval = {};
    needed.forEach((tf, i) => {
      byInterval[tf] = results[i];
    });

    state.candles = byInterval[state.interval].candles;
    state.source = byInterval[state.interval].source;
    state.fetchedAt = byInterval[state.interval].fetchedAt;
    state.mtf = Object.fromEntries(MTF.map((tf) => [tf, byInterval[tf].candles]));
    state.failures = 0;

    await loadBreakout();
    render();
    setStatus('');
  } catch (err) {
    state.failures += 1;
    setStatus(`No se pudieron cargar los datos: ${err.message}`, true);
  } finally {
    state.loading = false;
    scheduleRefresh();
  }
}

async function loadBreakout() {
  try {
    const price = state.live ? state.live.close : null;
    const url = `/api/breakout?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}${price ? `&price=${price}` : ''}`;
    state.breakout = await getJson(url);
    state.breakoutPriceAtFetch = state.breakout.price;
  } catch (err) {
    state.breakout = { ok: false, reason: `No se pudo calcular: ${err.message}` };
  }
}

// Reintentos con espera creciente: si el servidor está caído, insistir cada
// minuto no lo levanta y sí llena su log.
function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (document.hidden) return; // una pestaña de fondo no necesita datos frescos

  const base = clamp(intervalToMs(state.interval) / 20, 20_000, 120_000);
  const delay = state.failures ? Math.min(base * 2 ** state.failures, 600_000) : base;

  state.refreshTimer = setTimeout(() => loadAll({ silent: true }), delay);
}

// ---------------------------------------------------------------------------
// Datos en vivo (SSE)
// ---------------------------------------------------------------------------

function connectStream() {
  if (state.sse) state.sse.close();

  const url = `/api/stream?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}`;
  const sse = new EventSource(url);
  state.sse = sse;
  setStreamState('conectando');

  sse.addEventListener('kline', (event) => {
    try {
      onTick(JSON.parse(event.data));
    } catch {
      /* mensaje ilegible: se ignora, el siguiente llegará bien */
    }
  });

  sse.addEventListener('status', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.state === 'degraded') setStreamState('sondeo');
      else if (data.state === 'error') setStreamState('error');
    } catch {
      /* idem */
    }
  });

  // EventSource reconecta solo; aquí sólo se refleja en la interfaz.
  sse.onerror = () => setStreamState(sse.readyState === EventSource.CLOSED ? 'desconectado' : 'reconectando');
  sse.onopen = () => setStreamState('en vivo');
}

function onTick(tick) {
  if (tick.symbol !== state.symbol || tick.interval !== state.interval) return;

  state.live = tick;
  setStreamState(tick.source === 'demo' ? 'demo' : tick.source === 'poll' ? 'sondeo' : 'en vivo');

  const candles = state.candles;
  const last = candles[candles.length - 1];

  if (!last) return;
  if (tick.openTime === last.openTime) {
    Object.assign(last, { open: tick.open, high: tick.high, low: tick.low, close: tick.close, volume: tick.volume, closed: tick.closed });
  } else if (tick.openTime > last.openTime) {
    // Vela nueva: la anterior queda cerrada y se recalcula todo contra el
    // servidor, porque los niveles y la muestra histórica acaban de cambiar.
    last.closed = true;
    candles.push({ ...tick });
    if (candles.length > CANDLES) candles.shift();
    loadAll({ silent: true });
  }

  // La tabla multi-timeframe también se mueve: la vela en curso de cada
  // timeframe comparte el último precio con la del gráfico.
  for (const tf of MTF) {
    const series = state.mtf[tf];
    const tail = series && series[series.length - 1];
    if (tail && !tail.closed) {
      tail.close = tick.close;
      tail.high = Math.max(tail.high, tick.close);
      tail.low = Math.min(tail.low, tick.close);
    }
  }

  // Si el precio se ha ido lejos desde el último análisis, los niveles y el
  // texto se han quedado viejos: merece la pena volver a pedirlos.
  const b = state.breakout;
  if (b && b.ok && b.atr > 0 && Math.abs(tick.close - state.breakoutPriceAtFetch) > b.atr * 0.35) {
    state.breakoutPriceAtFetch = tick.close;
    loadBreakout().then(render);
  }

  requestRender();
}

function setStreamState(label) {
  state.streamState = label;
  el.streamLabel.textContent = label;
  el.streamDot.className = `dot ${['en vivo', 'demo'].includes(label) ? 'on' : label === 'desconectado' || label === 'error' ? 'off' : 'warn'}`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let renderQueued = false;

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const { warning } = emaLengths();
  el.emaWarning.textContent = warning;
  el.emaWarning.style.display = warning ? 'block' : 'none';

  drawChart();
  renderTable();
  renderPrice();
  renderBreakout();
}

function setStatus(text, isError = false) {
  const parts = [];
  if (text) parts.push(text);
  if (state.fetchedAt) {
    const origen = state.source === 'demo' ? 'datos de ejemplo' : 'Binance';
    parts.push(`${state.candles.length} velas de ${state.interval} · ${origen} · actualizado ${new Date(state.fetchedAt).toLocaleTimeString('es-ES')}`);
  }
  el.status.textContent = parts.join('\n');
  el.status.classList.toggle('error', isError);
}

function renderPrice() {
  const candles = state.candles;
  if (!candles.length) return;
  const last = candles[candles.length - 1];
  const reference = candles.length > 1 ? candles[candles.length - 2].close : last.open;
  const change = (last.close - reference) / reference;

  el.price.textContent = fmtPrice(last.close);
  el.priceChange.textContent = `${change >= 0 ? '+' : ''}${fmtPct(change, 2)}`;
  el.priceChange.className = `change ${change >= 0 ? 'up' : 'down'}`;
}

// --- Gráfico ---------------------------------------------------------------

const PAD = { top: 14, right: 66, bottom: 26, left: 10 };
const VOLUME_RATIO = 0.18;

function resizeCanvas() {
  // Sin devicePixelRatio el canvas se ve borroso en cualquier pantalla moderna.
  const dpr = window.devicePixelRatio || 1;
  const width = el.canvas.clientWidth;
  const height = el.canvas.clientHeight;
  el.canvas.width = Math.round(width * dpr);
  el.canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function chartGeometry() {
  const w = el.canvas.clientWidth;
  const h = el.canvas.clientHeight;
  const plotW = w - PAD.left - PAD.right;
  const volumeH = h * VOLUME_RATIO;
  const plotH = h - PAD.top - PAD.bottom - volumeH;
  return { w, h, plotW, plotH, volumeH, volumeTop: PAD.top + plotH + 6 };
}

// Escalones "redondos" para la rejilla: 1, 2, 5 por década. Una rejilla en
// 1.037 no la lee nadie.
function niceStep(range, targetLines) {
  const raw = range / targetLines;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function drawChart() {
  const { w, h, plotW, plotH, volumeH, volumeTop } = chartGeometry();
  if (w <= 0 || h <= 0) return;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);

  const candles = state.candles;
  if (candles.length < 2) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Sin datos todavía…', PAD.left + 10, PAD.top + 20);
    return;
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  let maxPrice = Math.max(...highs);
  let minPrice = Math.min(...lows);

  // Los niveles de ruptura entran en la escala: un nivel fuera de pantalla no
  // sirve de nada.
  const b = state.breakout;
  if (b && b.ok) {
    for (const side of [b.up, b.down]) {
      if (side && Number.isFinite(side.level) && side.level < maxPrice * 1.05 && side.level > minPrice * 0.95) {
        maxPrice = Math.max(maxPrice, side.level);
        minPrice = Math.min(minPrice, side.level);
      }
    }
  }

  const margin = (maxPrice - minPrice) * 0.06 || maxPrice * 0.01;
  maxPrice += margin;
  minPrice -= margin;
  const range = maxPrice - minPrice || 1;

  const xStep = plotW / candles.length;
  const xFor = (i) => PAD.left + i * xStep + xStep / 2;
  const yFor = (price) => PAD.top + plotH - ((price - minPrice) / range) * plotH;

  // Rejilla y eje de precios (a la derecha, como en cualquier plataforma).
  const step = niceStep(range, 6);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let price = Math.ceil(minPrice / step) * step; price < maxPrice; price += step) {
    const y = yFor(price);
    ctx.strokeStyle = '#111c33';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(price), PAD.left + plotW + 6, y);
  }

  // Eje de tiempo: unas seis marcas, alineadas a velas reales.
  const tickEvery = Math.max(1, Math.floor(candles.length / 6));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < candles.length; i += tickEvery) {
    const x = xFor(i);
    ctx.strokeStyle = '#0d1729';
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(fmtTimeAxis(candles[i].openTime, state.interval), x, h - PAD.bottom + 6);
  }

  // Volumen, debajo del precio.
  const maxVolume = Math.max(...candles.map((c) => c.volume || 0)) || 1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const barH = ((c.volume || 0) / maxVolume) * (volumeH - 8);
    ctx.fillStyle = c.close >= c.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)';
    ctx.fillRect(xFor(i) - xStep * 0.3, volumeTop + (volumeH - 8) - barH, Math.max(1, xStep * 0.6), barH);
  }

  // Velas.
  const bodyW = Math.max(1, xStep * 0.62);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const x = xFor(i);
    const bull = c.close >= c.open;
    const color = bull ? '#22c55e' : '#ef4444';

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yFor(c.high));
    ctx.lineTo(x, yFor(c.low));
    ctx.stroke();

    const top = Math.min(yFor(c.open), yFor(c.close));
    const height = Math.max(1, Math.abs(yFor(c.close) - yFor(c.open)));
    ctx.fillRect(x - bodyW / 2, top, bodyW, height);

    // La vela en formación va hueca: se ve de un vistazo qué aún puede cambiar.
    if (!c.closed) {
      ctx.fillStyle = '#020617';
      ctx.fillRect(x - bodyW / 2 + 1, top + 1, Math.max(0, bodyW - 2), Math.max(0, height - 2));
      ctx.strokeStyle = color;
      ctx.strokeRect(x - bodyW / 2, top, bodyW, height);
    }
  }

  // EMAs (nulas hasta que hay datos suficientes: la serie arranca donde debe).
  const closes = candles.map((c) => c.close);
  const { fast, slow } = emaLengths();
  if (fast && slow) {
    drawSeries(emaSeries(closes, fast), '#38bdf8', xFor, yFor);
    drawSeries(emaSeries(closes, slow), '#f97316', xFor, yFor);
  }

  // Niveles de ruptura.
  if (b && b.ok) {
    if (b.up) drawLevel(b.up.level, '#f87171', 'R', xFor, yFor, plotW);
    if (b.down) drawLevel(b.down.level, '#4ade80', 'S', xFor, yFor, plotW);
  }

  // Precio actual.
  const last = candles[candles.length - 1];
  drawPriceTag(last.close, last.close >= last.open ? '#22c55e' : '#ef4444', plotW, yFor);

  if (state.hover !== null) drawCrosshair(xFor, yFor, plotW, plotH);
}

function drawSeries(series, color, xFor, yFor) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    const x = xFor(i);
    const y = yFor(v);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawLevel(price, color, tag, xFor, yFor, plotW) {
  if (!Number.isFinite(price)) return;
  const y = yFor(price);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, y);
  ctx.lineTo(PAD.left + plotW, y);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = color;
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${tag} ${fmtPrice(price)}`, PAD.left + 4, y - 2);
}

function drawPriceTag(price, color, plotW, yFor) {
  const y = yFor(price);
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(PAD.left, y);
  ctx.lineTo(PAD.left + plotW, y);
  ctx.stroke();
  ctx.restore();

  const label = fmtPrice(price);
  ctx.font = 'bold 11px system-ui, sans-serif';
  const width = ctx.measureText(label).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(PAD.left + plotW + 2, y - 8, width, 16);
  ctx.fillStyle = '#020617';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, PAD.left + plotW + 7, y);
}

function drawCrosshair(xFor, yFor, plotW, plotH) {
  const c = state.candles[state.hover];
  if (!c) return;
  const x = xFor(state.hover);
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#475569';
  ctx.beginPath();
  ctx.moveTo(x, PAD.top);
  ctx.lineTo(x, PAD.top + plotH);
  ctx.stroke();
  ctx.restore();
}

function onCanvasMove(event) {
  const rect = el.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { plotW } = chartGeometry();
  const xStep = plotW / Math.max(state.candles.length, 1);
  const index = Math.floor((x - PAD.left) / xStep);

  if (index < 0 || index >= state.candles.length) {
    hideTooltip();
    return;
  }

  state.hover = index;
  const c = state.candles[index];
  const change = (c.close - c.open) / c.open;

  el.tooltip.innerHTML = `
    <strong>${new Date(c.openTime).toLocaleString('es-ES')}</strong>
    <span>A ${fmtPrice(c.open)}</span>
    <span>M ${fmtPrice(c.high)}</span>
    <span>m ${fmtPrice(c.low)}</span>
    <span>C ${fmtPrice(c.close)} <em class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${fmtPct(change, 2)}</em></span>
    <span>Vol ${fmtNum(c.volume, 0)}</span>`;
  el.tooltip.style.display = 'grid';
  el.tooltip.style.left = `${clamp(x + 14, 8, rect.width - 170)}px`;
  el.tooltip.style.top = `${clamp(event.clientY - rect.top + 12, 8, rect.height - 120)}px`;
  requestRender();
}

function hideTooltip() {
  state.hover = null;
  el.tooltip.style.display = 'none';
  requestRender();
}

// --- Tabla multi-timeframe -------------------------------------------------

function renderTable() {
  const { fast, slow } = emaLengths();

  for (const tf of MTF) {
    const cell = $(`cell-${tf}`);
    if (!cell) continue;
    const candles = state.mtf[tf];
    const closes = candles ? candles.map((c) => c.close) : [];
    const f = fast ? ema(closes, fast) : null;
    const s = slow ? ema(closes, slow) : null;

    cell.classList.remove('bull', 'bear', 'flat');

    if (!Number.isFinite(f) || !Number.isFinite(s)) {
      cell.textContent = '—';
      cell.classList.add('flat');
      cell.title = 'Sin datos suficientes o parámetros de EMA inválidos';
      continue;
    }

    // Banda neutra: una diferencia del 0,05% entre EMAs no es una tendencia,
    // es ruido. Antes cualquier diferencia pintaba la celda entera.
    const gap = (f - s) / s;
    const label = gap > 0.0005 ? 'Alcista' : gap < -0.0005 ? 'Bajista' : 'Plano';
    cell.textContent = label;
    cell.classList.add(label === 'Alcista' ? 'bull' : label === 'Bajista' ? 'bear' : 'flat');
    cell.title = `EMA${fast} ${fmtPrice(f)} vs EMA${slow} ${fmtPrice(s)} (${gap >= 0 ? '+' : ''}${fmtPct(gap, 2)})`;
  }
}

// --- Panel de ruptura ------------------------------------------------------

// Recalcula la probabilidad con el precio del último tick. Usa exactamente las
// mismas dos funciones que el servidor (requiredExcursion + shareAtLeast) sobre
// la muestra que vino en la respuesta, así que el número que se ve en vivo es
// el que devolvería /api/breakout si se le preguntara en este instante.
function liveSide(side, sample, price, atr, remaining) {
  if (!side || !Number.isFinite(atr) || atr <= 0) return null;

  const distance = side.direction === 'alza' ? side.level - price : price - side.level;
  if (distance <= 0) {
    return { ...side, distance: 0, distancePct: 0, probability: 1, broken: true };
  }

  const distanceAtr = distance / atr;
  const required = requiredExcursion(distanceAtr, remaining);

  return {
    ...side,
    distance,
    distancePct: (distance / price) * 100,
    distanceAtr,
    requiredAtr: required,
    probability: shareAtLeast(sample, required),
    // Misma cuenta sin descontar el tiempo: lo que tendría una vela entera.
    probabilityFullCandle: shareAtLeast(sample, distanceAtr),
    broken: false,
    remaining,
  };
}

function renderBreakout() {
  const b = state.breakout;

  if (!b || !b.ok) {
    el.breakout.innerHTML = `<p class="muted">${b ? b.reason : 'Calculando…'}</p>`;
    el.countdown.textContent = '';
    return;
  }

  const price = state.live ? state.live.close : b.price;
  const now = Date.now();
  const total = b.candle.closeTime - b.candle.openTime + 1;
  const remaining = clamp((b.candle.closeTime - now) / total, 0.01, 1);

  const up = liveSide(b.up, b.sample.up, price, b.atr, remaining);
  const down = liveSide(b.down, b.sample.down, price, b.atr, remaining);

  el.countdown.textContent = `cierra en ${fmtClock(b.candle.closeTime - now)}`;

  const bias = verdictFor(up, down, remaining);

  el.breakout.innerHTML = `
    <div class="verdict ${bias.cls}">${bias.text}</div>
    ${sideHtml(up, 'Ruptura al alza', 'up')}
    ${sideHtml(down, 'Ruptura a la baja', 'down')}
    <details class="method" open>
      <summary>Por qué</summary>
      ${b.explanation.map((line) => `<p>${line}</p>`).join('')}
    </details>
    <details class="method">
      <summary>Contexto (${b.context.length} señales)</summary>
      <ul class="factors">
        ${b.context.map((f) => `<li class="lean-${f.lean}"><strong>${f.label}:</strong> ${f.text}</li>`).join('')}
      </ul>
    </details>
    <details class="method">
      <summary>Cómo confirmar la ruptura</summary>
      ${[b.trigger.up, b.trigger.down].filter(Boolean).map((t) => `<p>${t.text}<br><em>${t.invalidation}</em></p>`).join('')}
    </details>
    <p class="disclaimer">${b.disclaimer}</p>`;
}

// El veredicto tiene que distinguir dos cosas que se parecen en el número y no
// en el significado: que no haya sesgo (las dos paredes igual de lejos) y que
// no dé tiempo (la vela cierra en un minuto y no llega a ninguna).
function verdictFor(up, down, remaining) {
  const pu = up && Number.isFinite(up.probability) ? up.probability : null;
  const pd = down && Number.isFinite(down.probability) ? down.probability : null;

  if (up && up.broken) return { text: `nivel ${fmtPrice(up.level)} superado al alza`, cls: 'bull' };
  if (down && down.broken) return { text: `nivel ${fmtPrice(down.level)} perdido a la baja`, cls: 'bear' };
  if (pu === null || pd === null) return { text: 'sin lado claro', cls: 'flat' };

  if (pu < 0.05 && pd < 0.05) {
    return {
      text: remaining < 0.25 ? 'no le da tiempo a romper nada' : 'lejos de los dos niveles',
      cls: 'flat',
    };
  }
  if (Math.abs(pu - pd) < 0.05) return { text: 'equilibrio entre los dos lados', cls: 'flat' };
  return pu > pd
    ? { text: 'más cerca de romper al alza', cls: 'bull' }
    : { text: 'más cerca de romper a la baja', cls: 'bear' };
}

function sideHtml(side, title, cls) {
  if (!side) return `<div class="side"><header>${title}</header><p class="muted">Sin nivel por delante en el rango analizado.</p></div>`;

  const probability = Number.isFinite(side.probability) ? side.probability : 0;
  const width = clamp(probability * 100, 1, 100);

  return `
    <div class="side ${cls}">
      <header>
        <span>${title}</span>
        <strong>${side.broken ? 'superado' : fmtPct(probability, 0)}</strong>
      </header>
      <div class="bar"><span style="width:${width}%"></span></div>
      <div class="detail">
        ${side.broken
          ? `El precio ya ha pasado ${fmtPrice(side.level)} dentro de la vela. Sólo cuenta si cierra al otro lado.`
          : `Nivel ${fmtPrice(side.level)} · faltan ${fmtNum(side.distancePct, 2)}% (${fmtNum(side.distanceAtr, 2)} ATR) · ${side.touches} ${side.touches === 1 ? 'toque' : 'toques'}${side.fallback ? ' (extremo del rango)' : ''}${
              side.remaining < 0.35 && Number.isFinite(side.probabilityFullCandle)
                ? `<br>Con una vela entera por delante sería ${fmtPct(side.probabilityFullCandle, 0)}.`
                : ''
            }`}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function applyControls() {
  const symbol = el.symbol.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BTCUSDT';
  el.symbol.value = symbol;

  const changed = symbol !== state.symbol || el.interval.value !== state.interval;
  state.symbol = symbol;
  state.interval = el.interval.value;

  if (changed) {
    state.candles = [];
    state.live = null;
    state.breakout = null;
    connectStream();
  }
  loadAll();
}

function init() {
  resizeCanvas();

  el.load.addEventListener('click', applyControls);
  el.interval.addEventListener('change', applyControls);
  el.symbol.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyControls();
  });

  for (const input of [el.emaFast, el.emaSlow]) {
    input.addEventListener('input', () => {
      render();
    });
  }

  el.canvas.addEventListener('mousemove', onCanvasMove);
  el.canvas.addEventListener('mouseleave', hideTooltip);

  // Debounce del resize: redibujar en cada píxel de arrastre no aporta nada.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCanvas, 120);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.refreshTimer);
      return;
    }
    // Al volver, los datos pueden ser de hace rato: se refresca ya.
    loadAll({ silent: true });
  });

  // El reloj de la vela corre aunque no lleguen ticks.
  setInterval(() => {
    if (!document.hidden && state.breakout && state.breakout.ok) renderBreakout();
  }, 1000);

  connectStream();
  loadAll();
}

document.addEventListener('DOMContentLoaded', init);
})();
