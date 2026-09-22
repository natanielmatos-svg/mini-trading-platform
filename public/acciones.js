'use strict';

// Página de acciones: gráfico, tabla multi-timeframe, panel de ruptura y
// avisos de compra y venta, sobre valores estadounidenses.
//
// El análisis es EL MISMO que el de criptomonedas. No hay una versión para
// bolsa de la ruptura, ni de las señales, ni del gráfico: operan sobre velas
// y una vela de Apple tiene la misma forma que una de bitcoin. Todo eso llega
// de /lib/*.js, que son los archivos que ejecuta también el servidor.
//
// Lo que sí es propio de la bolsa, y es de lo que va este archivo:
//
//   1. **El mercado cierra.** La cuenta atrás de la vela se corta al cierre
//      —una vela de una hora abierta a las 15:30 no dura hasta las 16:30— y
//      con el mercado cerrado lo que se cuenta es lo que falta para abrir.
//   2. **No hay WebSocket.** El precio se pregunta cada pocos segundos en vez
//      de llegar solo, y con la bolsa cerrada casi no se pregunta: no se
//      mueve.
//   3. **Hace falta clave.** Sin ALPACA_KEY_ID la página funciona con datos
//      de ejemplo y lo dice arriba, en vez de quedarse en blanco.

(function () {
const { formatPrice, num, formatPercent, formatClock, formatDuration, candleWindow } = globalThis.Format;
const Chart = globalThis.Chart;
const Ruptura = globalThis.Ruptura;
const Avisos = globalThis.Avisos;
const TablaMtf = globalThis.TablaMtf;
const PrecioVivo = globalThis.PrecioVivo;
const PanelPrediccion = globalThis.PanelPrediccion;

const calma = PrecioVivo.crear();

const MTF = ['1h', '4h', '1d', '1w'];
const CANDLES = 300;
const PREFS_KEY = 'mtp.alertas.acciones'; // separado del de cripto a propósito

// Cada cuánto se pregunta el precio. Con la bolsa abierta, cinco segundos:
// suficiente para que el número se vea vivo sin castigar la cuota gratuita.
// Cerrada, un minuto: el precio no se va a mover, sólo interesa enterarse de
// que ha abierto.
const PRECIO_ABIERTO_MS = 5_000;
const PRECIO_CERRADO_MS = 60_000;
const RELOJ_MS = 60_000;

// Cada cuánto se recargan las velas. Con el mercado cerrado no hay velas
// nuevas y se espera mucho más.
const VELAS_ABIERTO_MS = 60_000;
const VELAS_CERRADO_MS = 10 * 60_000;

const MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '1d': 86400e3, '1w': 604800e3 };

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('priceChart'),
  tooltip: $('tooltip'),
  symbolSelect: $('symbolSelect'),
  interval: $('intervalSelect'),
  load: $('loadBtn'),
  emaFast: $('emaFast'),
  emaSlow: $('emaSlow'),
  emaWarning: $('emaWarning'),
  status: $('statusText'),
  breakout: $('breakoutPanel'),
  forecast: $('forecastPanel'),
  market: $('marketState'),
  marketLabel: $('marketLabel'),
  aviso: $('avisoClave'),
  clockCard: $('clockCard'),
  clockPair: $('clockPair'),
  price: $('bigPrice'),
  priceChange: $('bigChange'),
  feedNote: $('feedNote'),
  countdownLabel: $('countdownLabel'),
  countdownBig: $('bigCountdown'),
  clockBar: $('clockBar'),
  clockOpen: $('clockOpen'),
  clockClose: $('clockClose'),
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

const state = {
  symbol: 'AAPL',
  interval: '1h',
  candles: [],
  mtf: {},
  breakout: null,
  forecast: null,
  quote: null,        // último precio devuelto por /api/stocks/quote
  clock: null,        // reloj del mercado
  source: null,
  fetchedAt: null,
  aviso: null,        // por qué son datos de ejemplo, si lo son
  loading: false,
  cargandoPrecio: false,
  hover: null,
  timerVelas: null,
  timerPrecio: null,
};

const abierto = () => Boolean(state.clock && state.clock.isOpen);

// El precio de ahora. Con el mercado abierto es el del libro; cerrado, es el
// cierre de la última vela y no la cotización suelta que devuelva el feed: en
// horario extendido esa cotización es de otro mercado y de otra sesión, y
// enseñarla junto a un gráfico que acaba en el cierre son dos números
// distintos para la misma cosa.
const precioActual = () => {
  const ultima = state.candles[state.candles.length - 1];
  if (!abierto() && ultima) return ultima.close;
  return state.quote && state.quote.price > 0 ? state.quote.price : ultima ? ultima.close : null;
};
const intervalToMs = (tf) => MS[tf] || 3600e3;
const fmtHora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Las horas del mercado van en hora de Nueva York y con el «NY» puesto. La
// sesión se cita así en todas partes, y quien mira desde Madrid necesita saber
// que las 9:30 no son las suyas.
const horaNY = (ms, extra = {}) =>
  new Date(ms).toLocaleString('es-ES', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', ...extra });

function emaLengths() {
  const fast = parseInt(el.emaFast.value, 10);
  const slow = parseInt(el.emaSlow.value, 10);
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || fast < 1 || slow < 1) {
    return { fast: null, slow: null, warning: 'Las EMAs tienen que ser números enteros mayores que cero.' };
  }
  if (fast >= slow) return { fast, slow, warning: 'La EMA rápida debería ser menor que la lenta.' };
  return { fast, slow, warning: '' };
}

// La vela en curso, recortada al cierre del mercado. Sin ese recorte la
// cuenta atrás de la última vela de la sesión prometería una hora que no va
// a existir: a las 16:00 se acaba, no a las 16:30.
function ventanaActual(now = Date.now()) {
  const ultima = state.candles[state.candles.length - 1];
  const fin = state.clock && state.clock.isOpen && state.clock.nextClose ? state.clock.nextClose - 1 : null;
  return candleWindow(now, intervalToMs(state.interval), ultima ? ultima.openTime : null, fin);
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

const velasUrl = (interval, limit = CANDLES) =>
  `/api/stocks/candles?symbol=${encodeURIComponent(state.symbol)}&interval=${interval}&limit=${limit}`;

async function loadSymbols() {
  try {
    const { groups, conClave, feed } = await getJson('/api/stocks/symbols');
    el.symbolSelect.innerHTML = '';

    for (const group of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.name;
      for (const s of group.symbols) {
        const option = document.createElement('option');
        option.value = s.symbol;
        option.textContent = `${s.name} · ${s.symbol}`;
        optgroup.appendChild(option);
      }
      el.symbolSelect.appendChild(optgroup);
    }
    el.symbolSelect.value = state.symbol;

    el.feedNote.textContent = conClave
      ? feed === 'sip'
        ? 'Precio de la cinta consolidada (SIP).'
        : 'Precio del feed gratuito de Alpaca (IEX): es un solo mercado, con poca cuota, así que puede separarse unos céntimos del precio consolidado.'
      : '';
  } catch {
    // Sin catálogo queda el valor por defecto y se puede seguir mirando.
  }
}

async function loadClock() {
  try {
    state.clock = await getJson('/api/stocks/clock');
  } catch {
    state.clock = null;
  }
  renderMarket();
}

async function loadAll({ silent = false } = {}) {
  if (state.loading) return; // sin esto, una carga lenta se solapa con la siguiente
  state.loading = true;
  if (!silent) setStatus(`Cargando ${state.symbol}…`);

  try {
    // El timeframe del gráfico suele ser uno de los de la tabla: pedirlo dos
    // veces sería una llamada de cada cinco tirada a la basura.
    const needed = [...new Set([state.interval, ...MTF])];
    const results = await Promise.all(needed.map((tf) => getJson(velasUrl(tf))));

    const byInterval = {};
    needed.forEach((tf, i) => {
      byInterval[tf] = results[i];
    });

    state.candles = byInterval[state.interval].candles;
    state.source = byInterval[state.interval].source;
    state.fetchedAt = byInterval[state.interval].fetchedAt;
    state.aviso = byInterval[state.interval].aviso || null;
    state.mtf = Object.fromEntries(MTF.map((tf) => [tf, byInterval[tf].candles]));

    await loadBreakout();
    loadForecast(); // sin await: es cara y no debe retrasar el gráfico
    avisos.evaluar();
    render({ force: true });
    setStatus('');
  } catch (err) {
    setStatus(`No se pudieron cargar los datos: ${err.message}`, true);
  } finally {
    state.loading = false;
    renderAviso();
    programarVelas();
  }
}

async function loadBreakout() {
  try {
    const price = precioActual();
    const url = `/api/stocks/breakout?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}${price ? `&price=${price}` : ''}`;
    const data = await getJson(url);
    if (data.symbol !== state.symbol) return; // llegó tarde, ya cambiamos de valor
    state.breakout = data;
    if (data.clock) state.clock = data.clock;
    if (data.aviso) state.aviso = data.aviso;
  } catch (err) {
    state.breakout = { ok: false, reason: `No se pudo calcular: ${err.message}` };
  }
}

async function loadPrecio() {
  if (state.cargandoPrecio) return;
  state.cargandoPrecio = true;

  try {
    const data = await getJson(`/api/stocks/quote?symbol=${encodeURIComponent(state.symbol)}`);
    if (data.symbol !== state.symbol) return;
    state.quote = data;
    if (data.aviso) state.aviso = data.aviso;
    renderClock();
    avisos.evaluar();
    renderBreakout();
  } catch {
    // Un fallo puntual del precio no debe borrar el que ya se enseña: se
    // reintenta en el siguiente ciclo.
  } finally {
    state.cargandoPrecio = false;
    programarPrecio();
  }
}

function programarPrecio() {
  clearTimeout(state.timerPrecio);
  if (document.hidden && !avisos.enabled) return;
  state.timerPrecio = setTimeout(loadPrecio, abierto() ? PRECIO_ABIERTO_MS : PRECIO_CERRADO_MS);
}

function programarVelas() {
  clearTimeout(state.timerVelas);
  if (document.hidden && !avisos.enabled) return;
  state.timerVelas = setTimeout(() => loadAll({ silent: true }), abierto() ? VELAS_ABIERTO_MS : VELAS_CERRADO_MS);
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

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
    price: precioActual(),
    symbol: state.symbol,
    interval: state.interval,
  }),
  onCambio: () => {
    programarPrecio();
    programarVelas();
  },
});


