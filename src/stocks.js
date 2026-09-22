'use strict';

// Acciones: catálogo, velas, precio y reloj de mercado.
//
// Es la capa que hay entre las rutas y Alpaca, y existe por tres cosas que el
// adaptador no debe saber:
//
//   1. **Qué tickers se ofrecen.** Hay miles; el desplegable lleva los que
//      alguien querría mirar, igual que con las criptos.
//   2. **El modo demo.** Sin clave de Alpaca la página se quedaría en blanco,
//      que es la peor forma de explicar que falta una clave. Con datos
//      sintéticos se ve funcionando y el aviso dice qué falta.
//   3. **La sesión.** La bolsa cierra, y una vela de las 3 de la mañana no
//      existe. En demo se recortan las velas fuera de sesión a mano; con
//      clave lo resuelve el propio calendario de Alpaca.

const alpaca = require('./alpaca');
const { buildDemoCandles, intervalMs } = require('./klines');

// Bolsa estadounidense en horario regular: 9:30–16:00 hora de Nueva York. Se
// usa `Intl` con la zona y no un desfase fijo porque el horario de verano
// mueve la sesión dos veces al año.
const APERTURA_MIN = 9 * 60 + 30;
const CIERRE_MIN = 16 * 60;

const CATALOG = [
  { symbol: 'AAPL', name: 'Apple', group: 'Grandes tecnológicas' },
  { symbol: 'MSFT', name: 'Microsoft', group: 'Grandes tecnológicas' },
  { symbol: 'NVDA', name: 'NVIDIA', group: 'Grandes tecnológicas' },
  { symbol: 'AMZN', name: 'Amazon', group: 'Grandes tecnológicas' },
  { symbol: 'GOOGL', name: 'Alphabet (clase A)', group: 'Grandes tecnológicas' },
  { symbol: 'META', name: 'Meta', group: 'Grandes tecnológicas' },
  { symbol: 'TSLA', name: 'Tesla', group: 'Grandes tecnológicas' },
  { symbol: 'AVGO', name: 'Broadcom', group: 'Grandes tecnológicas' },

  { symbol: 'AMD', name: 'AMD', group: 'Semiconductores' },
  { symbol: 'INTC', name: 'Intel', group: 'Semiconductores' },
  { symbol: 'MU', name: 'Micron', group: 'Semiconductores' },
  { symbol: 'QCOM', name: 'Qualcomm', group: 'Semiconductores' },
  { symbol: 'ARM', name: 'Arm Holdings', group: 'Semiconductores' },

  { symbol: 'JPM', name: 'JPMorgan Chase', group: 'Banca y finanzas' },
  { symbol: 'BAC', name: 'Bank of America', group: 'Banca y finanzas' },
  { symbol: 'GS', name: 'Goldman Sachs', group: 'Banca y finanzas' },
  { symbol: 'V', name: 'Visa', group: 'Banca y finanzas' },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway (B)', group: 'Banca y finanzas' },
  { symbol: 'COIN', name: 'Coinbase', group: 'Banca y finanzas' },

  { symbol: 'XOM', name: 'ExxonMobil', group: 'Energía e industria' },
  { symbol: 'CVX', name: 'Chevron', group: 'Energía e industria' },
  { symbol: 'CAT', name: 'Caterpillar', group: 'Energía e industria' },
  { symbol: 'BA', name: 'Boeing', group: 'Energía e industria' },

  { symbol: 'JNJ', name: 'Johnson & Johnson', group: 'Salud y consumo' },
  { symbol: 'LLY', name: 'Eli Lilly', group: 'Salud y consumo' },
  { symbol: 'UNH', name: 'UnitedHealth', group: 'Salud y consumo' },
  { symbol: 'KO', name: 'Coca-Cola', group: 'Salud y consumo' },
  { symbol: 'WMT', name: 'Walmart', group: 'Salud y consumo' },
  { symbol: 'COST', name: 'Costco', group: 'Salud y consumo' },

  { symbol: 'SPY', name: 'S&P 500 (SPY)', group: 'Índices (ETF)' },
  { symbol: 'QQQ', name: 'Nasdaq 100 (QQQ)', group: 'Índices (ETF)' },
  { symbol: 'IWM', name: 'Russell 2000 (IWM)', group: 'Índices (ETF)' },
  { symbol: 'DIA', name: 'Dow Jones (DIA)', group: 'Índices (ETF)' },
  { symbol: 'GLD', name: 'Oro (GLD)', group: 'Índices (ETF)' },
];

const TICKERS = new Set(CATALOG.map((s) => s.symbol));

function listStocks() {
  return CATALOG.map((s) => ({ ...s }));
}

