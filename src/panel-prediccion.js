'use strict';

(function () {

// El panel de predicción: las bandas por horizonte, y su boletín de notas.
//
// La decisión de diseño que manda sobre todas: aquí NO hay un precio grande en
// el centro. Enseñar "86.412" con aire de seguridad sería la mentira que todo
// el motor evita. Lo que se ve es un rango, y al lado, si ese rango se cumple
// de verdad sobre el histórico. Un número sin su calibración es una opinión
// con tipografía bonita.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const { formatPrice, num, formatDuration } = F;

// Cuánto dura un bloque, para poder decir "dentro de 4 horas" y no "4 bloques".
const MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3,
  '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
};

// Qué fiabilidad tiene un horizonte, a partir de su calibración medida.
function nota(cal) {
  if (!cal || !cal.ok) return { clase: 'flat', texto: 'sin medir', detalle: cal ? cal.reason : '' };

  const c90 = cal.cobertura.find((c) => c.nominal === 0.9);
  if (!c90) return { clase: 'flat', texto: 'sin medir', detalle: '' };

  const error = Math.abs(c90.observada - 0.9);
  const clase = error < 0.03 ? 'bull' : error < 0.07 ? 'flat' : 'bear';
  return {
    clase,
    texto: `${(c90.observada * 100).toFixed(0)}% de 90%`,
    detalle: cal.veredicto || '',
  };
}

/**
 * Pinta el panel.
 *
 * @param contenedor  dónde
 * @param datos       la respuesta de /api/forecast
 * @param interval    para traducir bloques a tiempo
 */
function render(contenedor, datos, interval) {
  if (!datos || !Array.isArray(datos.horizontes) || !datos.horizontes.length) {
    contenedor.innerHTML = `<p class="muted">${datos && datos.error ? datos.error : 'Calculando…'}</p>`;
    return;
  }

  const paso = MS[interval] || 3600e3;
  const utiles = datos.horizontes.filter((h) => h.ok);

  if (!utiles.length) {
    const motivo = datos.horizontes[0] && datos.horizontes[0].reason;
    contenedor.innerHTML = `<p class="muted">${motivo || 'Sin historia suficiente para predecir.'}</p>`;
    return;
  }

  const filas = utiles.map((h) => {
    const n = nota(h.calibracion);
    const lo = h.bandas.find((b) => b.q === 0.05);
    const hi = h.bandas.find((b) => b.q === 0.95);
    const lo50 = h.bandas.find((b) => b.q === 0.25);
    const hi50 = h.bandas.find((b) => b.q === 0.75);

    return `
      <tr>
        <td class="pred-cuando">${formatDuration(h.bloques * paso)}</td>
        <td class="pred-banda">${formatPrice(lo50.price)} – ${formatPrice(hi50.price)}</td>
        <td class="pred-banda ancha">${formatPrice(lo.price)} – ${formatPrice(hi.price)}</td>
        <td class="pred-nota ${n.clase}" title="${n.detalle.replace(/"/g, '&quot;')}">${n.texto}</td>
      </tr>`;
  }).join('');

  contenedor.innerHTML = `
    <p class="pred-centro">
      Centrado en <strong>${formatPrice(datos.precio)}</strong>, el precio de ahora.
      <em>No se predice dirección.</em>
    </p>
    <table class="pred-tabla">
      <thead>
        <tr><th>dentro de</th><th>50% de las veces</th><th>90% de las veces</th><th>acierto</th></tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    <details class="method" data-k="pred-como">
      <summary>Cómo se calcula, y qué NO es</summary>
      <p>${datos.aviso || ''}</p>
      <p>
        La volatilidad se estima con una media exponencial que pesa más lo reciente, porque la
        volatilidad se agrupa: tras un tramo movido viene otro movido. Las colas salen de la
        distribución <strong>observada</strong> de los rendimientos, no de una campana de Gauss —los
        movimientos de seis sigmas existen y pasan a menudo—. Y la anchura se corrige con los
        errores que el propio modelo cometió en el pasado, prediciendo hacia delante sobre el
        histórico.
      </p>
      <p>
        La columna <strong>acierto</strong> es lo que hace esto comprobable: dice qué porcentaje de
        las veces, sobre el histórico, el precio acabó dentro de la banda que se anunciaba como del
        90%. Si pone «84% de 90%», a ese plazo las bandas se quedan cortas y hay que fiarse menos.
      </p>
    </details>
    <p class="disclaimer">Distribución estimada sobre datos públicos. No es una recomendación de inversión.</p>`;
}

const API = { render, nota, MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.PanelPrediccion = API;
})();