// La predicción es cara —recorre el histórico prediciendo hacia delante para
// calibrarse— así que va por su cuenta y no bloquea el resto de la carga.
async function loadForecast() {
  try {
    const data = await getJson(`/api/stocks/forecast?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}`);
    if (data.symbol !== state.symbol) return; // llegó tarde
    state.forecast = data;
  } catch (err) {
    state.forecast = { error: `No se pudo predecir: ${err.message}` };
  }
  renderForecast();
}

function renderForecast() {
  if (el.forecast) PanelPrediccion.render(el.forecast, state.forecast, state.interval);
}

// ---------------------------------------------------------------------------
// Pintado
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
    const origen = state.source === 'demo' ? 'datos de ejemplo' : state.source;
    parts.push(`${state.candles.length} velas de ${state.interval} · ${origen} · actualizado ${fmtHora(state.fetchedAt)}`);
  }
  el.status.textContent = parts.join('\n');
  el.status.classList.toggle('error', isError);
}

// El aviso de arriba sólo aparece si falta la clave. Es la diferencia entre
// una página que no funciona y una que funciona con datos de ejemplo, y hay
// que poder leerla sin abrir la consola.
function renderAviso() {
  if (!state.aviso) {
    el.aviso.hidden = true;
    return;
  }
  el.aviso.hidden = false;
  el.aviso.innerHTML = `<strong>Sin clave de Alpaca.</strong> ${state.aviso.replace(/ALPACA_(\w+)/g, '<code>ALPACA_$1</code>')}`;
}

