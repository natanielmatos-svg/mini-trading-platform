'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// La tabla de tendencia multi-timeframe: EMA rápida contra lenta en cada
// marco temporal. Treinta líneas que serían idénticas en la página de
// acciones, y la banda neutra del 0,05% es justo el tipo de umbral que se
// ajusta en un sitio y se queda viejo en el otro.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const I = typeof module !== 'undefined' && module.exports ? require('./indicators') : globalThis.Indicators;
const { formatPrice, formatPercent } = F;
const { ema } = I;

// Una diferencia del 0,05% entre EMAs no es una tendencia, es ruido. Sin esta
// banda cualquier diferencia pintaba la celda entera de verde o de rojo.
const BANDA_NEUTRA = 0.0005;

function veredicto(closes, fast, slow) {
  const f = fast ? ema(closes, fast) : null;
  const s = slow ? ema(closes, slow) : null;
  if (!Number.isFinite(f) || !Number.isFinite(s)) return null;

  const gap = (f - s) / s;
  const label = gap > BANDA_NEUTRA ? 'Alcista' : gap < -BANDA_NEUTRA ? 'Bajista' : 'Plano';
  return { f, s, gap, label, cls: label === 'Alcista' ? 'bull' : label === 'Bajista' ? 'bear' : 'flat' };
}

/**
 * Pinta la tabla.
 *
 * @param opciones { mtf, fast, slow, timeframes, celda }
 *   mtf         { '1h': [velas], … }
 *   celda       (tf) => el elemento de esa columna
 */
function render({ mtf = {}, fast, slow, timeframes = ['1h', '4h', '1d', '1w'], celda }) {
  for (const tf of timeframes) {
    const cell = celda(tf);
    if (!cell) continue;

    const candles = mtf[tf];
    const v = veredicto(candles ? candles.map((c) => c.close) : [], fast, slow);

    cell.classList.remove('bull', 'bear', 'flat');

    if (!v) {
      cell.textContent = '—';
      cell.classList.add('flat');
      cell.title = 'Sin datos suficientes o parámetros de EMA inválidos';
      continue;
    }

    cell.textContent = v.label;
    cell.classList.add(v.cls);
    cell.title = `EMA${fast} ${formatPrice(v.f)} vs EMA${slow} ${formatPrice(v.s)} (${v.gap >= 0 ? '+' : ''}${formatPercent(v.gap, 2)})`;
  }
}

const API = { render, veredicto, BANDA_NEUTRA };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.TablaMtf = API;
})();
