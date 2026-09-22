'use strict';

// Plataforma de trading: gráfico, tabla multi-timeframe, panel de ruptura y
// avisos de entrada y salida.
//
// Los indicadores, el formato de números y el motor de señales llegan de
// /lib/*.js, que son los mismos archivos que ejecuta el servidor: no puede
// haber dos versiones de la misma regla.

(function () {
const { emaSeries, ema, shareAtLeast, requiredExcursion } = globalThis.Indicators;
const { formatPrice, num, formatPercent, formatClock, candleWindow } = globalThis.Format;
const { evaluateSignals } = globalThis.Signals;

const MTF = ['1h', '4h', '1d', '1w'];
const CANDLES = 300;
const EVAL_THROTTLE_MS = 1000;
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
  base: 0,           // diferencia medida entre el consolidado y Binance
  priceTimer: null,
  ultimoPintado: null,
  source: null,
  fetchedAt: null,
  loading: false,
  failures: 0,
  sse: null,
  refreshTimer: null,
  hover: null,
  lastEval: 0,
  alerts: {
    enabled: false,
    operativa: 'contado',   // 'contado' (comprar/vender) | 'ambos' (además, cortos)
    // Apagado por defecto: medido sobre histórico, el aviso previo salta unas
    // dos o tres veces al día. Quien quiera vigilar la aproximación lo
    // enciende; quien sólo quiera saber cuándo comprar y vender, no.
    avisosPrevios: false,
    primed: false,          // la primera evaluación no suena: sería una alerta de algo ya pasado
    seen: new Set(),
    history: [],
    positions: {},          // 'BTCUSDT|1h' -> seguimiento en papel
    audio: null,
  },
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

function fmtTimeAxis(ms, interval) {
  const d = new Date(ms);
  if (['1d', '3d', '1w', '1M'].includes(interval)) {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
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

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.alerts.enabled = Boolean(saved.enabled);
    if (saved.operativa === 'ambos' || saved.operativa === 'contado') state.alerts.operativa = saved.operativa;
    state.alerts.avisosPrevios = Boolean(saved.avisosPrevios);
    state.alerts.positions = saved.positions && typeof saved.positions === 'object' ? saved.positions : {};
  } catch {
    /* sin persistencia se sigue funcionando, sólo se olvida entre recargas */
  }
}

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

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      enabled: state.alerts.enabled,
      operativa: state.alerts.operativa,
      avisosPrevios: state.alerts.avisosPrevios,
      positions: state.alerts.positions,
    }));
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
    evaluateAlerts();
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

async function loadConsolidado() {
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

    renderClock();
  } catch {
    // Sin consolidado se sigue enseñando el de Binance; se nota en el detalle.
    state.consolidado = null;
    state.base = 0;
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
  if (document.hidden && !state.alerts.enabled) return;

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

  evaluateAlerts();
  requestRender();
}

function setStreamState(label) {
  el.streamLabel.textContent = label;
  el.streamDot.className = `dot ${['en vivo', 'demo'].includes(label) ? 'on' : label === 'desconectado' || label === 'error' ? 'off' : 'warn'}`;
}

// ---------------------------------------------------------------------------
// Avisos de entrada y salida
// ---------------------------------------------------------------------------

// El sonido se sintetiza: dos notas ascendentes para comprar, dos descendentes
// para vender, dos iguales para el aviso previo. Sin archivos que cargar, y se
// distinguen sin mirar la pantalla, que es el sentido de que suene.
const PATTERNS = {
  compra: [{ freq: 660, at: 0, dur: 0.12 }, { freq: 990, at: 0.13, dur: 0.22 }],
  venta: [{ freq: 780, at: 0, dur: 0.12 }, { freq: 440, at: 0.13, dur: 0.28 }],
  aviso: [{ freq: 880, at: 0, dur: 0.09 }, { freq: 880, at: 0.16, dur: 0.09 }],
};

const ETIQUETA = { compra: 'COMPRAR', venta: 'VENDER', aviso: 'AVISO' };