function renderMarket() {
  const c = state.clock;
  if (!c) {
    el.market.className = 'market';
    el.marketLabel.textContent = 'reloj no disponible';
    return;
  }

  el.market.className = `market ${c.isOpen ? 'abierto' : 'cerrado'}`;
  const cuando = c.isOpen ? c.nextClose : c.nextOpen;
  const falta = cuando ? formatDuration(cuando - Date.now()) : null;
  el.marketLabel.textContent = c.isOpen
    ? `mercado abierto${falta ? ` · cierra en ${falta}` : ''}`
    : `mercado cerrado${falta ? ` · abre en ${falta}` : ''}`;
}

// El cambio se mide desde que abrió la última vela. Si esa vela es la que está
// en curso se dice «en esta vela»; si el mercado lleva cerrado un rato es la
// última que hubo, y se dice. Antes, cuando no coincidían, el hueco se quedaba
// en blanco: el precio sin referencia no dice nada.
function renderCambio(ventana) {
  const ultima = state.candles[state.candles.length - 1];
  // Contra el precio que se está ENSEÑANDO, no contra el crudo: si no, el
  // porcentaje se movería con el titular quieto y parecerían dos números
  // distintos de la misma cosa.
  const precio = calma.valor !== null ? calma.valor : precioActual();
  if (!ultima || !(ultima.open > 0) || precio === null) {
    el.priceChange.textContent = '';
    return;
  }

  const enCurso = Boolean(ventana) && ultima.openTime === ventana.open && abierto();
  const cambio = (precio - ultima.open) / ultima.open;
  el.priceChange.textContent = `${cambio >= 0 ? '+' : ''}${formatPercent(cambio, 2)} ${enCurso ? 'en esta vela' : 'en la última vela'}`;
  el.priceChange.className = `change ${cambio >= 0 ? 'up' : 'down'}`;
}

