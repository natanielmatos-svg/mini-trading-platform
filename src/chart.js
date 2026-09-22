'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// El gráfico de velas: ejes, rejilla, volumen, EMAs, niveles y crosshair.
//
// Vivía dentro de app.js leyendo su estado global, y con una segunda página
// —acciones— habría que haberlo copiado entero. Doscientas cincuenta líneas
// de dibujo duplicadas son doscientas cincuenta líneas que se arreglan en un
// sitio y se quedan rotas en el otro. Aquí recibe lo que necesita y no sabe
// de dónde salen las velas.

// En Node se resuelven con require; en el navegador ya están en el ámbito
// global porque el HTML los carga antes que a este archivo.
const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const I = typeof module !== 'undefined' && module.exports ? require('./indicators') : globalThis.Indicators;
const { formatPrice } = F;
const { emaSeries } = I;

const PAD = { top: 14, right: 66, bottom: 26, left: 10 };
const VOLUME_RATIO = 0.18;

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

function fmtTimeAxis(ms, interval) {
  const d = new Date(ms);
  if (['1d', '3d', '1w', '1M'].includes(interval)) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function geometry(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const plotW = w - PAD.left - PAD.right;
  const volumeH = h * VOLUME_RATIO;
  const plotH = h - PAD.top - PAD.bottom - volumeH;
  return { w, h, plotW, plotH, volumeH, volumeTop: PAD.top + plotH + 6 };
}

// Sin devicePixelRatio el canvas se ve borroso en cualquier pantalla moderna.
function resize(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

/**
 * Dibuja el gráfico completo.
 *
 * @param canvas   el <canvas>
 * @param opciones { candles, interval, emaFast, emaSlow, levels, hover }
 *   levels: [{ price, color, tag, dense }] — resistencias, stop, objetivo…
 */
function draw(canvas, { candles = [], interval = '1h', emaFast = null, emaSlow = null, levels = [], hover = null } = {}) {
  const ctx = canvas.getContext('2d');
  const { w, h, plotW, plotH, volumeH, volumeTop } = geometry(canvas);
  if (w <= 0 || h <= 0) return;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);

  if (candles.length < 2) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Sin datos todavía…', PAD.left + 10, PAD.top + 20);
    return;
  }

  let maxPrice = Math.max(...candles.map((c) => c.high));
  let minPrice = Math.min(...candles.map((c) => c.low));

  // Los niveles entran en la escala: uno fuera de pantalla no sirve de nada,
  // pero tampoco se deja que uno lejanísimo aplaste las velas.
  for (const nivel of levels) {
    const p = nivel && nivel.price;
    if (Number.isFinite(p) && p < maxPrice * 1.08 && p > minPrice * 0.92) {
      maxPrice = Math.max(maxPrice, p);
      minPrice = Math.min(minPrice, p);
    }
  }

  const margin = (maxPrice - minPrice) * 0.06 || maxPrice * 0.01;
  maxPrice += margin;
  minPrice -= margin;
  const range = maxPrice - minPrice || 1;

  const xStep = plotW / candles.length;
  const xFor = (i) => PAD.left + i * xStep + xStep / 2;
  const yFor = (price) => PAD.top + plotH - ((price - minPrice) / range) * plotH;

  // Rejilla y eje de precios, a la derecha como en cualquier plataforma.
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
    ctx.fillText(formatPrice(price), PAD.left + plotW + 6, y);
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
    ctx.fillText(fmtTimeAxis(candles[i].openTime, interval), x, h - PAD.bottom + 6);
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
    const color = c.close >= c.open ? '#22c55e' : '#ef4444';

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
  if (emaFast && emaSlow) {
    serie(ctx, emaSeries(closes, emaFast), '#38bdf8', xFor, yFor);
    serie(ctx, emaSeries(closes, emaSlow), '#f97316', xFor, yFor);
  }

  for (const nivel of levels) {
    if (nivel) linea(ctx, nivel.price, nivel.color, nivel.tag, yFor, plotW, nivel.dense);
  }

  const last = candles[candles.length - 1];
  etiquetaPrecio(ctx, last.close, last.close >= last.open ? '#22c55e' : '#ef4444', plotW, yFor);

  if (hover !== null && candles[hover]) {
    const x = xFor(hover);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    ctx.restore();
  }
}

function serie(ctx, valores, color, xFor, yFor) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  let empezado = false;
  for (let i = 0; i < valores.length; i++) {
    if (!Number.isFinite(valores[i])) continue;
    const x = xFor(i);
    const y = yFor(valores[i]);
    if (!empezado) {
      ctx.moveTo(x, y);
      empezado = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function linea(ctx, price, color, tag, yFor, plotW, dense = false) {
  if (!Number.isFinite(price)) return;
  const y = yFor(price);
  ctx.save();
  ctx.setLineDash(dense ? [2, 4] : [5, 4]);
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
  ctx.fillText(`${tag} ${formatPrice(price)}`, PAD.left + 4, y - 2);
}

function etiquetaPrecio(ctx, price, color, plotW, yFor) {
  const y = yFor(price);
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(PAD.left, y);
  ctx.lineTo(PAD.left + plotW, y);
  ctx.stroke();
  ctx.restore();

  const texto = formatPrice(price);
  ctx.font = 'bold 11px system-ui, sans-serif';
  const ancho = ctx.measureText(texto).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(PAD.left + plotW + 2, y - 8, ancho, 16);
  ctx.fillStyle = '#020617';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(texto, PAD.left + plotW + 7, y);
}

// Qué vela hay bajo el cursor, o null si está fuera.
function indexAt(canvas, clientX, candles) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const { plotW } = geometry(canvas);
  const xStep = plotW / Math.max(candles.length, 1);
  const i = Math.floor((x - PAD.left) / xStep);
  return i >= 0 && i < candles.length ? i : null;
}

const API = { draw, resize, geometry, niceStep, indexAt, fmtTimeAxis, PAD, clamp };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Chart = API;
})();