// El navegador no deja sonar sin un gesto previo del usuario. El contexto se
// puede crear en cualquier momento, pero nace suspendido y hay que reanudarlo
// desde un gesto. Al volver a la página con los avisos ya encendidos no hay
// ningún gesto todavía, así que se deja armado un `resume` para el primer
// clic o tecla que llegue: sin esto, quien dejó los avisos puestos ayer se
// encontraba hoy con alertas mudas.
function unlockAudio() {
  if (!state.alerts.audio) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      state.alerts.audio = new Ctor();
    } catch {
      return; // sin audio los avisos siguen saliendo en pantalla
    }
  }
  if (state.alerts.audio.state === 'suspended') {
    state.alerts.audio.resume().then(renderAlertHint).catch(() => {});
  }
}

function armarAudioConPrimerGesto() {
  const activar = () => {
    unlockAudio();
    renderAlertHint();
  };
  document.addEventListener('pointerdown', activar, { once: true });
  document.addEventListener('keydown', activar, { once: true });
}

function playSound(kind) {
  if (!state.alerts.audio) unlockAudio();
  const audio = state.alerts.audio;
  if (!audio || audio.state === 'closed') return;
  if (audio.state === 'suspended') audio.resume();

  const now = audio.currentTime;
  for (const note of PATTERNS[kind] || PATTERNS.aviso) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.freq;
    // Ataque y caída suaves: un oscilador cortado en seco chasquea.
    gain.gain.setValueAtTime(0.0001, now + note.at);
    gain.gain.exponentialRampToValueAtTime(0.22, now + note.at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.dur + 0.02);
  }
}

function notify(signal) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // `tag` con el id de la señal: si llega dos veces, el sistema la sustituye
    // en vez de apilar dos globos iguales.
    new Notification(signal.title, { body: `${signal.message}\n${signal.detail}`, tag: signal.id });
  } catch {
    /* algunos navegadores exigen service worker; el popout de la página queda */
  }
}

function showModal(signal) {
  const clase = signal.type === 'compra' ? 'bull' : signal.type === 'venta' ? 'bear' : 'warn';

  el.modalCard.className = `alert-card ${clase}`;
  el.modalCard.innerHTML = `
    <div class="alert-kind">${ETIQUETA[signal.type] || 'AVISO'}</div>
    <h3>${signal.title}</h3>
    <p>${signal.message}</p>
    <p class="alert-detail">${signal.detail}</p>
    <p class="alert-time">${fmtHora(signal.at)} · ${formatPrice(signal.price)}</p>
    <div class="alert-actions">
      <button id="alertOk">Entendido</button>
      <button id="alertMute" class="ghost">Silenciar avisos</button>
    </div>
    <p class="disclaimer">Análisis técnico automático sobre datos públicos. No es una recomendación de inversión.</p>`;

  el.modal.classList.add('open');
  $('alertOk').addEventListener('click', hideModal);
  $('alertMute').addEventListener('click', () => {
    setAlerts(false);
    hideModal();
  });
  $('alertOk').focus();
}

function hideModal() {
  el.modal.classList.remove('open');
}

function pushSignal(signal, { silent = false } = {}) {
  state.alerts.seen.add(signal.id);
  state.alerts.history.unshift({ ...signal, silent });
  state.alerts.history = state.alerts.history.slice(0, 20);

  if (!silent && state.alerts.enabled) {
    playSound(signal.sound);
    notify(signal);
    showModal(signal);
  }
  renderAlerts();
}

