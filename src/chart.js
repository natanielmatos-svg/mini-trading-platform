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

// Qué parte del ancho se reserva a la derecha para la proyección, cuando la
// hay. Sin proyección el gráfico ocupa todo, exactamente igual que antes.
const PROY_RATIO = 0.22;

// Cuánto puede estirar la escala el abanico, sobre el rango de las velas.
//
// Tiene margen propio, y muy estrecho, porque su naturaleza es la contraria a
// la de un nivel: la banda del 90% a un día llega un 5% más arriba que
// cualquier vela, y dejarla mandar aplastaba el histórico hasta que la rejilla
// saltaba de 2.000 a 5.000 y se quedaba una sola línea. Lo que se sale se
// recorta contra el borde, que además es la lectura correcta: ese horizonte
// llega más lejos de lo que cabe en pantalla.
const PROY_MARGEN = 0.04;

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
 *   proyeccion: { horizontes: [{ bloques, bandas }], etiqueta } — el abanico.
 *     Se dibuja a la derecha de la última vela, en espacio reservado: hacia
 *     donde PUEDE ir el precio, no hacia dónde va. La banda central es el
 *     precio actual a propósito.
 */
function draw(canvas, { candles = [], interval = '1h', emaFast = null, emaSlow = null, levels = [], hover = null, proyeccion = null } = {}) {
  const ctx = canvas.getContext('2d');
  const { w, h, plotW: plotTotal, plotH, volumeH, volumeTop } = geometry(canvas);
  if (w <= 0 || h <= 0) return;

  const hayProy = Boolean(proyeccion && Array.isArray(proyeccion.horizontes) && proyeccion.horizontes.length);
  const plotW = hayProy ? plotTotal * (1 - PROY_RATIO) : plotTotal;
  const proyW = plotTotal - plotW;

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

  // El cono entra en la escala: una banda que se sale por arriba no se ve, y
  // es justo la que dice cuánto puede subir esto.
  // Con el mismo margen que los niveles, y por el mismo motivo al revés: la
  // banda de un día llega mucho más lejos que el rango de las velas, y dejarla
  // estirar la escala aplastaba el histórico hasta dejar una sola línea de
  // rejilla. Los horizontes que no caben se dibujan igual y se recortan
  // contra el borde, que es la lectura correcta: se salen de lo que se ve.
  if (hayProy) {
    // El límite se fija ANTES del bucle. Calcularlo dentro lo convertía en una
    // cascada: cada banda admitida subía el techo para la siguiente, así que
    // un margen del 4% acababa dejando pasar el 9% y la escala se estiraba
    // igual. La rejilla saltaba a un paso de 5.000 y quedaba una sola línea.
    const techo = maxPrice * (1 + PROY_MARGEN);
    const suelo = minPrice * (1 - PROY_MARGEN);

    for (const h of proyeccion.horizontes) {
      for (const b of h.bandas || []) {
        if (!Number.isFinite(b.price)) continue;
        if (b.price < techo) maxPrice = Math.max(maxPrice, b.price);
        if (b.price > suelo) minPrice = Math.min(minPrice, b.price);
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
    ctx.lineTo(PAD.left + plotTotal, y);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText(formatPrice(price), PAD.left + plotTotal + 6, y);
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

  if (hayProy) {
    // Recortado al área de dibujo: sin esto, un horizonte que se sale pinta
    // sobre el eje de precios y sobre el bloque de volumen.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotTotal, plotH);
    ctx.clip();
    abanico(ctx, proyeccion, PAD.left + plotW, proyW, yFor, plotH);
    ctx.restore();
  }

  const last = candles[candles.length - 1];
  etiquetaPrecio(ctx, last.close, last.close >= last.open ? '#22c55e' : '#ef4444', plotTotal, yFor);

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

// El abanico de predicción: todos los horizontes a la vez.
//
// Al principio dibujaba un solo horizonte interpolando por raíz del tiempo, y
// salía un hilo de dos píxeles: la incertidumbre de UNA vela es minúscula al
// lado de trescientas de histórico. Y eso es verdad, así que la respuesta no
// era exagerarla sino enseñar el abanico entero, donde cada horizonte pone su
// punto y la forma sale de los números calculados, no de una curva supuesta.
//
// Se lee de un vistazo: cuanto más a la derecha, más lejos en el tiempo y más
// ancho el rango. La parte oscura es el 50% de las veces; la clara, el 90%.
function abanico(ctx, { horizontes, etiqueta }, x0, ancho, yFor, plotH) {
  const utiles = (horizontes || []).filter((h) => h && Array.isArray(h.bandas) && h.bandas.length);
  if (!utiles.length) return;

  const maxBloques = Math.max(...utiles.map((h) => h.bloques));
  if (!(maxBloques > 0)) return;

  const precioDe = (h, q) => {
    const b = h.bandas.find((x) => Math.abs(x.q - q) < 1e-9);
    return b ? b.price : null;
  };

  const p50 = precioDe(utiles[0], 0.5);
  if (!Number.isFinite(p50)) return;

  // Del más cercano al más lejano, que es como se recorre el eje.
  const orden = [...utiles].sort((a, b) => a.bloques - b.bloques);
  const xDe = (h) => x0 + (ancho * h.bloques) / maxBloques;

  for (const [qLo, qHi, color] of [[0.05, 0.95, 'rgba(56,189,248,0.10)'], [0.25, 0.75, 'rgba(56,189,248,0.22)']]) {
    const arriba = [];
    const abajo = [];
    for (const h of orden) {
      const hi = precioDe(h, qHi);
      const lo = precioDe(h, qLo);
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
      arriba.push([xDe(h), yFor(hi)]);
      abajo.push([xDe(h), yFor(lo)]);
    }
    if (arriba.length < 2) continue;

    ctx.beginPath();
    // Arranca en el precio de ahora: a tiempo cero no hay incertidumbre.
    ctx.moveTo(x0, yFor(p50));
    for (const [x, y] of arriba) ctx.lineTo(x, y);
    for (let i = abajo.length - 1; i >= 0; i--) ctx.lineTo(abajo[i][0], abajo[i][1]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // La línea central, discontinua: recuerda que no es una predicción de
  // dirección sino el precio de ahora prolongado.
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(148,163,184,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, yFor(p50));
  ctx.lineTo(x0 + ancho, yFor(p50));
  ctx.stroke();

  // Separador entre lo que pasó y lo que puede pasar.
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = 'rgba(148,163,184,0.45)';
  ctx.beginPath();
  ctx.moveTo(x0, PAD.top);
  ctx.lineTo(x0, PAD.top + plotH);
  ctx.stroke();
  ctx.restore();

  if (etiqueta) {
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    // Anclada a la derecha: centrada se salía del área y se cortaba a media
    // palabra, que es peor que no ponerla.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(etiqueta, x0 + ancho - 2, PAD.top + 2);
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
//
// `conProyeccion` no es opcional por capricho: con el cono dibujado, las velas
// ocupan menos ancho, y sin decírselo el tooltip señalaría una vela y
// resaltaría otra. Es el tipo de desajuste que nadie reporta y todo el mundo
// nota.
function indexAt(canvas, clientX, candles, { conProyeccion = false } = {}) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const { plotW } = geometry(canvas);
  const ancho = conProyeccion ? plotW * (1 - PROY_RATIO) : plotW;
  const xStep = ancho / Math.max(candles.length, 1);
  const i = Math.floor((x - PAD.left) / xStep);
  return i >= 0 && i < candles.length ? i : null;
}

const API = { draw, resize, geometry, niceStep, indexAt, fmtTimeAxis, PAD, clamp, PROY_RATIO };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Chart = API;
})();