// El bloque de tiempo. Con el mercado abierto cuenta lo que le queda a la
// vela; con el mercado cerrado no tiene sentido contar una vela que no se va
// a mover, así que cuenta lo que falta para la apertura.
function renderClock() {
  el.clockPair.textContent = `${state.symbol} · ${state.interval}`;

  // El titular no se repinta con cada consulta: ver src/precio-vivo.js. El
  // precio que usa el ANÁLISIS no pasa por aquí y sigue siendo el crudo.
  const nuevo = calma.siguiente(precioActual());
  if (nuevo) {
    el.price.textContent = formatPrice(nuevo.valor, nuevo.decimales);
    if (nuevo.direccion) {
      el.price.classList.remove('sube', 'baja');
      void el.price.offsetWidth; // reinicia la animación
      el.price.classList.add(nuevo.direccion);
    }
  }

  const ventana = ventanaActual();

  if (!abierto()) {
    el.clockCard.classList.add('cerrado');
    el.countdownLabel.textContent = 'abre en';
    const falta = state.clock && state.clock.nextOpen ? state.clock.nextOpen - Date.now() : null;
    el.countdownBig.textContent = falta && falta > 0 ? formatDuration(falta) : '—';
    el.countdownBig.className = 'time';
    el.clockBar.style.width = '0%';
    el.clockBar.className = '';

    const ultima = state.candles[state.candles.length - 1];
    el.clockOpen.textContent = ultima ? `último cierre ${horaNY(ultima.closeTime, { day: '2-digit', month: 'short' })} NY` : '';
    el.clockClose.textContent = state.clock && state.clock.nextOpen
      ? `abre ${horaNY(state.clock.nextOpen, { weekday: 'short' })} NY`
      : '';

    renderCambio(ventana);
    return;
  }

  el.clockCard.classList.remove('cerrado');
  if (!ventana) return;

  renderCambio(ventana);

  el.countdownLabel.textContent = ventana.recortada ? 'cierra la sesión en' : 'cierra en';
  el.countdownBig.textContent = formatClock(ventana.remainingMs);

  // Urgencia en el último cuarto, y roja en el último 10%.
  const restante = 1 - ventana.elapsed;
  el.countdownBig.className = `time ${restante < 0.1 ? 'urgente' : restante < 0.25 ? 'cerca' : ''}`;
  el.clockBar.style.width = `${clamp(restante * 100, 0, 100)}%`;
  el.clockBar.className = restante < 0.1 ? 'urgente' : restante < 0.25 ? 'cerca' : '';

  const hora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  el.clockOpen.textContent = `abrió ${hora(ventana.open)}`;
  el.clockClose.textContent = `${ventana.recortada ? 'cierra el mercado' : 'cierra'} ${hora(ventana.close + 1)}`;
}