// Se evalúa con cada tick, así que se limita a una vez por segundo: buscar
// pivotes sobre 300 velas diez veces por segundo no aporta nada.
function evaluateAlerts({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - state.lastEval < EVAL_THROTTLE_MS) return;
  state.lastEval = now;

  if (!state.candles.length) return;

  const key = pairKey();
  const { signals, position } = evaluateSignals({
    candles: state.candles,
    breakout: state.breakout,
    position: state.alerts.positions[key] || null,
    price: state.live ? state.live.close : null,
    symbol: state.symbol,
    interval: state.interval,
    now,
    options: { operativa: state.alerts.operativa, avisosPrevios: state.alerts.avisosPrevios },
  });

  if (position) state.alerts.positions[key] = position;
  else delete state.alerts.positions[key];

  // La primera evaluación tras cargar la página no suena: avisar a gritos de
  // una ruptura que ocurrió antes de abrir el navegador es ruido, no una
  // alerta. Queda en el historial marcada como anterior.
  const primera = !state.alerts.primed;
  state.alerts.primed = true;

  for (const signal of signals) {
    if (state.alerts.seen.has(signal.id)) continue;
    pushSignal(signal, { silent: primera });
  }

  if (signals.length || primera) savePrefs();
  renderAlerts();
}

function setAlerts(enabled) {
  state.alerts.enabled = enabled;
  el.alertToggle.checked = enabled;

  if (enabled) {
    unlockAudio();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(renderAlertHint);
    }
  }

  savePrefs();
  renderAlertHint();
  scheduleRefresh();
}

function renderAlertHint() {
  if (!state.alerts.enabled) {
    el.alertHint.textContent = 'Apagados. Sin sonido ni ventana emergente.';
    return;
  }
  const permiso = 'Notification' in window ? Notification.permission : 'no soportado';
  const fuera =
    permiso === 'granted'
      ? 'También avisa fuera de la pestaña.'
      : permiso === 'denied'
        ? 'El navegador bloqueó las notificaciones: sólo avisa con la pestaña abierta.'
        : 'Acepta las notificaciones para que avise fuera de la pestaña.';

  const audio = state.alerts.audio;
  const sonido = !audio
    ? ' Sonido sin inicializar.'
    : audio.state === 'suspended'
      ? ' El navegador espera un clic tuyo para poder sonar.'
      : '';

  const modo = state.alerts.operativa === 'ambos' ? 'compra, venta y cortos' : 'compra y venta';
  el.alertHint.textContent = `Encendidos para ${state.symbol} ${state.interval} (${modo}). ${fuera}${sonido}`;
}

function renderAlerts() {
  const position = state.alerts.positions[pairKey()];

  if (!position) {
    el.position.innerHTML = '<p class="muted">Nada comprado ahora mismo. El seguimiento se abre solo cuando una vela confirma la señal de compra.</p>';
  } else {
    const largo = position.side === 'larga';
    const price = state.live ? state.live.close : state.candles.length ? state.candles[state.candles.length - 1].close : position.entry;
    const cambio = largo
      ? (price - position.entry) / position.entry
      : (position.entry - price) / position.entry;

    el.position.innerHTML = `
      <div class="position ${largo ? 'bull' : 'bear'}">
        <header>
          <span>${largo ? 'Comprado' : 'Vendido en corto'} · ${position.symbol} ${position.interval}</span>
          <strong class="${cambio >= 0 ? 'up' : 'down'}">${cambio >= 0 ? '+' : ''}${formatPercent(cambio, 2)}</strong>
        </header>
        <div class="detail">
          ${largo ? 'Comprado a' : 'Abierto a'} ${formatPrice(position.entry)} ·
          ${largo ? 'vender' : 'recomprar'} si ${largo ? 'baja de' : 'sube de'} ${formatPrice(position.stop)}
          o al llegar a ${formatPrice(position.target)}
          ${position.rewardRisk ? ` · ratio ${num(position.rewardRisk)}:1` : ''}
        </div>
        <button class="ghost small" id="positionDrop">Descartar seguimiento</button>
      </div>`;

    $('positionDrop').addEventListener('click', () => {
      delete state.alerts.positions[pairKey()];
      savePrefs();
      renderAlerts();
    });
  }

  el.history.innerHTML = state.alerts.history.length
    ? state.alerts.history
        .map(
          (s) => `<li class="sig ${s.type}${s.silent ? ' silent' : ''}">
            <span class="when">${fmtHora(s.at)}</span>
            <span class="what">${s.title}</span>
            <span class="why">${s.message}${s.silent ? ' <em>(ocurrió antes de abrir la página)</em>' : ''}</span>
          </li>`
        )
        .join('')
    : '<li class="muted">Todavía no ha saltado ninguna señal.</li>';
}