function stockGroups() {
  const orden = [];
  const porGrupo = new Map();
  for (const s of CATALOG) {
    if (!porGrupo.has(s.group)) {
      porGrupo.set(s.group, []);
      orden.push(s.group);
    }
    porGrupo.get(s.group).push({ symbol: s.symbol, name: s.name });
  }
  return orden.map((name) => ({ name, symbols: porGrupo.get(name) }));
}

// El ticker pedido sólo se acepta si está en el catálogo. No es paranoia con
// Alpaca —su API valida— sino que un ticker inventado gasta una llamada y
// devuelve un error críptico; así el error lo da el servidor y es claro.
function parseTicker(raw, fallback = 'AAPL') {
  const limpio = alpaca.parseSymbol(raw, fallback);
  return TICKERS.has(limpio) ? limpio : fallback;
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

const FORMATO_NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Minutos desde medianoche y día de la semana, en Nueva York.
function horaNuevaYork(ms) {
  const partes = {};
  for (const p of FORMATO_NY.formatToParts(new Date(ms))) partes[p.type] = p.value;
  // A medianoche `en-US` con hour12:false devuelve 24 en algunas versiones.
  const hora = Number(partes.hour) % 24;
  return { dia: DIAS[partes.weekday], minutos: hora * 60 + Number(partes.minute) };
}

// Sin festivos: el calendario de festivos bursátiles cambia cada año y
// mantenerlo a mano es una fuente de errores silenciosos. Con clave de Alpaca
// esto no se usa —manda su reloj—, y en demo un festivo de más no importa.
function enSesion(ms) {
  const { dia, minutos } = horaNuevaYork(ms);
  if (dia === 0 || dia === 6) return false;
  return minutos >= APERTURA_MIN && minutos < CIERRE_MIN;
}

// Reloj de mercado sintético para el modo demo, con la misma forma que el de
// Alpaca. La siguiente apertura y el siguiente cierre se buscan avanzando a
// saltos de cinco minutos: son como mucho unos cientos de pasos y evita
// replicar la aritmética de calendario.
function relojDemo(now = Date.now()) {
  const abierto = enSesion(now);
  const PASO = 5 * 60_000;
  let siguienteApertura = null;
  let siguienteCierre = null;

  // La búsqueda arranca en una frontera de cinco minutos y no en `now`: si no,
  // la apertura sale a las 9:32 porque hereda los segundos del instante en que
  // se preguntó. Nueva York está a un número entero de horas de UTC, así que
  // una frontera de cinco minutos en UTC lo es también allí.
  const inicio = Math.floor(now / PASO) * PASO + PASO;

  for (let t = inicio, i = 0; i < 4 * 24 * 12 * 5; t += PASO, i++) {
    const dentro = enSesion(t);
    if (dentro && siguienteApertura === null && !abierto) siguienteApertura = t;
    if (!dentro && siguienteCierre === null && abierto) siguienteCierre = t;
    if ((abierto && siguienteCierre !== null) || (!abierto && siguienteApertura !== null)) break;
  }

  return { isOpen: abierto, now, nextOpen: siguienteApertura, nextClose: siguienteCierre, source: 'demo' };
}

async function getClock({ demo = false, now = Date.now() } = {}) {
  if (demo || !alpaca.hayClave()) return relojDemo(now);
  const reloj = await alpaca.fetchClock();
  return { ...reloj, source: 'alpaca' };
}

// ---------------------------------------------------------------------------
// Velas y precio
// ---------------------------------------------------------------------------

// Qué velas del generador genérico sobreviven al horario: las intradía tienen
// que caer dentro de la sesión, y las diarias en un día hábil. Las semanales
// no se filtran: una semana siempre contiene días de mercado.
function dentroDelHorario(openTime, step) {
  if (step < 86_400_000) return enSesion(openTime);
  if (step < 7 * 86_400_000) {
    const { dia } = horaNuevaYork(openTime + 15 * 3_600_000); // mediodía en NY
    return dia !== 0 && dia !== 6;
  }
  return true;
}

function velasDemo({ symbol, interval, limit, now }) {
  const step = intervalMs(interval);

  // Se generan de sobra porque al quitar la noche y el fin de semana cae la
  // mayor parte de las velas intradía: de 24 horas al día quedan seis y media,
  // y de siete días, cinco. Si aun así faltan, se amplía la ventana en vez de
  // devolver un gráfico corto; el tope evita generar cien mil velas si alguien
  // pide un intervalo raro.
  // Y con un suelo de cinco días naturales: pedir una sola vela de un minuto
  // un domingo no encontraría ninguna dentro de sesión, y el precio saldría
  // vacío justo cuando lo que toca enseñar es el cierre del viernes.
  const porSesion = Math.ceil(limit * (step < 86_400_000 ? (24 * 7) / (6.5 * 5) : 1.5));
  const cincoDias = Math.ceil((5 * 86_400_000) / step);
  let pedidas = Math.min(Math.max(porSesion, step < 86_400_000 ? cincoDias : 0), 20_000);

  for (let intento = 0; intento < 4; intento++) {
    const utiles = buildDemoCandles({ symbol, interval, limit: pedidas, now })
      .filter((c) => dentroDelHorario(c.openTime, step));
    if (utiles.length >= limit || pedidas >= 20_000) return utiles.slice(-limit);
    pedidas = Math.min(pedidas * 2, 20_000);
  }

  return [];
}

async function getStockCandles({ symbol, interval = '1h', limit = 400, demo = false, now = Date.now() } = {}) {
  const sym = parseTicker(symbol);
  const tf = alpaca.parseInterval(interval);

  if (demo || !alpaca.hayClave()) {
    return {
      symbol: sym,
      interval: tf,
      source: 'demo',
      fetchedAt: now,
      candles: velasDemo({ symbol: sym, interval: tf, limit, now }),
      aviso: alpaca.hayClave() ? null : SIN_CLAVE,
    };
  }

  // Se le pasa nuestro calendario: el adaptador no sabe cuándo abre la bolsa,
  // y las barras de horario extendido del feed gratuito son demasiado finas
  // para meterlas en un ATR.
  return alpaca.fetchCandles({ symbol: sym, interval: tf, limit, now, soloSesion: enSesion });
}

const SIN_CLAVE =
  'Datos de ejemplo: los precios de bolsa están licenciados y hacen falta ALPACA_KEY_ID y ALPACA_SECRET_KEY ' +
  '(la cuenta gratuita de Alpaca sirve). Mientras tanto el gráfico y el análisis funcionan con velas sintéticas.';

async function getStockQuote({ symbol, demo = false, now = Date.now() } = {}) {
  const sym = parseTicker(symbol);

  if (demo || !alpaca.hayClave()) {
    // El precio de demo sale de la vela de un minuto, no de la del gráfico: si
    // saliera de la de una hora, el "precio ahora" y el gráfico discreparían
    // en cuanto la vela larga llevara rato abierta. Con la bolsa cerrada esa
    // vela es la última de la sesión anterior, que es exactamente el último
    // precio que existe, y `at` lo fecha para que no parezca de ahora mismo.
    const [vela] = velasDemo({ symbol: sym, interval: '1m', limit: 1, now });
    const price = vela ? vela.close : null;
    const abierto = enSesion(now);

    return {
      symbol: sym, price, bid: price, ask: price,
      at: vela && !abierto ? vela.closeTime : now,
      sesion: abierto,
      feed: 'demo',
      aviso: alpaca.hayClave() ? null : SIN_CLAVE,
    };
  }

  // Con la bolsa cerrada no se pregunta al libro: fuera de sesión el feed
  // gratuito devuelve puntas de sesiones distintas, y el punto medio de eso no
  // es un precio. Se usa el cierre de la última vela, que es el último precio
  // que existió de verdad.
  const abierto = enSesion(now);
  if (abierto) {
    try {
      return { ...(await alpaca.fetchQuote({ symbol: sym })), sesion: true, fuente: 'libro' };
    } catch (err) {
      // Una horquilla imposible tampoco se cuela por estar el mercado abierto:
      // se cae al cierre igual, diciendo por qué.
      return { ...(await cierreDeLaUltimaVela(sym, now)), sesion: true, motivo: err.message };
    }
  }

  return { ...(await cierreDeLaUltimaVela(sym, now)), sesion: false, motivo: 'mercado cerrado: el libro fuera de sesión no es un precio' };
}

// El último precio que existió: el cierre de la última vela de un minuto
// dentro de sesión. Una llamada más, y sólo cuando el libro no sirve.
async function cierreDeLaUltimaVela(symbol, now) {
  const { candles } = await alpaca.fetchCandles({ symbol, interval: '1m', limit: 1, now, soloSesion: enSesion });
  const vela = candles[candles.length - 1];
  if (!vela) throw new Error(`No hay ninguna vela reciente de ${symbol} con la que fechar un precio`);

  return { symbol, price: vela.close, bid: null, ask: null, at: vela.closeTime, feed: alpaca.FEED, fuente: 'cierre' };
}

module.exports = {
  CATALOG, SIN_CLAVE, cierreDeLaUltimaVela, listStocks, stockGroups, parseTicker,
  enSesion, horaNuevaYork, relojDemo, getClock, getStockCandles, getStockQuote, velasDemo,
};
