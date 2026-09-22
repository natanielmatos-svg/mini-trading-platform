'use strict';

// Plataforma de trading: gráfico, tabla multi-timeframe, panel de ruptura y
// avisos de entrada y salida.
//
// Los indicadores, el formato de números, el motor de señales y el dibujo del
// gráfico llegan de /lib/*.js, que son los mismos archivos que ejecuta el
// servidor: no puede haber dos versiones de la misma regla.

(function () {
// Los indicadores los usan ya los módulos compartidos; aquí no queda ninguno.
const { formatPrice, num, formatPercent, formatClock, candleWindow } = globalThis.Format;
const Chart = globalThis.Chart;
const Ruptura = globalThis.Ruptura;
const Avisos = globalThis.Avisos;
const TablaMtf = globalThis.TablaMtf;
const PrecioVivo = globalThis.PrecioVivo;

const MTF = ['1h', '4h', '1d', '1w'];
const CANDLES = 300;
const PREFS_KEY = 'mtp.alertas';
const MERCADOS_KEY = 'mtp.mercados';

const state = {
  symbol: 'BTCUSDT',
  interval: '1h',
  candles: [],
  mtf: {},
  breakout: null,
  live: null,        // última vela recibida
  livePrice: null,   // último precio operado en Binance, tick a tick
  consolidado: null, // mediana de los mercados elegidos
  mercados: null,    // ids elegidos; null = todos los que haya
  catalogo: null,    // mercados soportados, pedidos aparte de los precios
  precioError: null, // por qué no hay consolidado, si lo hay
  base: 0,           // diferencia medida entre el consolidado y Binance
  priceTimer: null,
  source: null,
  fetchedAt: null,
  loading: false,
  failures: 0,
  sse: null,
  refreshTimer: null,
  hover: null,
};

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('priceChart'),
  symbolSelect: $('symbolSelect'),
  symbol: $('symbolInput'),
  interval: $('intervalSelect'),
  load: $('loadBtn'),
  emaFast: $('emaFast'),
  emaSlow: $('emaSlow'),
  emaWarning: $('emaWarning'),
  status: $('statusText'),
  price: $('bigPrice'),
  priceChange: $('bigChange'),
  clockPair: $('clockPair'),
  countdownBig: $('bigCountdown'),
  clockBar: $('clockBar'),
  clockOpen: $('clockOpen'),
  clockClose: $('clockClose'),
  venues: $('venueBox'),
  streamDot: $('streamDot'),
  streamLabel: $('streamLabel'),
  tooltip: $('tooltip'),
  breakout: $('breakoutPanel'),
  alertToggle: $('alertToggle'),
  alertTest: $('alertTest'),
  alertMode: $('alertMode'),
  avisoToggle: $('avisoToggle'),
  alertHint: $('alertHint'),
  position: $('positionBox'),
  history: $('signalHistory'),
  modal: $('alertModal'),
  modalCard: $('alertCard'),
};

const ctx = el.canvas.getContext('2d');

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const pairKey = () => `${state.symbol}|${state.interval}`;

// Precio de Binance: el que usa el ANÁLISIS. Los niveles y el ATR salen de
// las velas de Binance, así que medir la distancia a un nivel con el precio de
// otra casa haría que "faltan 0,87% hasta el nivel" fuera sutilmente falso.
function precioActual() {
  if (state.livePrice && state.livePrice.price > 0) return state.livePrice.price;
  const ultima = state.candles[state.candles.length - 1];
  return ultima ? ultima.close : null;
}

// Precio del TITULAR: la mediana de los tres mercados.
//
// El consolidado se consulta cada dos segundos, pero el titular no puede
// quedarse quieto dos segundos entre actualizaciones. Entre consulta y
// consulta se mueve con el tick de Binance manteniendo la diferencia medida
// con los otros dos, que cambia despacio; cada consulta la vuelve a medir.
function precioTitular() {
  const binance = precioActual();
  if (state.consolidado && state.consolidado.price > 0) {
    if (binance === null) return state.consolidado.price;
    // Sin base utilizable, manda el consolidado: no se inventa un número.
    return state.base === 0 ? state.consolidado.price : binance + state.base;
  }
  return binance;
}

// Ventana de la vela en curso, anclada a la apertura que dio Binance.
function ventanaActual(now = Date.now()) {
  const ultima = state.candles[state.candles.length - 1];
  return candleWindow(now, intervalToMs(state.interval), ultima ? ultima.openTime : null);
}

function fmtHora(ms) {
  return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
// Preferencias (localStorage es opcional: en modo privado lanza excepción)
// ---------------------------------------------------------------------------

function loadMercados() {
  try {
    const raw = localStorage.getItem(MERCADOS_KEY);
    const lista = raw ? JSON.parse(raw) : null;
    if (Array.isArray(lista) && lista.length) state.mercados = lista;
  } catch {
    /* sin persistencia se empieza con todos */
  }
}

function saveMercados() {
  try {
    if (state.mercados && state.mercados.length) localStorage.setItem(MERCADOS_KEY, JSON.stringify(state.mercados));
    else localStorage.removeItem(MERCADOS_KEY);
  } catch {
    /* idem */
  }
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

async function loadSymbols() {
  try {
    const { groups, verified } = await getJson('/api/symbols');
    el.symbolSelect.innerHTML = '';

    for (const group of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.name;
      for (const s of group.symbols) {
        const option = document.createElement('option');
        option.value = s.symbol;
        option.textContent = `${s.name} · ${s.symbol.replace('USDT', '/USDT')}`;
        optgroup.appendChild(option);
      }
      el.symbolSelect.appendChild(optgroup);
    }

    const otro = document.createElement('option');
    otro.value = '__otro';
    otro.textContent = 'Otro par…';
    el.symbolSelect.appendChild(otro);

    el.symbolSelect.value = state.symbol;
    if (!el.symbolSelect.value) selectOther(state.symbol);
    el.symbolSelect.title = verified ? 'Pares verificados contra Binance' : 'Lista sin verificar (Binance no respondió)';
  } catch {
    // Sin la lista se sigue pudiendo escribir el par a mano.
    selectOther(state.symbol);
  }
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
    avisos.evaluar();
    render({ force: true });
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

async function loadCatalogo() {
  try {
    const { venues } = await getJson('/api/venues');
    if (Array.isArray(venues) && venues.length) {
      state.catalogo = venues;
      renderClock();
    }
  } catch {
    // Sin catálogo el selector se pinta con lo que traiga /api/price.
  }
}

async function loadConsolidado() {
  // Sin guardia, una consulta lenta se solapa con la siguiente cada dos
  // segundos y acaban pisándose.
  if (state.cargandoPrecio) return;
  state.cargandoPrecio = true;

  try {
    const eleccion = state.mercados && state.mercados.length ? `&venues=${state.mercados.join(',')}` : '';
    const data = await getJson(`/api/price?symbol=${encodeURIComponent(state.symbol)}${eleccion}`);
    if (data.symbol !== state.symbol) return; // llegó tarde, ya cambiamos de par
    state.consolidado = data;

    // La diferencia se mide contra el precio de Binance del mismo instante.
    const binance = data.venues.find((v) => v.id === 'binance');
    const referencia = binance && binance.usable ? binance.price : precioActual();
    const base = data.price > 0 && referencia > 0 ? data.price - referencia : 0;

    // Tope: entre mercados al contado del mismo activo la diferencia son unos
    // pocos puntos básicos. Media unidad porcentual ya no es una base, es que
    // algo no cuadra —una consulta vieja, un par equivocado—, y arrastrar el
    // titular con eso sería peor que no corregirlo. En ese caso se enseña el
    // consolidado tal cual.
    state.base = Math.abs(base) <= data.price * 0.005 ? base : 0;

    state.precioError = null;
    renderClock();
  } catch (err) {
    // Se guarda el motivo: tragárselo dejaba la interfaz diciendo
    // "consolidando…" para siempre, sin pista de qué pasaba.
    state.consolidado = null;
    state.base = 0;
    state.precioError = err.message;
    renderClock();
  } finally {
    state.cargandoPrecio = false;
  }
}

function programarConsolidado() {
  clearInterval(state.priceTimer);
  state.priceTimer = setInterval(() => {
    if (!document.hidden) loadConsolidado();
  }, 2000);
}

// Reintentos con espera creciente: si el servidor está caído, insistir cada
// minuto no lo levanta y sí llena su log.
function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  // Con los avisos encendidos la pestaña oculta sigue trabajando: para eso
  // están los avisos, para enterarte cuando no estás mirando.
  if (document.hidden && !avisos.enabled) return;

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

  sse.addEventListener('price', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.symbol !== state.symbol || !(data.price > 0)) return;
      state.livePrice = data;
      renderClock();
      // La probabilidad de ruptura se mueve con el precio, así que el panel
      // se repinta también; es sólo texto, no toca el gráfico.
      renderBreakout();
    } catch {
      /* un mensaje ilegible no debe romper el flujo */
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

  for (const tf of MTF) {
    const series = state.mtf[tf];
    const tail = series && series[series.length - 1];
    if (tail && !tail.closed) {
      tail.close = tick.close;
      tail.high = Math.max(tail.high, tick.close);
      tail.low = Math.min(tail.low, tick.close);
    }
  }

  const b = state.breakout;
  if (b && b.ok && b.atr > 0 && Math.abs(tick.close - state.breakoutPriceAtFetch) > b.atr * 0.35) {
    state.breakoutPriceAtFetch = tick.close;
    loadBreakout().then(render);
  }

  avisos.evaluar();
  requestRender();
}

function setStreamState(label) {
  el.streamLabel.textContent = label;
  el.streamDot.className = `dot ${['en vivo', 'demo'].includes(label) ? 'on' : label === 'desconectado' || label === 'error' ? 'off' : 'warn'}`;
}

// ---------------------------------------------------------------------------
// Avisos de entrada y salida
// ---------------------------------------------------------------------------
//
// El gestor está en /lib/avisos.js, compartido con la página de acciones.
// Aquí sólo se le dice de dónde sacar el estado del momento.

const avisos = Avisos.crearAvisos({
  elementos: {
    toggle: el.alertToggle,
    test: el.alertTest,
    mode: el.alertMode,
    avisoToggle: el.avisoToggle,
    hint: el.alertHint,
    position: el.position,
    history: el.history,
    modal: el.modal,
    modalCard: el.modalCard,
  },
  claveAlmacen: PREFS_KEY,
  datos: () => ({
    candles: state.candles,
    breakout: state.breakout,
    price: state.live ? state.live.close : null,
    symbol: state.symbol,
    interval: state.interval,
  }),
  // Con avisos encendidos interesa refrescar más a menudo aunque la pestaña
  // esté en segundo plano.
  onCambio: () => scheduleRefresh(),
});

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

function render({ force = false } = {}) {
  const { warning } = emaLengths();
  el.emaWarning.textContent = warning;
  el.emaWarning.style.display = warning ? 'block' : 'none';

  drawChart();
  renderTable();
  renderClock();
  renderBreakout({ force });
  avisos.render();
}

function setStatus(text, isError = false) {
  const parts = [];
  if (text) parts.push(text);
  if (state.fetchedAt) {
    const origen = state.source === 'demo' ? 'datos de ejemplo' : 'Binance';
    parts.push(`${state.candles.length} velas de ${state.interval} · ${origen} · actualizado ${fmtHora(state.fetchedAt)}`);
  }
  el.status.textContent = parts.join('\n');
  el.status.classList.toggle('error', isError);
}

// El desglose por mercado. Lo interesante no es el número consolidado sino
// ver cuánto discrepan: parte de esa diferencia ni siquiera es desacuerdo
// sobre el activo, es que Binance cotiza en USDT y los otros dos en dólares.
let firmaVenues = null;

function renderVenues() {
  const c = state.consolidado;

  // Las casas soportadas salen del catálogo, que no depende de que haya
  // precios. Antes se sacaban de la respuesta de precios, así que un fallo
  // ahí se llevaba por delante el selector entero — y es justo cuando quieres
  // apagar la casa que falla.
  const soportadas = state.catalogo || (c && c.venuesSupported) || [];

  if (!soportadas.length) {
    if (firmaVenues !== 'vacío') {
      el.venues.innerHTML = '<span class="venue-none">cargando mercados…</span>';
      firmaVenues = 'vacío';
    }
    return;
  }

  const porId = new Map(((c && c.venues) || []).map((v) => [v.id, v]));
  const elegidos = state.mercados && state.mercados.length
    ? state.mercados
    : soportadas.filter((v) => !v.optIn).map((v) => v.id);
  const unicoElegido = elegidos.length === 1;

  // Este bloque se repinta desde el reloj, cuatro veces por segundo, pero sus
  // datos sólo cambian cada dos segundos. Reconstruir el HTML para nada
  // desprendía las casillas del DOM mientras el usuario intentaba marcarlas,
  // así que sólo se rehace cuando algo cambió de verdad.
  const firma = JSON.stringify([
    c && c.price, c && c.used, c && c.spreadPct, state.precioError,
    elegidos, soportadas.length, state.venuesAbierto, state.venuesTocado,
  ]);
  if (firma === firmaVenues) return;
  firmaVenues = firma;

  const filas = soportadas
    .map((soportada) => {
      const v = porId.get(soportada.id);
      const activo = elegidos.includes(soportada.id);
      const estado = !activo ? 'apagado' : !v ? 'sin datos' : !v.usable ? (v.error ? 'caído' : 'viejo') : '';
      const diff = activo && v && v.usable && v.diff !== null
        ? `${v.diff >= 0 ? '+' : ''}${num(v.diffPct, 3)}%`
        : estado;
      const etiqueta = soportada.kind === 'índice' ? ' <b class="v-kind">índice</b>' : '';

      return `<label class="venue ${activo && v && v.usable ? '' : 'off'}" ${v && v.error ? `title="${v.error.replace(/"/g, "'")}"` : ''}>
        <input type="checkbox" data-venue="${soportada.id}" ${activo ? 'checked' : ''} ${activo && unicoElegido ? 'disabled' : ''} />
        <span class="v-name">${soportada.label}${etiqueta}<em>${(v && v.pair) || ''}${
          v && v.converted ? ` · ${formatPrice(v.priceRaw)} USDT` : ''
        }${v && v.source && v.source !== 'libro' && v.source !== soportada.kind ? ' · ' + v.source : ''}</em></span>
        <span class="v-price">${v && v.price > 0 ? formatPrice(v.price) : '—'}</span>
        <span class="v-diff ${v && v.diff > 0 ? 'up' : v && v.diff < 0 ? 'down' : ''}">${diff}</span>
      </label>`;
    })
    .join('');

  // El resumen dice la verdad también cuando no hay precio.
  const resumen = c && c.price > 0
    ? `${c.used} de ${soportadas.length} mercados · ${c.agreement} · dif. ${num(c.spreadPct, 3)}%`
    : state.precioError
      ? `sin precio consolidado · ${state.precioError}`
      : 'sin precio consolidado · ningún mercado responde';

  const fallos = ((c && c.venues) || []).filter((v) => v.error);
  const detalleFallos = !c || c.price > 0 || !fallos.length
    ? ''
    : `<p class="venue-note venue-error">${fallos.map((v) => `<b>${v.label}</b>: ${v.error}`).join('<br>')}</p>`;

  const notaConversion = c && c.venues && c.venues.some((v) => v.converted)
    ? `<p class="venue-note">Los precios en USDT se pasan a dólares al cambio de ${num(c.venues.find((v) => v.converted).stable.rate, 4)} (${c.venues.find((v) => v.converted).stable.source}): si no, el desvío de la stablecoin se colaría en la mediana como si fuera precio del activo.</p>`
    : '';

  el.venues.innerHTML =
    `<button class="venue-summary ${c && c.price > 0 ? '' : 'malo'}" id="venueToggle" aria-expanded="false">${resumen}</button>` +
    `<div class="venue-list" hidden>${filas}${detalleFallos}${notaConversion}` +
    `<p class="venue-note">Mediana del punto medio del libro de cada mercado, que siempre es de ahora — la última operación de un mercado poco activo puede ser de hace minutos. El análisis de ruptura usa el precio de Binance, que es de donde salen las velas.</p>` +
    `</div>`;

  const toggle = $('venueToggle');
  const lista = el.venues.querySelector('.venue-list');

  // Si no hay precio, el detalle se abre solo: el motivo está ahí dentro y
  // esconderlo detrás de un clic es esconder justo lo que hace falta leer.
  // Salvo que el usuario ya lo haya cerrado a mano.
  const abrir = state.venuesTocado ? state.venuesAbierto : state.venuesAbierto || !(c && c.price > 0);
  lista.hidden = !abrir;
  toggle.setAttribute('aria-expanded', String(abrir));

  toggle.addEventListener('click', () => {
    state.venuesTocado = true;
    state.venuesAbierto = lista.hidden;
    lista.hidden = !state.venuesAbierto;
    toggle.setAttribute('aria-expanded', String(state.venuesAbierto));
  });

  for (const casilla of el.venues.querySelectorAll('input[data-venue]')) {
    casilla.addEventListener('change', () => {
      const id = casilla.dataset.venue;
      const siguiente = casilla.checked ? [...elegidos, id] : elegidos.filter((x) => x !== id);
      if (!siguiente.length) return; // sin mercados no hay precio

      const porDefecto = soportadas.filter((v) => !v.optIn).map((v) => v.id);
      const igualQueDefecto =
        siguiente.length === porDefecto.length && porDefecto.every((x) => siguiente.includes(x));
      state.mercados = igualQueDefecto ? null : siguiente;
      saveMercados();
      loadConsolidado();
    });
  }
}

// El bloque de tiempo: precio en vivo y cuánto le queda a la vela, con la
// barra vaciándose. Se repinta cuatro veces por segundo —el cronómetro sólo
// cambia cada segundo, pero la barra se mueve suave y el precio llega cuando
// llega— y no toca el canvas, así que es barato.
// El titular no se repinta con cada tick: ver src/precio-vivo.js. El precio
// que usa el ANÁLISIS no pasa por aquí y sigue siendo el crudo.
const calma = PrecioVivo.crear();

function renderClock() {
  const ventana = ventanaActual();
  if (!ventana) return;

  el.clockPair.textContent = `${state.symbol} · ${state.interval}`;

  // `siguiente` devuelve null casi siempre: sólo habla cuando el precio se ha
  // movido lo bastante como para que cambie algún dígito que se enseña.
  const nuevo = calma.siguiente(precioTitular());
  if (nuevo) {
    el.price.textContent = formatPrice(nuevo.valor, nuevo.decimales);

    // Destello sólo cuando el número cambia de verdad. Antes saltaba con cada
    // tick, y a diez por segundo el ojo veía muchísimo más movimiento del que
    // había.
    if (nuevo.direccion) {
      el.price.classList.remove('sube', 'baja');
      void el.price.offsetWidth; // reinicia la animación
      el.price.classList.add(nuevo.direccion);
    }
  }

  // El porcentaje va FUERA del `if`: también cambia cuando se abre una vela
  // nueva, y metido dentro se quedaba en blanco para siempre en cuanto el
  // precio se estaba quieto —que es la mayor parte del tiempo, justo ahora
  // que el titular ya no tiembla—.
  //
  // Se mide desde que abrió ESTA vela y contra el precio que se está
  // ENSEÑANDO: si se midiera contra el crudo, el porcentaje se movería con el
  // titular quieto y parecerían dos números distintos de la misma cosa.
  const abierta = state.candles[state.candles.length - 1];
  const apertura = abierta && abierta.openTime === ventana.open ? abierta.open : null;
  const mostrado = calma.valor;

  if (apertura > 0 && mostrado !== null) {
    const cambio = (mostrado - apertura) / apertura;
    el.priceChange.textContent = `${cambio >= 0 ? '+' : ''}${formatPercent(cambio, 2)} en esta vela`;
    el.priceChange.className = `change ${cambio >= 0 ? 'up' : 'down'}`;
  } else {
    el.priceChange.textContent = '';
  }

  renderVenues();
  el.countdownBig.textContent = formatClock(ventana.remainingMs);

  // Urgencia en el último cuarto, y roja en el último 10%.
  const restante = 1 - ventana.elapsed;
  el.countdownBig.className = `time ${restante < 0.1 ? 'urgente' : restante < 0.25 ? 'cerca' : ''}`;
  el.clockBar.style.width = `${clamp(restante * 100, 0, 100)}%`;
  el.clockBar.className = restante < 0.1 ? 'urgente' : restante < 0.25 ? 'cerca' : '';

  const hora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  el.clockOpen.textContent = `abrió ${hora(ventana.open)}`;
  el.clockClose.textContent = `cierra ${hora(ventana.close + 1)}`;
}

// --- Gráfico ---------------------------------------------------------------
//
// El dibujo está en /lib/chart.js, compartido con la página de acciones. Aquí
// queda sólo lo que depende del estado de ESTA página: qué niveles pintar y el
// tooltip de la vela bajo el cursor.

function resizeCanvas() {
  Chart.resize(el.canvas, ctx);
  drawChart();
}

// Los niveles de ruptura y, si hay un seguimiento abierto, stop y objetivo.
function nivelesDelGrafico() {
  const niveles = [];
  const b = state.breakout;
  if (b && b.ok) {
    if (b.up) niveles.push({ price: b.up.level, color: '#f87171', tag: 'R' });
    if (b.down) niveles.push({ price: b.down.level, color: '#4ade80', tag: 'S' });
  }
  const position = avisos.posicion();
  if (position) {
    niveles.push({ price: position.stop, color: '#fb7185', tag: 'STOP', dense: true });
    niveles.push({ price: position.target, color: '#38bdf8', tag: 'OBJ', dense: true });
  }
  return niveles;
}

function drawChart() {
  const { fast, slow } = emaLengths();
  Chart.draw(el.canvas, {
    candles: state.candles,
    interval: state.interval,
    emaFast: fast,
    emaSlow: slow,
    levels: nivelesDelGrafico(),
    hover: state.hover,
  });
}

function onCanvasMove(event) {
  const index = Chart.indexAt(el.canvas, event.clientX, state.candles);
  if (index === null) {
    hideTooltip();
    return;
  }

  state.hover = index;
  const c = state.candles[index];
  const change = (c.close - c.open) / c.open;
  const rect = el.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;

  el.tooltip.innerHTML = `
    <strong>${new Date(c.openTime).toLocaleString('es-ES')}</strong>
    <span>A ${formatPrice(c.open)}</span>
    <span>M ${formatPrice(c.high)}</span>
    <span>m ${formatPrice(c.low)}</span>
    <span>C ${formatPrice(c.close)} <em class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${formatPercent(change, 2)}</em></span>
    <span>Vol ${num(c.volume, 0)}</span>`;
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
  TablaMtf.render({ mtf: state.mtf, fast, slow, timeframes: MTF, celda: (tf) => $(`cell-${tf}`) });
}

// --- Panel de ruptura ------------------------------------------------------
//
// El panel lo pinta /lib/panel-ruptura.js, compartido con la página de
// acciones. Aquí sólo se decide con qué precio y con cuánta vela restante.

function renderBreakout({ force = false } = {}) {
  const now = Date.now();
  // El reloj manda sobre el payload, que puede tener uno o dos minutos.
  const ventana = ventanaActual(now);
  const remaining = ventana ? ventana.remainingMs / intervalToMs(state.interval) : 0.01;

  Ruptura.render(el.breakout, {
    breakout: state.breakout,
    price: precioActual(),
    remaining,
    force,
    now,
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function selectOther(symbol) {
  el.symbolSelect.value = '__otro';
  el.symbol.hidden = false;
  el.symbol.value = symbol;
}

function applyControls({ symbol = null } = {}) {
  const elegido = symbol || (el.symbolSelect.value === '__otro' ? el.symbol.value : el.symbolSelect.value);
  const limpio = String(elegido || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BTCUSDT';

  const changed = limpio !== state.symbol || el.interval.value !== state.interval;
  state.symbol = limpio;
  state.interval = el.interval.value;
  if (el.symbolSelect.value === '__otro') el.symbol.value = limpio;

  if (changed) {
    state.candles = [];
    state.live = null;
    state.livePrice = null;
    state.consolidado = null;
    state.base = 0;
    state.breakout = null;
    calma.reiniciar(); // par nuevo: el primer precio no se compara con el anterior
    avisos.olvidarPrimera(); // par nuevo: no se grita por lo que ya había pasado
    connectStream();
    avisos.renderHint();
  }
  loadAll();
}

function init() {
  loadMercados();
  // Antes del primer dibujo: el seguimiento guardado aporta el stop y el
  // objetivo, y son dos líneas del gráfico.
  avisos.init();
  resizeCanvas();

  el.symbolSelect.addEventListener('change', () => {
    if (el.symbolSelect.value === '__otro') {
      el.symbol.hidden = false;
      el.symbol.focus();
      return;
    }
    el.symbol.hidden = true;
    applyControls();
  });

  el.symbol.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyControls();
  });

  el.load.addEventListener('click', () => applyControls());
  el.interval.addEventListener('change', () => applyControls());

  for (const input of [el.emaFast, el.emaSlow]) {
    input.addEventListener('input', render);
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
      if (!avisos.enabled) clearTimeout(state.refreshTimer);
      return;
    }
    loadAll({ silent: true });
  });

  // El cronómetro corre del reloj del navegador, así que sigue bajando aunque
  // no llegue un solo tick. Cuatro veces por segundo para que la barra no dé
  // saltos.
  setInterval(() => {
    if (document.hidden) return;
    renderClock();
    if (state.breakout && state.breakout.ok) renderBreakout();
  }, 250);

  loadSymbols();
  loadCatalogo();
  connectStream();
  loadAll();
  loadConsolidado();
  programarConsolidado();
}

document.addEventListener('DOMContentLoaded', init);
})();