// Alerta de prueba: sirve para comprobar que el sonido y el permiso de
// notificaciones funcionan antes de fiarse de ellos.
function testAlert() {
  unlockAudio();
  const price = state.live ? state.live.close : 0;
  showModal({
    type: 'compra',
    at: Date.now(),
    price,
    title: `Prueba de aviso · ${state.symbol} ${state.interval}`,
    message: 'Si has oído dos notas ascendentes y ves esta ventana, los avisos funcionan.',
    detail: 'Las compras suenan ascendentes, las ventas descendentes y los avisos previos son dos notas iguales.',
  });
  playSound('compra');
  notify({ id: 'prueba', title: 'Prueba de aviso', message: 'Los avisos funcionan.', detail: '' });
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

function render({ force = false } = {}) {
  const { warning } = emaLengths();
  el.emaWarning.textContent = warning;
  el.emaWarning.style.display = warning ? 'block' : 'none';

  drawChart();
  renderTable();
  renderClock();
  renderBreakout({ force });
  renderAlerts();
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
function renderVenues() {
  const c = state.consolidado;

  if (!c || !(c.price > 0)) {
    el.venues.innerHTML = '<span class="venue-none">sólo Binance · consolidando…</span>';
    return;
  }

  // Se pintan TODAS las casas soportadas, no sólo las elegidas: si no, no
  // habría dónde volver a marcar la que acabas de quitar.
  const soportadas = c.venuesSupported || [];
  const porId = new Map(c.venues.map((v) => [v.id, v]));
  const elegidos = state.mercados && state.mercados.length ? state.mercados : soportadas.map((v) => v.id);
  const unicoElegido = elegidos.length === 1;

  const filas = soportadas
    .map((soportada) => {
      const v = porId.get(soportada.id);
      const activo = elegidos.includes(soportada.id);
      const estado = !activo ? 'apagado' : !v ? '—' : !v.usable ? (v.error ? 'caído' : 'viejo') : '';
      const diff = activo && v && v.usable && v.diff !== null
        ? `${v.diff >= 0 ? '+' : ''}${num(v.diffPct, 3)}%`
        : estado;

      return `<label class="venue ${activo && v && v.usable ? '' : 'off'}">
        <input type="checkbox" data-venue="${soportada.id}" ${activo ? 'checked' : ''} ${activo && unicoElegido ? 'disabled' : ''} />
        <span class="v-name">${soportada.label}<em>${(v && v.pair) || ''}${v && v.source && v.source !== 'libro' ? ' · ' + v.source : ''}</em></span>
        <span class="v-price">${v && v.price > 0 ? formatPrice(v.price) : '—'}</span>
        <span class="v-diff ${v && v.diff > 0 ? 'up' : v && v.diff < 0 ? 'down' : ''}">${diff}</span>
      </label>`;
    })
    .join('');

  el.venues.innerHTML =
    `<button class="venue-summary" id="venueToggle" aria-expanded="false">` +
    `${c.used} de ${soportadas.length} mercados · ${c.agreement} · dif. ${num(c.spreadPct, 3)}%` +
    `</button>` +
    `<div class="venue-list" hidden>${filas}` +
    `<p class="venue-note">Mediana del punto medio del libro de cada mercado, que siempre es de ahora — la última operación de un mercado poco activo puede ser de hace minutos. El análisis de ruptura usa el precio de Binance, que es de donde salen las velas.</p>` +
    `</div>`;

  const toggle = $('venueToggle');
  const lista = el.venues.querySelector('.venue-list');
  if (state.venuesAbierto) {
    lista.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }
  toggle.addEventListener('click', () => {
    state.venuesAbierto = !state.venuesAbierto;
    lista.hidden = !state.venuesAbierto;
    toggle.setAttribute('aria-expanded', String(state.venuesAbierto));
  });

  for (const casilla of el.venues.querySelectorAll('input[data-venue]')) {
    casilla.addEventListener('change', () => {
      const id = casilla.dataset.venue;
      const siguiente = casilla.checked ? [...elegidos, id] : elegidos.filter((x) => x !== id);

      // Nunca se queda sin ninguno: sin mercados no hay precio.
      if (!siguiente.length) return;

      state.mercados = siguiente.length === soportadas.length ? null : siguiente;
      saveMercados();
      loadConsolidado();
    });
  }
}

// El bloque de tiempo: precio en vivo y cuánto le queda a la vela, con la
// barra vaciándose. Se repinta cuatro veces por segundo —el cronómetro sólo
// cambia cada segundo, pero la barra se mueve suave y el precio llega cuando
// llega— y no toca el canvas, así que es barato.
function renderClock() {
  const precio = precioTitular();
  const ventana = ventanaActual();
  if (!ventana) return;

  el.clockPair.textContent = `${state.symbol} · ${state.interval}`;

  if (precio !== null) {
    el.price.textContent = formatPrice(precio);

    // Destello al cambiar: el número parece vivo aunque el cambio sea de un
    // céntimo, que es justo lo que se pide a un precio en tiempo real.
    if (state.ultimoPintado !== null && precio !== state.ultimoPintado) {
      el.price.classList.remove('sube', 'baja');
      void el.price.offsetWidth; // reinicia la animación
      el.price.classList.add(precio > state.ultimoPintado ? 'sube' : 'baja');
    }
    state.ultimoPintado = precio;

    // El cambio se mide desde que abrió ESTA vela: es de lo que va el bloque.
    const abierta = state.candles[state.candles.length - 1];
    const apertura = abierta && abierta.openTime === ventana.open ? abierta.open : null;
    if (apertura > 0) {
      const cambio = (precio - apertura) / apertura;
      el.priceChange.textContent = `${cambio >= 0 ? '+' : ''}${formatPercent(cambio, 2)} en esta vela`;
      el.priceChange.className = `change ${cambio >= 0 ? 'up' : 'down'}`;
    } else {
      el.priceChange.textContent = '';
    }
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

  // Los niveles de ruptura y el seguimiento entran en la escala: un nivel
  // fuera de pantalla no sirve de nada.
  const extras = [];
  const b = state.breakout;
  if (b && b.ok) {
    if (b.up) extras.push(b.up.level);
    if (b.down) extras.push(b.down.level);
  }
  const position = state.alerts.positions[pairKey()];
  if (position) extras.push(position.stop, position.target);

  for (const value of extras) {
    if (Number.isFinite(value) && value < maxPrice * 1.08 && value > minPrice * 0.92) {
      maxPrice = Math.max(maxPrice, value);
      minPrice = Math.min(minPrice, value);
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

  // Niveles de ruptura y, si hay seguimiento, stop y objetivo.
  if (b && b.ok) {
    if (b.up) drawLevel(b.up.level, '#f87171', 'R', yFor, plotW);
    if (b.down) drawLevel(b.down.level, '#4ade80', 'S', yFor, plotW);
  }
  if (position) {
    drawLevel(position.stop, '#fb7185', 'STOP', yFor, plotW, true);
    drawLevel(position.target, '#38bdf8', 'OBJ', yFor, plotW, true);
  }

  const last = candles[candles.length - 1];
  drawPriceTag(last.close, last.close >= last.open ? '#22c55e' : '#ef4444', plotW, yFor);

  if (state.hover !== null) drawCrosshair(xFor, plotH);
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

function drawLevel(price, color, tag, yFor, plotW, dense = false) {
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

  const label = formatPrice(price);
  ctx.font = 'bold 11px system-ui, sans-serif';
  const width = ctx.measureText(label).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(PAD.left + plotW + 2, y - 8, width, 16);
  ctx.fillStyle = '#020617';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, PAD.left + plotW + 7, y);
}

function drawCrosshair(xFor, plotH) {
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
    cell.title = `EMA${fast} ${formatPrice(f)} vs EMA${slow} ${formatPrice(s)} (${gap >= 0 ? '+' : ''}${formatPercent(gap, 2)})`;
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

// El panel se reconstruye entero en cada repintado, y eso cerraba de golpe el
// desplegable que el usuario acabara de abrir: con el precio en vivo llegando
// varias veces por segundo, «Contexto» era imposible de leer. Se apunta qué
// estaba abierto y se restaura.
function seccionesAbiertas() {
  const previos = el.breakout.querySelectorAll('details[data-k]');
  return {
    primera: previos.length === 0,
    claves: new Set([...previos].filter((d) => d.open).map((d) => d.dataset.k)),
  };
}

function restaurarSecciones({ primera, claves }) {
  if (primera) return; // la primera vez mandan los `open` del marcado
  for (const d of el.breakout.querySelectorAll('details[data-k]')) d.open = claves.has(d.dataset.k);
}

let ultimoBreakout = 0;

function renderBreakout({ force = false } = {}) {
  const b = state.breakout;

  // Reconstruir este panel es caro y llegan hasta diez precios por segundo;
  // tres repintados por segundo ya se ven fluidos.
  const ahora = Date.now();
  if (!force && b && b.ok && ahora - ultimoBreakout < 330) return;
  ultimoBreakout = ahora;

  if (!b || !b.ok) {
    el.breakout.innerHTML = `<p class="muted">${b ? b.reason : 'Calculando…'}</p>`;
    return;
  }

  const price = precioActual() || b.price;
  const now = Date.now();
  // El reloj manda sobre el payload, que puede tener uno o dos minutos.
  const ventana = ventanaActual(now);
  const remaining = ventana ? clamp(ventana.remainingMs / intervalToMs(state.interval), 0.01, 1) : 0.01;

  const up = liveSide(b.up, b.sample.up, price, b.atr, remaining);
  const down = liveSide(b.down, b.sample.down, price, b.atr, remaining);

  const bias = verdictFor(up, down, remaining);
  const abiertas = seccionesAbiertas();

  el.breakout.innerHTML = `
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

  restaurarSecciones(abiertas);
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
    state.ultimoPintado = null;
    state.breakout = null;
    state.alerts.primed = false; // par nuevo: no se grita por lo que ya había pasado
    connectStream();
    renderAlertHint();
  }
  loadAll();
}

function init() {
  loadPrefs();
  loadMercados();
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

  el.alertToggle.addEventListener('change', () => setAlerts(el.alertToggle.checked));
  el.alertMode.addEventListener('change', () => {
    state.alerts.operativa = el.alertMode.value;
    savePrefs();
    renderAlertHint();
    evaluateAlerts({ force: true });
  });

  el.avisoToggle.addEventListener('change', () => {
    state.alerts.avisosPrevios = el.avisoToggle.checked;
    savePrefs();
    evaluateAlerts({ force: true });
  });
  el.alertTest.addEventListener('click', testAlert);
  el.modal.addEventListener('click', (e) => {
    if (e.target === el.modal) hideModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideModal();
  });

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
      if (!state.alerts.enabled) clearTimeout(state.refreshTimer);
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

  el.alertToggle.checked = state.alerts.enabled;
  el.alertMode.value = state.alerts.operativa;
  el.avisoToggle.checked = state.alerts.avisosPrevios;
  if (state.alerts.enabled) {
    unlockAudio();
    armarAudioConPrimerGesto();
  }
  renderAlertHint();
  renderAlerts();

  loadSymbols();
  connectStream();
  loadAll();
  loadConsolidado();
  programarConsolidado();
}

document.addEventListener('DOMContentLoaded', init);
})();
