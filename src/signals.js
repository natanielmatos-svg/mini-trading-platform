'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren `const API` se pisan y el segundo
// no llega a definirse.
(function () {
// Motor de señales: cuándo entrar y cuándo salir.
//
// Traduce el análisis de ruptura a tres cosas accionables —aviso, entrada y
// salida— siguiendo al pie de la letra la regla que el propio análisis define:
// **una ruptura sólo cuenta si la vela CIERRA al otro lado del nivel y con
// volumen**. Un pico que toca el nivel y vuelve dentro es un rechazo, y actuar
// sobre él es la forma más habitual de perder dinero con este tipo de sistema.
//
// Cuatro decisiones de diseño:
//
//   1. La función es pura: recibe velas, análisis y posición, y devuelve
//      señales y posición nueva. No guarda estado, no hace ruido, no toca el
//      DOM. Así se puede probar en Node y ejecutar en el navegador con cada
//      tick del WebSocket, que es exactamente lo que hace la interfaz.
//   2. Los niveles se buscan sobre el histórico ANTERIOR a la vela que rompe.
//      Si se usaran los de ahora, después de una ruptura el nivel roto ya no
//      aparece como resistencia y no habría forma de detectar nada.
//   3. La posición que devuelve es un seguimiento en papel. Esto no manda
//      órdenes a ningún sitio ni sabe cuánto dinero tienes.
//   4. Cada señal trae un `id` determinista para que quien avisa pueda no
//      repetirse: la misma ruptura evaluada cien veces es una sola alerta.
//
// Es análisis técnico, no una recomendación de inversión.

const I = typeof module !== 'undefined' && module.exports ? require('./indicators') : globalThis.Indicators;
const F = typeof module !== 'undefined' && module.exports ? require('./format') : globalThis.Format;

const DEFAULTS = {
  volumeFactor: 1.3,     // volumen mínimo de la vela que rompe, sobre la media de 20
  warnProbability: 0.7,  // a partir de aquí se avisa de que la ruptura es inminente
  stopBufferAtr: 0.1,    // margen bajo el mínimo de la vela que rompe
  minClosed: 40,         // velas cerradas mínimas para opinar
};

function pctChange(from, to) {
  return from > 0 ? (to - from) / from : 0;
}

function ratio(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return risk > 0 ? reward / risk : null;
}

// Nivel más cercano por delante para fijar el objetivo. Se busca sobre el
// histórico SIN la vela que rompe: su propio máximo no es un nivel, es donde
// acabamos de llegar, y tomarlo como objetivo daría un recorrido de cero.
function targetFor(side, levelsSource, entry, atr, stop) {
  const { resistance, support } = I.findLevels(levelsSource, entry, atr * 0.35);
  const natural = side === 'larga' ? resistance : support;
  const valid = natural && (side === 'larga' ? natural.price > entry : natural.price < entry);

  // Sin nivel por delante (subida libre), el objetivo es dos veces el riesgo:
  // una convención, y se dice que lo es.
  if (valid) return { price: natural.price, source: 'nivel' };
  const risk = Math.abs(entry - stop);
  return { price: side === 'larga' ? entry + 2 * risk : entry - 2 * risk, source: 'doble del riesgo' };
}

function buildEntry({ side, breaker, level, levelsSource, atr, symbol, interval, volumeRatio, now }) {
  const entry = breaker.close;
  const stop =
    side === 'larga'
      ? Math.min(breaker.low, level) - atr * DEFAULTS.stopBufferAtr
      : Math.max(breaker.high, level) + atr * DEFAULTS.stopBufferAtr;

  const target = targetFor(side, levelsSource, entry, atr, stop);
  const rr = ratio(entry, stop, target.price);
  const largo = side === 'larga';

  const position = {
    side,
    symbol,
    interval,
    entry,
    stop,
    target: target.price,
    targetSource: target.source,
    level,
    openedAt: now,
    candleTime: breaker.openTime,
    rewardRisk: rr,
  };

  const signal = {
    id: `entrada-${side}-${breaker.openTime}`,
    type: 'entrada',
    action: `entrada_${side}`,
    side,
    sound: 'entrada',
    symbol,
    interval,
    candleTime: breaker.openTime,
    at: now,
    price: entry,
    level,
    stop,
    target: target.price,
    rewardRisk: rr,
    title: `Entrada ${largo ? 'larga' : 'corta'} · ${symbol} ${interval}`,
    message:
      `La vela de ${interval} cerró en ${F.formatPrice(entry)}, ${largo ? 'por encima de la resistencia' : 'por debajo del soporte'} ` +
      `${F.formatPrice(level)}${volumeRatio ? `, con ${F.num(volumeRatio)}× el volumen medio` : ''}. ` +
      'Es la confirmación que pedía el análisis: cierre, no toque.',
    detail:
      `Stop ${F.formatPrice(stop)} (${F.formatPercent(Math.abs(pctChange(entry, stop)), 2)}) · ` +
      `objetivo ${F.formatPrice(target.price)} (${F.formatPercent(Math.abs(pctChange(entry, target.price)), 2)}, ${target.source}) · ` +
      `ratio ${rr ? `${F.num(rr)}:1` : '—'}`,
  };

  return { position, signal };
}

function buildExit({ position, reason, price, now, extra = '' }) {
  const largo = position.side === 'larga';
  const cambio = largo ? pctChange(position.entry, price) : pctChange(price, position.entry);

  const textos = {
    stop: {
      title: `Salida: stop · ${position.symbol} ${position.interval}`,
      message:
        `El precio volvió a ${F.formatPrice(price)}, ${largo ? 'por debajo del' : 'por encima del'} stop ` +
        `${F.formatPrice(position.stop)}. La ruptura no aguantó.`,
    },
    objetivo: {
      title: `Salida: objetivo · ${position.symbol} ${position.interval}`,
      message: `El precio alcanzó ${F.formatPrice(position.target)}, el objetivo fijado al entrar.`,
    },
    trampa: {
      title: `Salida: ruptura falsa · ${position.symbol} ${position.interval}`,
      message:
        `Una vela cerró de vuelta ${largo ? 'por debajo de' : 'por encima de'} ${F.formatPrice(position.level)}, ` +
        'el nivel que se había roto. Es la trampa clásica: el nivel se recupera y el movimiento se deshace.',
    },
    contraria: {
      title: `Salida: señal contraria · ${position.symbol} ${position.interval}`,
      message: `Se confirmó una ruptura ${largo ? 'bajista' : 'alcista'} con la posición abierta. ${extra}`.trim(),
    },
  };

  const t = textos[reason];

  return {
    id: `salida-${reason}-${position.openedAt}`,
    type: 'salida',
    action: `salida_${reason}`,
    side: position.side,
    sound: 'salida',
    symbol: position.symbol,
    interval: position.interval,
    at: now,
    price,
    entry: position.entry,
    change: cambio,
    title: t.title,
    message: t.message,
    detail:
      `Entrada ${F.formatPrice(position.entry)} → salida ${F.formatPrice(price)} · ` +
      `${cambio >= 0 ? '+' : ''}${F.formatPercent(cambio, 2)} en el seguimiento`,
  };
}

function buildWarning({ side, breakoutSide, breakout, symbol, interval, candleTime, now }) {
  const largo = side === 'larga';
  return {
    id: `aviso-${side}-${candleTime}`,
    type: 'aviso',
    action: `aviso_${largo ? 'alza' : 'baja'}`,
    side,
    sound: 'aviso',
    symbol,
    interval,
    candleTime,
    at: now,
    price: breakout.price,
    level: breakoutSide.level,
    probability: breakoutSide.probability,
    title: `Aviso: ruptura ${largo ? 'al alza' : 'a la baja'} cerca · ${symbol} ${interval}`,
    message:
      `${F.formatPercent(breakoutSide.probability, 0)} de probabilidad de alcanzar ${F.formatPrice(breakoutSide.level)} ` +
      `antes de que cierre la vela (quedan ${breakout.candle.remainingLabel}).`,
    detail: 'Todavía no es una entrada: hace falta que la vela cierre al otro lado del nivel y con volumen.',
  };
}

/**
 * Evalúa el estado actual y devuelve las señales que corresponden.
 *
 * @param candles   velas del timeframe, la última en formación
 * @param breakout  respuesta de /api/breakout (opcional: sólo se usa para avisos)
 * @param position  seguimiento abierto, o null
 * @param price     precio en vivo; si falta, el cierre de la vela en curso
 * @returns {{signals: Array, position: Object|null}}
 */
function evaluateSignals({
  candles,
  breakout = null,
  position = null,
  price = null,
  symbol = '',
  interval = '',
  now = Date.now(),
  options = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const signals = [];

  if (!Array.isArray(candles) || candles.length < cfg.minClosed) return { signals, position };

  const closed = candles.filter((c) => c.closed);
  if (closed.length < cfg.minClosed) return { signals, position };

  const breaker = closed[closed.length - 1];      // última vela cerrada
  const history = closed.slice(0, -1);            // lo que se sabía antes de ella
  const atrs = I.atrSeries(history, 14);
  const atr = atrs[atrs.length - 1];
  if (!(atr > 0)) return { signals, position };

  const current = candles[candles.length - 1];
  const livePrice = Number.isFinite(price) && price > 0 ? price : current.close;

  const volumes = history.slice(-20).map((c) => c.volume);
  const avgVolume = I.sma(volumes, 20);
  const volumeRatio = avgVolume > 0 && Number.isFinite(breaker.volume) ? breaker.volume / avgVolume : null;
  // Sin datos de volumen no se bloquea la señal: se informa de que no se pudo
  // comprobar, que es distinto de que el volumen sea malo.
  const volumeOk = volumeRatio === null || volumeRatio >= cfg.volumeFactor;

  const { resistance, support } = I.findLevels(history, history[history.length - 1].close, atr * 0.35);

  const rompeArriba = Boolean(resistance && breaker.close > resistance.price && volumeOk);
  const rompeAbajo = Boolean(support && breaker.close < support.price && volumeOk);

  // --- Salidas primero: con una posición abierta, lo urgente es cerrarla -----
  if (position) {
    const largo = position.side === 'larga';
    let exit = null;

    if (largo ? livePrice <= position.stop : livePrice >= position.stop) {
      exit = buildExit({ position, reason: 'stop', price: livePrice, now });
    } else if (largo ? livePrice >= position.target : livePrice <= position.target) {
      exit = buildExit({ position, reason: 'objetivo', price: livePrice, now });
    } else if (
      breaker.openTime > position.candleTime &&
      (largo ? breaker.close < position.level : breaker.close > position.level)
    ) {
      exit = buildExit({ position, reason: 'trampa', price: breaker.close, now });
    } else if (largo ? rompeAbajo : rompeArriba) {
      exit = buildExit({
        position,
        reason: 'contraria',
        price: breaker.close,
        now,
        extra: `Nivel roto: ${F.formatPrice(largo ? support.price : resistance.price)}.`,
      });
    }

    if (exit) return { signals: [exit], position: null };
    return { signals, position };
  }

  // --- Entradas -------------------------------------------------------------
  if (rompeArriba) {
    const { position: nueva, signal } = buildEntry({
      side: 'larga', breaker, level: resistance.price, levelsSource: history, atr, symbol, interval, volumeRatio, now,
    });
    return { signals: [signal], position: nueva };
  }

  if (rompeAbajo) {
    const { position: nueva, signal } = buildEntry({
      side: 'corta', breaker, level: support.price, levelsSource: history, atr, symbol, interval, volumeRatio, now,
    });
    return { signals: [signal], position: nueva };
  }

  // --- Aviso previo ---------------------------------------------------------
  if (breakout && breakout.ok) {
    const arriba = breakout.up;
    const abajo = breakout.down;

    if (arriba && arriba.probability >= cfg.warnProbability) {
      signals.push(buildWarning({ side: 'larga', breakoutSide: arriba, breakout, symbol, interval, candleTime: current.openTime, now }));
    } else if (abajo && abajo.probability >= cfg.warnProbability) {
      signals.push(buildWarning({ side: 'corta', breakoutSide: abajo, breakout, symbol, interval, candleTime: current.openTime, now }));
    }
  }

  return { signals, position };
}

const API = { evaluateSignals, DEFAULTS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Signals = API;
})();
