'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren lo mismo se pisan.
(function () {

// Avisos de compra y venta: sonido, ventana emergente, notificación del
// sistema, seguimiento en papel e historial.
//
// El motor de señales (signals.js) decide QUÉ avisar; esto es todo lo demás:
// cuándo suena, qué se ve y qué se recuerda entre recargas. Sale de app.js
// porque la página de acciones necesita exactamente lo mismo —una ruptura de
// Apple se avisa igual que una de bitcoin— y son cuatrocientas líneas que no
// pueden vivir por duplicado.
//
// No conoce ninguna página: se le pasan los elementos del DOM y una función
// `datos()` que devuelve el estado del momento (velas, análisis, precio,
// símbolo, intervalo). Cada página guarda sus preferencias bajo su propia
// clave, así que los avisos de cripto y los de bolsa no se pisan.

const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;
const S = typeof module !== 'undefined' && module.exports ? require('./signals') : globalThis.Signals;
const { formatPrice, formatPercent, num } = F;
const { evaluateSignals } = S;

// El sonido se sintetiza: dos notas ascendentes para comprar, dos
// descendentes para vender, dos iguales para el aviso previo. Sin archivos que
// cargar, y se distinguen sin mirar la pantalla, que es el sentido de que suene.
const PATTERNS = {
  compra: [{ freq: 660, at: 0, dur: 0.12 }, { freq: 990, at: 0.13, dur: 0.22 }],
  venta: [{ freq: 780, at: 0, dur: 0.12 }, { freq: 440, at: 0.13, dur: 0.28 }],
  aviso: [{ freq: 880, at: 0, dur: 0.09 }, { freq: 880, at: 0.16, dur: 0.09 }],
};

const ETIQUETA = { compra: 'COMPRAR', venta: 'VENDER', aviso: 'AVISO' };

// Se evalúa con cada tick, así que se limita a una vez por segundo: buscar
// pivotes sobre 300 velas diez veces por segundo no aporta nada.
const EVAL_THROTTLE_MS = 1000;

const fmtHora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Crea el gestor de avisos de una página.
 *
 * @param elementos  { toggle, test, mode, avisoToggle, hint, position, history, modal, modalCard }
 * @param claveAlmacen  dónde se guardan las preferencias en localStorage
 * @param datos  () => { candles, breakout, price, symbol, interval }
 * @param onCambio  se llama cuando cambia una preferencia (para reprogramar
 *                  el refresco: con avisos encendidos interesa más frecuencia)
 * @param nombreActivo  cómo se llama lo que se sigue, para los textos
 */
function crearAvisos({ elementos, claveAlmacen, datos, onCambio = () => {}, nombreActivo = 'el activo' }) {
  const el = elementos;

  const estado = {
    enabled: false,
    operativa: 'contado',   // 'contado' (comprar/vender) | 'ambos' (además, cortos)
    // Apagado por defecto: medido sobre histórico, el aviso previo salta unas
    // dos o tres veces al día. Quien quiera vigilar la aproximación lo
    // enciende; quien sólo quiera saber cuándo comprar y vender, no.
    avisosPrevios: false,
    primed: false,          // la primera evaluación no suena: sería una alerta de algo ya pasado
    seen: new Set(),
    history: [],
    positions: {},          // 'AAPL|1h' -> seguimiento en papel
    audio: null,
    lastEval: 0,
  };

  const clave = () => {
    const d = datos();
    return `${d.symbol}|${d.interval}`;
  };

  // --- Preferencias (localStorage es opcional: en modo privado lanza) ------

  function cargar() {
    try {
      const raw = localStorage.getItem(claveAlmacen);
      if (!raw) return;
      const saved = JSON.parse(raw);
      estado.enabled = Boolean(saved.enabled);
      if (saved.operativa === 'ambos' || saved.operativa === 'contado') estado.operativa = saved.operativa;
      estado.avisosPrevios = Boolean(saved.avisosPrevios);
      estado.positions = saved.positions && typeof saved.positions === 'object' ? saved.positions : {};
    } catch {
      /* sin persistencia se sigue funcionando, sólo se olvida entre recargas */
    }
  }

  function guardar() {
    try {
      localStorage.setItem(claveAlmacen, JSON.stringify({
        enabled: estado.enabled,
        operativa: estado.operativa,
        avisosPrevios: estado.avisosPrevios,
        positions: estado.positions,
      }));
    } catch {
      /* idem */
    }
  }

  // --- Sonido --------------------------------------------------------------

  // El navegador no deja sonar sin un gesto previo del usuario. El contexto se
  // puede crear en cualquier momento, pero nace suspendido y hay que reanudarlo
  // desde un gesto. Al volver a la página con los avisos ya encendidos no hay
  // ningún gesto todavía, así que se deja armado un `resume` para el primer
  // clic o tecla que llegue: sin esto, quien dejó los avisos puestos ayer se
  // encontraba hoy con alertas mudas.
  function unlockAudio() {
    if (!estado.audio) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        estado.audio = new Ctor();
      } catch {
        return; // sin audio los avisos siguen saliendo en pantalla
      }
    }
    if (estado.audio.state === 'suspended') {
      estado.audio.resume().then(renderHint).catch(() => {});
    }
  }

  function armarAudioConPrimerGesto() {
    const activar = () => {
      unlockAudio();
      renderHint();
    };
    document.addEventListener('pointerdown', activar, { once: true });
    document.addEventListener('keydown', activar, { once: true });
  }

  function playSound(kind) {
    if (!estado.audio) unlockAudio();
    const audio = estado.audio;
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
      // `tag` con el id de la señal: si llega dos veces, el sistema la
      // sustituye en vez de apilar dos globos iguales.
      new Notification(signal.title, { body: `${signal.message}\n${signal.detail}`, tag: signal.id });
    } catch {
      /* algunos navegadores exigen service worker; el popout de la página queda */
    }
  }

  // --- Ventana emergente ---------------------------------------------------

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
        <button class="alert-ok">Entendido</button>
        <button class="alert-mute ghost">Silenciar avisos</button>
      </div>
      <p class="disclaimer">Análisis técnico automático sobre datos públicos. No es una recomendación de inversión.</p>`;

    el.modal.classList.add('open');
    const ok = el.modalCard.querySelector('.alert-ok');
    el.modalCard.querySelector('.alert-mute').addEventListener('click', () => {
      setEnabled(false);
      hideModal();
    });
    ok.addEventListener('click', hideModal);
    ok.focus();
  }

  function hideModal() {
    el.modal.classList.remove('open');
  }

  // --- Señales -------------------------------------------------------------

  function pushSignal(signal, { silent = false } = {}) {
    estado.seen.add(signal.id);
    estado.history.unshift({ ...signal, silent });
    estado.history = estado.history.slice(0, 20);

    if (!silent && estado.enabled) {
      playSound(signal.sound);
      notify(signal);
      showModal(signal);
    }
    render();
  }

  function evaluar({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - estado.lastEval < EVAL_THROTTLE_MS) return;
    estado.lastEval = now;

    const d = datos();
    if (!d.candles || !d.candles.length) return;

    const key = `${d.symbol}|${d.interval}`;
    const { signals, position } = evaluateSignals({
      candles: d.candles,
      breakout: d.breakout,
      position: estado.positions[key] || null,
      price: d.price,
      symbol: d.symbol,
      interval: d.interval,
      now,
      options: { operativa: estado.operativa, avisosPrevios: estado.avisosPrevios },
    });

    if (position) estado.positions[key] = position;
    else delete estado.positions[key];

    // La primera evaluación tras cargar la página no suena: avisar a gritos de
    // una ruptura que ocurrió antes de abrir el navegador es ruido, no una
    // alerta. Queda en el historial marcada como anterior.
    const primera = !estado.primed;
    estado.primed = true;

    for (const signal of signals) {
      if (estado.seen.has(signal.id)) continue;
      pushSignal(signal, { silent: primera });
    }

    if (signals.length || primera) guardar();
    render();
  }

  function setEnabled(enabled) {
    estado.enabled = enabled;
    el.toggle.checked = enabled;

    if (enabled) {
      unlockAudio();
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(renderHint);
      }
    }

    guardar();
    renderHint();
    onCambio();
  }

  // --- Pintado -------------------------------------------------------------

  function renderHint() {
    if (!estado.enabled) {
      el.hint.textContent = 'Apagados. Sin sonido ni ventana emergente.';
      return;
    }
    const permiso = 'Notification' in window ? Notification.permission : 'no soportado';
    const fuera =
      permiso === 'granted'
        ? 'También avisa fuera de la pestaña.'
        : permiso === 'denied'
          ? 'El navegador bloqueó las notificaciones: sólo avisa con la pestaña abierta.'
          : 'Acepta las notificaciones para que avise fuera de la pestaña.';

    const audio = estado.audio;
    const sonido = !audio
      ? ' Sonido sin inicializar.'
      : audio.state === 'suspended'
        ? ' El navegador espera un clic tuyo para poder sonar.'
        : '';

    const d = datos();
    const modo = estado.operativa === 'ambos' ? 'compra, venta y cortos' : 'compra y venta';
    el.hint.textContent = `Encendidos para ${d.symbol} ${d.interval} (${modo}). ${fuera}${sonido}`;
  }

  function render() {
    const d = datos();
    const position = estado.positions[clave()];

    if (!position) {
      el.position.innerHTML = `<p class="muted">Nada comprado ahora mismo. El seguimiento se abre solo cuando una vela confirma la señal de compra.</p>`;
    } else {
      const largo = position.side === 'larga';
      const ultima = d.candles && d.candles.length ? d.candles[d.candles.length - 1].close : null;
      const price = Number.isFinite(d.price) && d.price > 0 ? d.price : ultima || position.entry;
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
          <button class="ghost small position-drop">Descartar seguimiento</button>
        </div>`;

      el.position.querySelector('.position-drop').addEventListener('click', () => {
        delete estado.positions[clave()];
        guardar();
        render();
      });
    }

    el.history.innerHTML = estado.history.length
      ? estado.history
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
  function probar() {
    unlockAudio();
    const d = datos();
    showModal({
      type: 'compra',
      at: Date.now(),
      price: Number.isFinite(d.price) ? d.price : 0,
      title: `Prueba de aviso · ${d.symbol} ${d.interval}`,
      message: 'Si has oído dos notas ascendentes y ves esta ventana, los avisos funcionan.',
      detail: 'Las compras suenan ascendentes, las ventas descendentes y los avisos previos son dos notas iguales.',
    });
    playSound('compra');
    notify({ id: 'prueba', title: 'Prueba de aviso', message: 'Los avisos funcionan.', detail: '' });
  }

  // --- Arranque ------------------------------------------------------------

  function init() {
    cargar();

    el.toggle.checked = estado.enabled;
    el.mode.value = estado.operativa;
    el.avisoToggle.checked = estado.avisosPrevios;

    el.toggle.addEventListener('change', (e) => setEnabled(e.target.checked));
    el.test.addEventListener('click', probar);

    el.mode.addEventListener('change', (e) => {
      estado.operativa = e.target.value === 'ambos' ? 'ambos' : 'contado';
      guardar();
      renderHint();
      evaluar({ force: true });
    });

    el.avisoToggle.addEventListener('change', (e) => {
      estado.avisosPrevios = e.target.checked;
      guardar();
      evaluar({ force: true });
    });

    el.modal.addEventListener('click', (e) => {
      if (e.target === el.modal) hideModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideModal();
    });

    // El contexto de audio se crea ya, no al encender: quien recarga con los
    // avisos puestos no da ningún gesto nuevo y se quedaba sin sonido.
    if (estado.enabled) unlockAudio();
    armarAudioConPrimerGesto();

    renderHint();
    render();
  }

  return {
    init, evaluar, render, renderHint, setEnabled, probar, hideModal,
    posicion: () => estado.positions[clave()] || null,
    // Al cambiar de activo la siguiente evaluación vuelve a ser "la primera":
    // no se grita por una ruptura que ocurrió antes de mirarlo.
    olvidarPrimera: () => { estado.primed = false; },
    get enabled() { return estado.enabled; },
    get operativa() { return estado.operativa; },
    _estado: estado,
  };
}

const API = { crearAvisos, PATTERNS, ETIQUETA, EVAL_THROTTLE_MS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Avisos = API;
})();
