'use strict';

(function () {

// «¿Qué probabilidad hay de que acabe por encima de 88.000?»
//
// Es la pregunta que de verdad se hace quien mira una pantalla de precios, y
// hasta ahora la aplicación no la respondía: enseñaba la banda donde caerá el
// precio el 90% de las veces, que es la misma información del revés pero
// obliga a hacer la conversión en la cabeza.
//
// TRES DECISIONES QUE MANDAN SOBRE EL RESTO:
//
// 1. **La cuenta la hace el navegador, no el servidor.** El precio llega diez
//    veces por segundo. Preguntar al servidor a ese ritmo sería absurdo, y
//    responder con el precio de hace un minuto sería mentira: la probabilidad
//    de pasar de 88.000 con bitcoin en 87.900 no es la misma que con bitcoin
//    en 87.400. El servidor manda la DISTRIBUCIÓN empaquetada —128 puntos por
//    horizonte— y aquí se resuelve cualquier nivel en microsegundos.
//
// 2. **Es frecuencia observada, no una fórmula.** No hay ninguna campana de
//    Gauss en esta cuenta. El número sale de contar, entre los cientos de
//    movimientos que el modelo ya vivió a ese plazo, cuántos se pasaron del
//    umbral. Por eso las colas gordas del cripto están dentro por
//    construcción, en vez de aparecer como sorpresas.
//
// 3. **Sale de la misma distribución que las bandas.** Si la banda del 90%
//    acaba en 88.000 y esto dijera «12% de acabar por encima de 88.000», dos
//    filas de la misma tarjeta se contradirían y no habría forma de saber cuál
//    creer. Están atadas en `forecast.js`, y hay un test que lo vigila.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const Fc = typeof module !== 'undefined' && module.exports ? require('./forecast') : globalThis.Forecast;
const { formatPrice, formatClock, num, priceDecimals } = F;

/**
 * El número que se escribe en el campo.
 *
 * `precioActual()` devuelve 60329.96188666096 y meter eso en la casilla es
 * ilegible y, peor, sugiere una precisión que el precio no tiene. Se redondea
 * a los decimales que usa el resto de la pantalla. Va con punto y no con coma
 * porque un `<input type="number">` no acepta la coma como separador decimal,
 * por mucho que en español se escriba así.
 */
function redondearNivel(valor) {
  const n = Number(valor);
  if (!(n > 0)) return null;
  return Number(n.toFixed(priceDecimals(n)));
}

const MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3,
  '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
};

const cuantoFalta = (h, paso) => (Number.isFinite(h.ms) ? h.ms : h.bloques * paso);

/**
 * La probabilidad de acabar por encima del nivel, para un horizonte.
 *
 * El precio que entra aquí es el CRUDO, tick a tick, no el calmado del
 * titular. El titular se frena porque el ojo no lee 10 números por segundo;
 * una probabilidad calculada con un precio de hace tres segundos sería
 * simplemente otro número, y estaría mal.
 */
function evaluar(h, precio, nivel) {
  if (!h || !h.ok || !h.rejilla) return null;
  return Fc.probabilidadEncima({ precio, nivel, sigmaHorizonte: h.sigmaHorizonte, rejilla: h.rejilla });
}

/**
 * Cómo se escribe una probabilidad sin fingir precisión que no hay.
 *
 * Con 250 movimientos medidos, la frecuencia observada tiene un grano del
 * 0,4%: escribir «61,7%» serían dos dígitos inventados. Así que por encima del
 * 10% se redondea al entero, y por debajo —donde un punto porcentual sí cambia
 * la decisión— se da un decimal.
 *
 * Y fuera de lo que la muestra vio no se escribe «0%». Eso sería confundir «no
 * lo he visto» con «no pasa», que es la clase de afirmación que arruina a
 * alguien. Se escribe «< 0,4%», que es lo que de verdad se puede decir.
 */
function formatProb(r) {
  if (!r) return '—';
  const pct = r.p * 100;
  const grano = Math.max(r.grano * 100, 0.1);

  if (r.fuera === 'arriba') return `< ${num(grano, 1)}%`;
  if (r.fuera === 'abajo') return `> ${num(100 - grano, 1)}%`;
  if (pct < 1) return '< 1%';
  if (pct < 10) return `${num(pct, 1)}%`;
  return `${Math.round(pct)}%`;
}

// Un color por tramo, y sólo tres: verde cuando lo más probable es que sí,
// rojo cuando lo más probable es que no, gris en el medio, que es donde está
// casi siempre y donde una moneda al aire decide igual de bien.
function clase(p) {
  if (!Number.isFinite(p)) return 'flat';
  if (p >= 0.6) return 'bull';
  if (p <= 0.4) return 'bear';
  return 'flat';
}

// Cuotas justas: a qué precio la apuesta no tiene ventaja para nadie. Va en el
// title porque no todo el mundo piensa en cuotas, y quien lo hace lo busca.
function cuotas(p) {
  if (!(p > 0) || !(p < 1)) return '';
  return `cuotas justas ${num(1 / p, 2)} a favor y ${num(1 / (1 - p), 2)} en contra · ` +
         `${Math.round(p * 100)}¢ en un contrato binario que paga 1 $`;
}

function utiles(datos) {
  if (!datos || !Array.isArray(datos.horizontes)) return [];
  return datos.horizontes.filter((h) => h.ok && h.rejilla);
}

/**
 * Pinta la tabla entera. Se llama cuando cambian los datos o el nivel, no en
 * cada tick: en cada tick va `actualizar`, que sólo reescribe los números.
 */
function render(contenedor, { datos, interval, nivel, precio, nota = null }) {
  if (!contenedor) return;

  if (!(nivel > 0)) {
    contenedor.innerHTML = '<p class="muted">Escribe un precio y aparece la probabilidad de acabar por encima y por debajo, a cada plazo.</p>';
    return;
  }

  const filas = utiles(datos);
  if (!filas.length) {
    const motivo = datos && datos.error ? datos.error
      : datos && Array.isArray(datos.horizontes) && datos.horizontes.length ? datos.horizontes[0].reason
      : 'Calculando…';
    contenedor.innerHTML = `<p class="muted">${motivo}</p>`;
    return;
  }
  if (!(precio > 0)) {
    contenedor.innerHTML = '<p class="muted">Esperando el precio en vivo…</p>';
    return;
  }

  const paso = MS[interval] || 3600e3;
  const anclaje = Number.isFinite(datos.recibido) ? datos.recibido : Date.now();
  const distancia = nivel / precio - 1;

  // Con la bolsa cerrada los plazos siguen contando del reloj de pared, pero
  // el precio no se mueve hasta la apertura. Decirlo es la diferencia entre un
  // número y un número engañoso: «4% de pasar de 366,40 en cinco minutos» a las
  // diez de la noche es la probabilidad de un movimiento que no puede ocurrir.
  const aviso = nota ? `<p class="prob-aviso">${nota}</p>` : '';

  const cuerpo = filas.map((h, i) => {
    const r = evaluar(h, precio, nivel);
    const p = r ? r.p : null;
    return `
      <tr data-prob-fila="${i}">
        <td class="pred-cuando" data-vence="${anclaje + cuantoFalta(h, paso)}">${formatClock(cuantoFalta(h, paso))}${h.desde && h.desde !== interval ? ` <span class="pred-desde">de ${h.desde}</span>` : ''}</td>
        <td class="prob-encima ${clase(p)}" title="${cuotas(p)}">${formatProb(r)}</td>
        <td class="prob-debajo ${clase(1 - p)}">${formatProb(inverso(r))}</td>
      </tr>`;
  }).join('');

  contenedor.innerHTML = `
    ${aviso}
    <p class="prob-nivel">
      <strong>${formatPrice(nivel)}</strong> está
      <span class="${distancia >= 0 ? 'bull' : 'bear'}">${distancia >= 0 ? '+' : ''}${num(distancia * 100, 2)}%</span>
      del precio de ahora (${formatPrice(precio)}).
    </p>
    <table class="pred-tabla prob-tabla">
      <thead><tr><th>vence en</th><th>por encima</th><th>por debajo</th></tr></thead>
      <tbody>${cuerpo}</tbody>
    </table>
    <details class="method" data-k="prob-como">
      <summary>De dónde sale este número</summary>
      <p>
        De <strong>contar</strong>, no de una fórmula. El motor guarda los cientos de movimientos que
        ya midió a cada plazo, en unidades de su propia volatilidad; para responder por
        ${formatPrice(nivel)} mira a qué distancia está en esas unidades y cuenta cuántos de aquellos
        movimientos se pasaron de ahí. No hay ninguna campana de Gauss en esta cuenta, y por eso las
        colas gordas del cripto están dentro en vez de ser sorpresas.
      </p>
      <p>
        Es la misma distribución que dibuja las bandas de la tarjeta de predicción, y en el instante en
        que se calculan concuerdan exactamente: si la banda del 90% acaba en un precio, la probabilidad
        de acabar por encima de ese precio es del 5%. <strong>Después dejan de concordar, y es lo
        correcto</strong>: esta tarjeta se recalcula con cada tick del precio y las bandas se quedan
        donde estaban hasta el siguiente refresco. Cada una dice sobre qué precio está centrada.
      </p>
      <p>
        <strong>Es la probabilidad de ACABAR por encima, no de tocarlo.</strong> Un precio se puede
        tocar y volver: para un objetivo o un stop, que salta al tocarse, este número se queda corto.
        Y se redondea al entero por encima del 10% porque con la muestra que hay el siguiente dígito
        sería inventado.
      </p>
      <p class="muted">Cada plazo se mide con ${filas[0].rejilla.muestra} movimientos o más, según el horizonte.</p>
    </details>
    <p class="disclaimer">Frecuencia observada sobre datos públicos. No es una recomendación de inversión.</p>`;
}

// P(por debajo) = 1 − P(por encima), y el aviso de estar fuera de la muestra
// se da la vuelta con ella.
function inverso(r) {
  if (!r) return null;
  return { ...r, p: 1 - r.p, fuera: r.fuera === 'arriba' ? 'abajo' : r.fuera === 'abajo' ? 'arriba' : null };
}

/**
 * Pone los números al día sin repintar la tabla.
 *
 * Esto corre con cada tick, así que no puede reconstruir nada: repintar
 * cerraría el desplegable de «de dónde sale este número» en cuanto alguien lo
 * abriera, y además el campo del precio perdería el foco mientras se escribe.
 * Se reescribe sólo el texto de las celdas que cambian.
 */
function actualizar(contenedor, { datos, nivel, precio }) {
  if (!contenedor || !(nivel > 0) || !(precio > 0)) return false;

  const filas = utiles(datos);
  const celdas = contenedor.querySelectorAll('[data-prob-fila]');
  // Si no cuadran, los datos cambiaron y toca repintar de verdad.
  if (!celdas.length || celdas.length !== filas.length) return false;

  for (const fila of celdas) {
    const h = filas[Number(fila.dataset.probFila)];
    const r = evaluar(h, precio, nivel);
    escribir(fila.querySelector('.prob-encima'), r, cuotas(r ? r.p : null));
    escribir(fila.querySelector('.prob-debajo'), inverso(r), '');
  }
  return true;
}

function escribir(celda, r, titulo) {
  if (!celda) return;
  const texto = formatProb(r);
  // Sólo se toca el DOM si el número cambió. A diez ticks por segundo, escribir
  // el mismo "62%" seiscientas veces por minuto es trabajo tirado, y además
  // impediría seleccionar el número con el ratón.
  if (celda.textContent !== texto) celda.textContent = texto;

  const nueva = clase(r ? r.p : null);
  if (!celda.classList.contains(nueva)) {
    celda.classList.remove('bull', 'bear', 'flat');
    celda.classList.add(nueva);
  }
  if (titulo !== '' && celda.title !== titulo) celda.title = titulo;
}

/**
 * La línea de una sola frase, para tenerla a la vista sin bajar la página.
 * Coge el plazo más corto, que es el mejor calibrado.
 */
function renderLinea(contenedor, { datos, nivel, precio, interval }) {
  if (!contenedor) return;
  if (!(nivel > 0) || !(precio > 0)) {
    contenedor.innerHTML = '';
    return;
  }

  const filas = utiles(datos);
  if (!filas.length) {
    contenedor.innerHTML = '';
    return;
  }

  const h = filas[0];
  const r = evaluar(h, precio, nivel);
  if (!r) {
    contenedor.innerHTML = '';
    return;
  }

  const cuando = formatClock(cuantoFalta(h, MS[interval] || 3600e3));
  contenedor.innerHTML =
    `en ${cuando}: <span class="nota ${clase(r.p)}">${formatProb(r)}</span> por encima de ` +
    `<strong>${formatPrice(nivel)}</strong>`;
}

const API = { render, renderLinea, actualizar, evaluar, redondearNivel, formatProb, clase, cuotas, inverso, cuantoFalta, MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.PanelProbabilidad = API;
})();