// --- Gráfico ---------------------------------------------------------------

function resizeCanvas() {
  Chart.resize(el.canvas, ctx);
  drawChart();
}

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

function renderTable() {
  const { fast, slow } = emaLengths();
  TablaMtf.render({ mtf: state.mtf, fast, slow, timeframes: MTF, celda: (tf) => $(`cell-${tf}`) });
}

function renderBreakout({ force = false } = {}) {
  const now = Date.now();
  const ventana = ventanaActual(now);

  // Con el mercado cerrado no hay vela en curso, así que descontar el tiempo
  // restante daría 0% en los dos lados: cierto —no va a romper nada esta
  // noche— e inútil. Se calcula sobre una vela entera, que es la que se
  // abrirá en la próxima sesión, y la nota dice que eso es lo que se está
  // viendo.
  const cerrado = !abierto();
  const remaining = cerrado ? 1 : ventana ? ventana.remainingMs / intervalToMs(state.interval) : 0.01;

  Ruptura.render(el.breakout, {
    breakout: state.breakout,
    price: precioActual(),
    remaining,
    nota: cerrado ? 'mercado cerrado · probabilidades de una vela entera de la próxima sesión' : null,
    force,
    now,
  });
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

function applyControls() {
  const symbol = el.symbolSelect.value;
  const interval = el.interval.value;
  const changed = symbol !== state.symbol || interval !== state.interval;

  state.symbol = symbol;
  state.interval = interval;

  if (changed) {
    state.candles = [];
    state.quote = null;
    state.breakout = null;
    calma.reiniciar(); // valor nuevo: el primer precio no se compara con el anterior
    avisos.olvidarPrimera(); // valor nuevo: no se grita por lo que ya había pasado
    avisos.renderHint();
  }

  loadPrecio();
  loadAll();
}

function init() {
  // Antes del primer dibujo: el seguimiento guardado aporta el stop y el
  // objetivo, y son dos líneas del gráfico.
  avisos.init();
  resizeCanvas();

  el.symbolSelect.addEventListener('change', applyControls);
  el.interval.addEventListener('change', applyControls);
  el.load.addEventListener('click', applyControls);

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
      if (!avisos.enabled) {
        clearTimeout(state.timerPrecio);
        clearTimeout(state.timerVelas);
      }
      return;
    }
    loadPrecio();
    loadAll({ silent: true });
  });

  // El cronómetro corre del reloj del navegador, así que sigue bajando aunque
  // no llegue un solo precio.
  setInterval(() => {
    if (document.hidden) return;
    renderClock();
    renderMarket();
    if (state.breakout && state.breakout.ok) renderBreakout();
  }, 250);

  // El reloj del mercado se revisa cada minuto: la apertura y el cierre son
  // los dos instantes en que la página tiene que cambiar de comportamiento.
  setInterval(loadClock, RELOJ_MS);

  loadSymbols();
  loadClock().then(() => {
    loadPrecio();
    loadAll();
  });
}

document.addEventListener('DOMContentLoaded', init);
})();
