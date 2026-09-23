'use strict';

(function () {

// «¿Qué probabilidad hay de que acabe por encima de 88.000?»
//
// Es la pregunta que de verdad se hace quien mira una pantalla de precios, y
// hasta hace poco la aplicación no la respondía: enseñaba la banda donde caerá
// el precio el 90% de las veces, que es la misma información del revés pero
// obliga a hacer la conversión en la cabeza.
//
// CUATRO DECISIONES QUE MANDAN SOBRE EL RESTO:
//
// 1. **Lo primero que se lee es el cierre de la vela que se está mirando.**
//    Quien tiene el gráfico en 15m está mirando una vela de 15 minutos y lo
//    que quiere saber es si ESA vela cerrará por encima de su precio. El resto
//    de plazos siguen debajo, pero la cifra grande va sincronizada con el
//    bloque de tiempo elegido arriba, y su cuenta atrás es la misma que la del
//    reloj.
//
// 2. **La cuenta la hace el navegador, no el servidor.** El precio llega diez
//    veces por segundo. Preguntar al servidor a ese ritmo sería absurdo, y
//    responder con el precio de hace un minuto sería mentira: la probabilidad
//    de pasar de 88.000 con bitcoin en 87.900 no es la misma que con bitcoin
//    en 87.400. El servidor manda la DISTRIBUCIÓN empaquetada —128 puntos por
//    horizonte— y aquí se resuelve cualquier nivel en microsegundos.
//
// 3. **Es frecuencia observada, no una fórmula.** No hay ninguna campana de
//    Gauss en esta cuenta. El número sale de contar, entre los cientos de
//    movimientos que el modelo ya vivió a ese plazo, cuántos se pasaron del
//    umbral. Por eso las colas gordas del cripto están dentro por
//    construcción, en vez de aparecer como sorpresas.
//
// 4. **Sale de la misma distribución que las bandas.** Si la banda del 90%
//    acaba en 88.000 y esto dijera «12% de acabar por encima de 88.000», dos
//    tarjetas de la misma pantalla se contradirían y no habría forma de saber
//    cuál creer. Están atadas en `forecast.js`, y hay tests que lo vigilan.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const Fc = typeof module !== 'undefined' && module.exports ? require('./forecast') : globalThis.Forecast;
const { formatPrice, formatClock, num, priceDecimals } = F;

const MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3,
  '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
};

const cuantoFalta = (h, paso) => (Number.isFinite(h.ms) ? h.ms : h.bloques * paso);

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

function utiles(datos) {
  if (!datos || !Array.isArray(datos.horizontes)) return [];
  return datos.horizontes.filter((h) => h.ok && h.rejilla);
}

// El horizonte que no viene en la lista: lo que le queda a la vela en curso.
//
// La cuenta vive en `forecast.js`, que es donde está el motor, porque el bot de
// Kalshi hace exactamente lo mismo con el vencimiento de un contrato. Una sola
// implementación para las dos, o acabarían discrepando.
//
// Lo que se ve en pantalla es la consecuencia, y es la correcta: según se
// acerca el cierre la incertidumbre se encoge y la probabilidad se va hacia el
// 0 o el 100. A doce segundos del cierre el precio ya casi no tiene tiempo de
// cambiar de lado.
function alCierre(datos, restanteMs) {
  return Fc.distribucionEn(datos && datos.horizontes, restanteMs);
}

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

// P(por debajo) = 1 − P(por encima), y el aviso de estar fuera de la muestra
// se da la vuelta con ella.
function inverso(r) {
  if (!r) return null;
  return { ...r, p: 1 - r.p, fuera: r.fuera === 'arriba' ? 'abajo' : r.fuera === 'abajo' ? 'arriba' : null };
}

function vacio(contenedor, mensaje) {
  contenedor.innerHTML = `<p class="muted">${mensaje}</p>`;
}

/**
 * Pinta el panel entero. Se llama cuando cambian los datos o el nivel; en cada
 * tick va `actualizar`, que sólo reescribe los números.
 *
 * @param vela  { cierraEn } de la vela en curso del bloque elegido arriba, en
 *              milisegundos absolutos. Sin ella no hay cifra grande.
 */
function render(contenedor, { datos, interval, nivel, precio, nota = null, vela = null }) {
  if (!contenedor) return;

  if (!(nivel > 0)) {
    return vacio(contenedor, 'Escribe un precio y aparece la probabilidad de acabar por encima y por debajo: al cierre de la vela que estás mirando, y a cada plazo.');
  }

  const filas = utiles(datos);
  if (!filas.length) {
    return vacio(contenedor, datos && datos.error ? datos.error
      : datos && Array.isArray(datos.horizontes) && datos.horizontes.length ? datos.horizontes[0].reason
      : 'Calculando…');
  }
  if (!(precio > 0)) return vacio(contenedor, 'Esperando el precio en vivo…');

  const paso = MS[interval] || 3600e3;
  const anclaje = Number.isFinite(datos.recibido) ? datos.recibido : Date.now();

  const tiles = filas.map((h, i) => {
    const r = evaluar(h, precio, nivel);
    return `
      <div class="prob-tile" data-prob-fila="${i}" title="${cuotas(r ? r.p : null)}">
        <span class="prob-tile-plazo pred-cuando" data-vence="${anclaje + cuantoFalta(h, paso)}">${formatClock(cuantoFalta(h, paso))}</span>
        <span class="prob-encima ${clase(r ? r.p : null)}">${formatProb(r)}</span>
        <span class="prob-debajo">${formatProb(inverso(r))} abajo</span>
      </div>`;
  }).join('');

  contenedor.innerHTML = `
    ${nota ? `<p class="prob-aviso">${nota}</p>` : ''}
    ${bloqueCierre({ datos, interval, nivel, precio, vela })}
    <p class="prob-nivel">${distancia(nivel, precio)}</p>
    <p class="prob-otros">y a plazo fijo, contando desde ahora:</p>
    <div class="prob-plazos">${tiles}</div>
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
        La cifra grande va al <strong>cierre de la vela que estás mirando</strong>, así que cambia con
        el bloque de tiempo de arriba: en 15m pregunta por los minutos que le quedan a esa vela de 15
        minutos. Como el plazo se encoge con el reloj, la probabilidad se va acercando al 0 o al 100
        según llega el cierre, que es lo que de verdad pasa. La anchura se recalcula exacta para el
        tiempo que queda; la forma de las colas se toma del plazo medido más cercano.
      </p>
      <p>
        Es la misma distribución que dibuja las bandas de la tarjeta de predicción, y en el instante en
        que se calculan concuerdan exactamente: si la banda del 90% acaba en un precio, la probabilidad
        de acabar por encima de ese precio es del 5%. <strong>Después dejan de concordar, y es lo
        correcto</strong>: esto se recalcula con cada tick del precio y las bandas se quedan donde
        estaban hasta el siguiente refresco. Cada una dice sobre qué precio está centrada.
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

/**
 * A qué distancia está el nivel del precio de ahora.
 *
 * El caso raro manda: con el nivel puesto por el botón «ahora», el redondeo lo
 * deja a una millonésima del precio y la resta daba «-0%», que además salía en
 * rojo. Por debajo de una centésima de punto porcentual no hay distancia que
 * contar y se dice con palabras.
 */
function distancia(nivel, precio) {
  const dist = nivel / precio - 1;
  const centesimas = Math.round(dist * 10000);

  if (centesimas === 0) {
    return `<strong>${formatPrice(nivel)}</strong> es el precio de ahora: una moneda al aire.`;
  }
  return `<strong>${formatPrice(nivel)}</strong> está ` +
    `<span class="${centesimas > 0 ? 'bull' : 'bear'}">${centesimas > 0 ? '+' : ''}${num(dist * 100, 2)}%</span> ` +
    `del precio de ahora (${formatPrice(precio)}).`;
}

// La cifra grande: el cierre de la vela del bloque elegido arriba.
function bloqueCierre({ datos, interval, nivel, precio, vela }) {
  if (!vela || !Number.isFinite(vela.cierraEn)) return '';

  const h = alCierre(datos, vela.cierraEn - Date.now());
  if (!h) return '';

  const r = evaluar(h, precio, nivel);
  if (!r) return '';

  return `
    <div class="prob-cierre" data-prob-cierre data-cierra-en="${vela.cierraEn}">
      <p class="prob-cierre-titulo">
        al cierre de esta vela de <strong>${interval}</strong> ·
        quedan <span class="prob-cierre-falta">${formatClock(h.ms)}</span>
      </p>
      <div class="prob-cierre-cifras">
        <div class="prob-cierre-lado">
          <span class="prob-cierre-p prob-encima ${clase(r.p)}">${formatProb(r)}</span>
          <span class="prob-cierre-et">por encima</span>
        </div>
        <div class="prob-cierre-lado">
          <span class="prob-cierre-p prob-debajo ${clase(1 - r.p)}">${formatProb(inverso(r))}</span>
          <span class="prob-cierre-et">por debajo</span>
        </div>
      </div>
    </div>`;
}

/**
 * Pone los números al día sin repintar el panel.
 *
 * Esto corre con cada tick del precio y cuatro veces por segundo con el reloj,
 * así que no puede reconstruir nada: repintar cerraría el desplegable de «de
 * dónde sale este número» en cuanto alguien lo abriera, y además el campo del
 * precio perdería el foco mientras se escribe. Se reescribe sólo el texto de
 * lo que cambia.
 *
 * Devuelve `false` cuando lo que hay pintado ya no cuadra con los datos —al
 * cambiar de intervalo hay otros horizontes— para que la página repinte en vez
 * de dejar números de otro sitio.
 */
function actualizar(contenedor, { datos, nivel, precio, vela = null }, ahora = Date.now()) {
  if (!contenedor || !(nivel > 0) || !(precio > 0)) return false;

  const filas = utiles(datos);
  const tiles = contenedor.querySelectorAll('[data-prob-fila]');
  if (!tiles.length || tiles.length !== filas.length) return false;

  for (const tile of tiles) {
    const h = filas[Number(tile.dataset.probFila)];
    const r = evaluar(h, precio, nivel);
    escribir(tile.querySelector('.prob-encima'), formatProb(r), clase(r ? r.p : null));
    escribir(tile.querySelector('.prob-debajo'), `${formatProb(inverso(r))} abajo`, null);
    cuentaAtras(tile.querySelector('.pred-cuando'), ahora);
  }

  actualizarCierre(contenedor, { datos, nivel, precio, vela }, ahora);
  return true;
}

// El bloque del cierre se recalcula entero en cada paso: su horizonte es «lo
// que queda», y eso cambia con el reloj aunque no llegue ni un tick.
function actualizarCierre(contenedor, { datos, nivel, precio, vela }, ahora) {
  const caja = contenedor.querySelector('[data-prob-cierre]');
  if (!caja) return;

  // Cuando la vela cierra, el plazo se acaba y los datos que se están viendo
  // son de la vela anterior. Se dice, en vez de enseñar un número de algo que
  // ya pasó.
  const cierraEn = Number(caja.dataset.cierraEn);
  const restante = (Number.isFinite(vela && vela.cierraEn) ? vela.cierraEn : cierraEn) - ahora;
  if (Number.isFinite(vela && vela.cierraEn)) caja.dataset.cierraEn = String(vela.cierraEn);

  const falta = caja.querySelector('.prob-cierre-falta');
  const h = alCierre(datos, restante);
  const r = h ? evaluar(h, precio, nivel) : null;

  if (falta) escribir(falta, restante > 0 ? formatClock(restante) : 'cerrada', null);
  escribir(caja.querySelector('.prob-cierre-p.prob-encima'), formatProb(r), clase(r ? r.p : null));
  escribir(caja.querySelector('.prob-cierre-p.prob-debajo'), formatProb(inverso(r)), clase(r ? 1 - r.p : null));
}

function cuentaAtras(celda, ahora) {
  if (!celda || !celda.dataset || !celda.dataset.vence) return;
  const falta = Number(celda.dataset.vence) - ahora;
  escribir(celda, falta > 0 ? formatClock(falta) : 'vencida', null);
}

// Sólo se toca el DOM si el texto cambió. A diez ticks por segundo, escribir
// el mismo "62%" seiscientas veces por minuto es trabajo tirado, y además
// impediría seleccionar el número con el ratón mientras se lee.
function escribir(celda, texto, nueva) {
  if (!celda) return;
  if (celda.textContent !== texto) celda.textContent = texto;
  if (!nueva || !celda.classList) return;

  if (!celda.classList.contains(nueva)) {
    celda.classList.remove('bull', 'bear', 'flat');
    celda.classList.add(nueva);
  }
}

/**
 * La línea de una sola frase, para tenerla a la vista sin bajar la página.
 * Va al cierre de la vela que se está mirando, igual que la cifra grande.
 */
function renderLinea(contenedor, { datos, nivel, precio, interval, vela = null }) {
  if (!contenedor) return;
  if (!(nivel > 0) || !(precio > 0)) {
    contenedor.innerHTML = '';
    return;
  }

  const restante = vela && Number.isFinite(vela.cierraEn) ? vela.cierraEn - Date.now() : null;
  const h = restante > 0 ? alCierre(datos, restante) : utiles(datos)[0];
  const r = h ? evaluar(h, precio, nivel) : null;
  if (!r) {
    contenedor.innerHTML = '';
    return;
  }

  const cuando = restante > 0 ? `al cierre de esta vela de ${interval}` : `en ${formatClock(h.ms)}`;
  const html =
    `${cuando}: <span class="nota ${clase(r.p)}">${formatProb(r)}</span> por encima de ` +
    `<strong>${formatPrice(nivel)}</strong>`;

  // Sólo se asigna si cambió: esto corre con cada tick y reescribir el mismo
  // texto diez veces por segundo impide hasta seleccionarlo con el ratón.
  if (contenedor.innerHTML !== html) contenedor.innerHTML = html;
}

const API = {
  render, renderLinea, actualizar, evaluar, alCierre, redondearNivel,
  formatProb, clase, cuotas, inverso, cuantoFalta, MS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.PanelProbabilidad = API;
})();
