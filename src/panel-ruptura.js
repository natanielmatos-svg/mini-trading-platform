'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// El panel «¿Rompe esta vela?»: veredicto, las dos barras de probabilidad y
// los desplegables de por qué, contexto y cómo confirmar.
//
// Sale de app.js por el mismo motivo que el gráfico: la página de acciones
// enseña exactamente este panel, con la misma explicación y la misma cuenta,
// porque el análisis no sabe si las velas son de bitcoin o de Apple.
//
// Recibe el análisis y el precio; no lee estado de ninguna página.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const I = typeof module !== 'undefined' && module.exports ? require('./indicators') : globalThis.Indicators;
const { formatPrice, formatPercent, num } = F;
const { requiredExcursion, shareAtLeast } = I;

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// Reconstruir el panel es caro y pueden llegar diez precios por segundo; tres
// repintados por segundo ya se ven fluidos. El último repintado se guarda por
// contenedor y no en una variable suelta, para que dos paneles en la misma
// página no se roben el turno.
const THROTTLE_MS = 330;
const ultimo = new WeakMap();

/**
 * Recalcula la probabilidad de un lado con el precio del último tick.
 *
 * Usa exactamente las mismas dos funciones que el servidor
 * (`requiredExcursion` + `shareAtLeast`) sobre la muestra que vino en la
 * respuesta, así que el número que se ve en vivo es el que devolvería
 * /api/breakout si se le preguntara en este instante.
 */
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

// El panel se reconstruye entero en cada repintado, y eso cerraba de golpe el
// desplegable que el usuario acabara de abrir: con el precio en vivo llegando
// varias veces por segundo, «Contexto» era imposible de leer. Se apunta qué
// estaba abierto y se restaura.
function seccionesAbiertas(contenedor) {
  const previos = contenedor.querySelectorAll('details[data-k]');
  return {
    primera: previos.length === 0,
    claves: new Set([...previos].filter((d) => d.open).map((d) => d.dataset.k)),
  };
}

function restaurarSecciones(contenedor, { primera, claves }) {
  if (primera) return; // la primera vez mandan los `open` del marcado
  for (const d of contenedor.querySelectorAll('details[data-k]')) d.open = claves.has(d.dataset.k);
}

// El veredicto tiene que distinguir dos cosas que se parecen en el número y no
// en el significado: que no haya sesgo (las dos paredes igual de lejos) y que
// no dé tiempo (la vela cierra en un minuto y no llega a ninguna).
function verdictFor(up, down, remaining) {
  const pu = up && Number.isFinite(up.probability) ? up.probability : null;
  const pd = down && Number.isFinite(down.probability) ? down.probability : null;

  if (up && up.broken) return { text: `nivel ${formatPrice(up.level)} superado al alza`, cls: 'bull' };
  if (down && down.broken) return { text: `nivel ${formatPrice(down.level)} perdido a la baja`, cls: 'bear' };
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
        <strong>${side.broken ? 'superado' : formatPercent(probability, 0)}</strong>
      </header>
      <div class="bar"><span style="width:${width}%"></span></div>
      <div class="detail">
        ${side.broken
          ? `El precio ya ha pasado ${formatPrice(side.level)} dentro de la vela. Sólo cuenta si cierra al otro lado.`
          : `Nivel ${formatPrice(side.level)} · faltan ${num(side.distancePct, 2)}% (${num(side.distanceAtr, 2)} ATR) · ${side.touches} ${side.touches === 1 ? 'toque' : 'toques'}${side.fallback ? ' (extremo del rango)' : ''}${
              side.remaining < 0.35 && Number.isFinite(side.probabilityFullCandle)
                ? `<br>Con una vela entera por delante sería ${formatPercent(side.probabilityFullCandle, 0)}.`
                : ''
            }`}
      </div>
    </div>`;
}

/**
 * Pinta el panel.
 *
 * @param contenedor  el elemento donde va
 * @param opciones    { breakout, price, remaining, force, now }
 *   breakout   la respuesta de /api/breakout (o null mientras se calcula)
 *   price      el precio de ahora; si falta se usa el del análisis
 *   remaining  fracción de vela que queda, 0..1
 *   force      salta el límite de repintados (cambio de símbolo, por ejemplo)
 */
function render(contenedor, { breakout, price = null, remaining = 1, force = false, now = Date.now() } = {}) {
  const b = breakout;

  if (!force && b && b.ok && now - (ultimo.get(contenedor) || 0) < THROTTLE_MS) return false;
  ultimo.set(contenedor, now);

  if (!b || !b.ok) {
    contenedor.innerHTML = `<p class="muted">${b ? b.reason : 'Calculando…'}</p>`;
    return true;
  }

  const p = Number.isFinite(price) && price > 0 ? price : b.price;
  const r = clamp(remaining, 0.01, 1);

  const up = liveSide(b.up, b.sample.up, p, b.atr, r);
  const down = liveSide(b.down, b.sample.down, p, b.atr, r);

  const bias = verdictFor(up, down, r);
  const abiertas = seccionesAbiertas(contenedor);

  contenedor.innerHTML = `
    <div class="verdict ${bias.cls}">${bias.text}</div>
    ${sideHtml(up, 'Ruptura al alza', 'up')}
    ${sideHtml(down, 'Ruptura a la baja', 'down')}
    <details class="method" data-k="porque" open>
      <summary>Por qué</summary>
      ${b.explanation.map((line) => `<p>${line}</p>`).join('')}
    </details>
    <details class="method" data-k="contexto">
      <summary>Contexto (${b.context.length} señales)</summary>
      <ul class="factors">
        ${b.context.map((f) => `<li class="lean-${f.lean}"><strong>${f.label}:</strong> ${f.text}</li>`).join('')}
      </ul>
    </details>
    <details class="method" data-k="confirmar">
      <summary>Cómo confirmar la ruptura</summary>
      ${[b.trigger.up, b.trigger.down].filter(Boolean).map((t) => `<p>${t.text}<br><em>${t.invalidation}</em></p>`).join('')}
    </details>
    <p class="disclaimer">${b.disclaimer}</p>`;

  restaurarSecciones(contenedor, abiertas);
  return true;
}

const API = { render, liveSide, verdictFor, sideHtml, THROTTLE_MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Ruptura = API;
})();
