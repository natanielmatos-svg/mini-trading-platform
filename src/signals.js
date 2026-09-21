'use strict';

// Todo el módulo va dentro de una función. En Node da igual —cada archivo ya
// tiene su ámbito— pero en el navegador se carga con <script> y el ámbito es
// global: sin esto, dos módulos que declaren `const API` se pisan y el segundo
// no llega a definirse.
(function () {

// Motor de señales: cuándo comprar y cuándo vender.
//
// Traduce el análisis de ruptura a una instrucción concreta siguiendo al pie
// de la letra la regla que el propio análisis define: **una ruptura sólo
// cuenta si la vela CIERRA al otro lado del nivel y con volumen**. Un pico que
// toca el nivel y vuelve dentro es un rechazo, y comprar ahí es la forma más
// habitual de perder dinero con este tipo de sistema.
//
// Dos formas de operar, porque en contado no se puede vender lo que no se
// tiene:
//
//   contado (por defecto)  Compra cuando rompe al alza y vende cuando toca
//                          salir. Una ruptura bajista sin nada comprado no
//                          abre nada: se avisa como señal de venta para quien
//                          ya tenga la moneda, y de quedarse fuera para quien
//                          no.
//   ambos                  Además sigue las bajistas vendiendo en corto y
//                          recomprando para cerrar.
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
  volumeFactor: 1.3,       // volumen mínimo de la vela que rompe, sobre la media de 20
  warnProbability: 0.7,    // a partir de aquí se avisa de que la ruptura es inminente
  stopBufferAtr: 0.1,      // margen bajo el mínimo de la vela que rompe
  minRewardRisk: 1.5,      // un objetivo más cerca que esto no paga el riesgo
  minClosed: 40,           // velas cerradas mínimas para opinar
  operativa: 'contado',    // 'contado' | 'ambos'
  avisosPrevios: true,     // el aviso de "está a punto de romper"
};

// En largo se compra para abrir y se vende para cerrar; en corto es al revés.
// El sonido va con el verbo, no con el sentido de la operación: así "suena a
// venta" siempre que haya que vender, se esté abriendo o cerrando.
// `presente` no es un capricho: las frases lo necesitan conjugado ("aquí se
// vende"), y componerlas con el infinitivo en minúscula daba "aquí se vender".
const VERBOS = {
  larga: {
    abrir: { verbo: 'Comprar', presente: 'compra', tipo: 'compra', sonido: 'compra' },
    cerrar: { verbo: 'Vender', presente: 'vende', tipo: 'venta', sonido: 'venta' },
  },
  corta: {
    abrir: { verbo: 'Vender en corto', presente: 'vende en corto', tipo: 'venta', sonido: 'venta' },
    cerrar: { verbo: 'Recomprar', presente: 'recompra', tipo: 'compra', sonido: 'compra' },
  },
};

function moneda(symbol) {
  return String(symbol || '').replace(/(USDT|BUSD|USDC|FDUSD)$/, '') || symbol;
}

function pctChange(from, to) {
  return from > 0 ? (to - from) / from : 0;
}

function ratio(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return risk > 0 ? reward / risk : null;
}

// Objetivo: el primer nivel por delante que esté lo bastante lejos como para
// pagar el riesgo. Se busca sobre el histórico SIN la vela que rompe —su
// propio máximo no es un nivel, es donde acabamos de llegar—.
//
// El "lo bastante lejos" no es un adorno. Coger el nivel más cercano sin más
// producía, medido sobre histórico, un 89% de compras con ratio por debajo de
// 1:1 y una mediana de 0,52: arriesgar el doble de lo que se puede ganar, y
// alguna de 0,02, que es arriesgar cincuenta para ganar uno. Con eso se puede
// acertar dos de cada tres veces y perder dinero igual, que es exactamente lo
// que salía.
function targetFor(side, levelsSource, entry, atr, stop, minRewardRisk) {
  const niveles = I.findLevels(levelsSource, entry, atr * 0.35);
  const candidatos = side === 'larga' ? niveles.resistances : niveles.supports;
  const risk = Math.abs(entry - stop);
  const minimo = risk * minRewardRisk;

  for (const nivel of candidatos || []) {
    const delante = side === 'larga' ? nivel.price > entry : nivel.price < entry;
    if (delante && Math.abs(nivel.price - entry) >= minimo) {
      return { price: nivel.price, source: 'nivel' };
    }
  }

  // Ningún nivel por delante que pague el riesgo: el objetivo es dos veces el
  // riesgo. Es una convención, y se dice que lo es.
  return { price: side === 'larga' ? entry + 2 * risk : entry - 2 * risk, source: 'doble del riesgo' };
}

function buildOpen({ side, breaker, level, levelsSource, atr, symbol, interval, volumeRatio, now, minRewardRisk = DEFAULTS.minRewardRisk }) {
  const entry = breaker.close;
  const largo = side === 'larga';
  const v = VERBOS[side].abrir;

  const stop = largo
    ? Math.min(breaker.low, level) - atr * DEFAULTS.stopBufferAtr
    : Math.max(breaker.high, level) + atr * DEFAULTS.stopBufferAtr;

  const target = targetFor(side, levelsSource, entry, atr, stop, minRewardRisk);
  const rr = ratio(entry, stop, target.price);

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

  const cerrar = VERBOS[side].cerrar;

  const signal = {
    id: `${v.tipo === 'compra' ? 'comprar' : 'vender'}-${side}-${breaker.openTime}`,
    type: v.tipo,
    action: largo ? 'comprar' : 'vender_corto',
    side,
    sound: v.sonido,
    symbol,
    interval,
    candleTime: breaker.openTime,
    at: now,
    price: entry,
    level,
    stop,
    target: target.price,
    rewardRisk: rr,
    title: `${v.verbo} ${symbol} · ${interval}`,
    message:
      `La vela de ${interval} cerró en ${F.formatPrice(entry)}, ${largo ? 'por encima de la resistencia' : 'por debajo del soporte'} ` +
      `${F.formatPrice(level)}${volumeRatio ? `, con ${F.num(volumeRatio)}× el volumen medio` : ''}. ` +
      `Es la señal de ${largo ? 'compra' : 'venta'} del sistema: la vela cierra al otro lado del nivel, no sólo lo toca.`,
    detail:
      `${v.verbo} a ${F.formatPrice(entry)} · ` +
      `${cerrar.verbo.toLowerCase()} si ${largo ? 'baja de' : 'sube de'} ${F.formatPrice(stop)} (stop, ${F.formatPercent(Math.abs(pctChange(entry, stop)), 2)}) ` +
      `o al llegar a ${F.formatPrice(target.price)} (objetivo, ${F.formatPercent(Math.abs(pctChange(entry, target.price)), 2)}, ${target.source}) · ` +
      `ratio ${rr ? `${F.num(rr)}:1` : '—'}`,
  };

  return { position, signal };
}

function buildClose({ position, reason, price, now, extra = '' }) {
  const largo = position.side === 'larga';
  const v = VERBOS[position.side].cerrar;
  const cambio = largo ? pctChange(position.entry, price) : pctChange(price, position.entry);

  const textos = {
    stop: {
      message:
        `El precio volvió a ${F.formatPrice(price)}, ${largo ? 'por debajo del' : 'por encima del'} stop ` +
        `${F.formatPrice(position.stop)}. La ruptura no aguantó: aquí se ${v.presente} para no seguir perdiendo.`,
    },
    objetivo: {
      message: `El precio alcanzó ${F.formatPrice(position.target)}, el objetivo fijado al ${largo ? 'comprar' : 'abrir el corto'}.`,
    },
    trampa: {
      message:
        `Una vela cerró de vuelta ${largo ? 'por debajo de' : 'por encima de'} ${F.formatPrice(position.level)}, ` +
        'el nivel que se había roto. Es la trampa clásica: el nivel se recupera y el movimiento se deshace, así que se cierra sin esperar al stop.',
    },
    contraria: {
      message: `Se confirmó una ruptura ${largo ? 'bajista' : 'alcista'} con la posición abierta. ${extra}`.trim(),
    },
  };

  return {
    id: `${v.tipo}-${reason}-${position.openedAt}`,
    type: v.tipo,
    action: `${largo ? 'vender' : 'recomprar'}_${reason}`,
    side: position.side,
    sound: v.sonido,
    symbol: position.symbol,
    interval: position.interval,
    at: now,
    price,
    entry: position.entry,
    change: cambio,
    reason,
    title: `${v.verbo} ${position.symbol} · ${position.interval}`,
    message: textos[reason].message,
    detail:
      `${largo ? 'Comprado' : 'Abierto'} a ${F.formatPrice(position.entry)} → ${largo ? 'vendido' : 'cerrado'} a ${F.formatPrice(price)} · ` +
      `${cambio >= 0 ? '+' : ''}${F.formatPercent(cambio, 2)} en el seguimiento`,
  };
}

// Ruptura bajista operando sólo en contado y sin nada comprado. No abre
// seguimiento —no se puede vender lo que no se tiene— pero callarse sería
// peor: quien ya tenga la moneda de antes sí tiene aquí una señal de venta.
function buildLooseSell({ breaker, level, symbol, interval, volumeRatio, now }) {
  return {
    id: `senal-venta-${breaker.openTime}`,
    type: 'venta',
    action: 'senal_venta',
    side: 'corta',
    sound: 'venta',
    symbol,
    interval,
    candleTime: breaker.openTime,
    at: now,
    price: breaker.close,
    level,
    title: `Señal de venta · ${symbol} ${interval}`,
    message:
      `La vela de ${interval} cerró en ${F.formatPrice(breaker.close)}, por debajo del soporte ${F.formatPrice(level)}` +
      `${volumeRatio ? `, con ${F.num(volumeRatio)}× el volumen medio` : ''}. ` +
      `Si tienes ${moneda(symbol)}, es la señal de venta del sistema; si no, la de quedarse fuera.`,
    detail:
      'No se abre seguimiento: en contado no se puede vender lo que no se tiene. ' +
      'Cambia a «contado y corto» si quieres que también siga las bajadas.',
  };
}

function buildWarning({ side, breakoutSide, breakout, symbol, interval, candleTime, now, atr }) {
  const largo = side === 'larga';

  // El identificador lleva la ZONA del nivel (medio ATR), no la vela. Con la
  // vela, un precio que pasa diez horas rondando la misma resistencia daba
  // diez avisos idénticos —medido sobre histórico real: 144 avisos en 320
  // velas, un popup con sonido cada dos horas—. Por zona se avisa una vez por
  // aproximación, que es lo que significa "está a punto de romper".
  // La zona se calcula por cifras significativas y no dividiendo por el ATR:
  // el ATR se mueve con el tiempo, así que un mismo nivel caía en zonas
  // distintas según el día y el aviso volvía a saltar sin que nada hubiera
  // cambiado. Esto sólo depende del nivel.
  const paso = 10 ** (Math.floor(Math.log10(Math.abs(breakoutSide.level) || 1)) - 2);
  const zona = Math.round(breakoutSide.level / paso);

  return {
    id: `aviso-${largo ? 'compra' : 'venta'}-z${zona}`,
    type: 'aviso',
    action: `aviso_${largo ? 'compra' : 'venta'}`,
    side,
    sound: 'aviso',
    symbol,
    interval,
    candleTime,
    at: now,
    price: breakout.price,
    level: breakoutSide.level,
    probability: breakoutSide.probability,
    title: `A punto de dar señal de ${largo ? 'compra' : 'venta'} · ${symbol} ${interval}`,
    message:
      `${F.formatPercent(breakoutSide.probability, 0)} de probabilidad de alcanzar ${F.formatPrice(breakoutSide.level)} ` +
      `antes de que cierre la vela (quedan ${breakout.candle.remainingLabel}).`,
    detail: `Todavía no es una ${largo ? 'compra' : 'venta'}: hace falta que la vela cierre al otro lado del nivel y con volumen.`,
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
  const conCortos = cfg.operativa === 'ambos';
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

  // --- Cerrar primero: con una posición abierta, lo urgente es salir --------
  if (position) {
    const largo = position.side === 'larga';
    let cierre = null;

    if (largo ? livePrice <= position.stop : livePrice >= position.stop) {
      cierre = buildClose({ position, reason: 'stop', price: livePrice, now });
    } else if (largo ? livePrice >= position.target : livePrice <= position.target) {
      cierre = buildClose({ position, reason: 'objetivo', price: livePrice, now });
    } else if (
      breaker.openTime > position.candleTime &&
      (largo ? breaker.close < position.level : breaker.close > position.level)
    ) {
      cierre = buildClose({ position, reason: 'trampa', price: breaker.close, now });
    } else if (largo ? rompeAbajo : rompeArriba) {
      cierre = buildClose({
        position,
        reason: 'contraria',
        price: breaker.close,
        now,
        extra: `Nivel roto: ${F.formatPrice(largo ? support.price : resistance.price)}.`,
      });
    }

    if (cierre) return { signals: [cierre], position: null };
    return { signals, position };
  }

  // --- Abrir ----------------------------------------------------------------
  if (rompeArriba) {
    const { position: nueva, signal } = buildOpen({
      side: 'larga', breaker, level: resistance.price, levelsSource: history, atr, symbol, interval, volumeRatio, now, minRewardRisk: cfg.minRewardRisk,
    });
    return { signals: [signal], position: nueva };
  }

  if (rompeAbajo) {
    if (conCortos) {
      const { position: nueva, signal } = buildOpen({
        side: 'corta', breaker, level: support.price, levelsSource: history, atr, symbol, interval, volumeRatio, now, minRewardRisk: cfg.minRewardRisk,
      });
      return { signals: [signal], position: nueva };
    }
    return { signals: [buildLooseSell({ breaker, level: support.price, symbol, interval, volumeRatio, now })], position: null };
  }

  // --- Aviso previo ---------------------------------------------------------
  if (cfg.avisosPrevios && breakout && breakout.ok) {
    const arriba = breakout.up;
    const abajo = breakout.down;

    if (arriba && arriba.probability >= cfg.warnProbability) {
      signals.push(buildWarning({ side: 'larga', breakoutSide: arriba, breakout, symbol, interval, candleTime: current.openTime, now, atr }));
    } else if (abajo && abajo.probability >= cfg.warnProbability) {
      signals.push(buildWarning({ side: 'corta', breakoutSide: abajo, breakout, symbol, interval, candleTime: current.openTime, now, atr }));
    }
  }

  return { signals, position };
}

const API = { evaluateSignals, DEFAULTS, VERBOS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Signals = API;
})();
