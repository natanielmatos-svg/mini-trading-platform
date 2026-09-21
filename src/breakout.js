'use strict';

// ¿Va a romper esta vela al alza o a la baja?
//
// La respuesta honesta no es un oráculo, es una frecuencia observada. El método
// tiene tres pasos y se puede comprobar a mano:
//
//   1. Localizar el nivel más cercano por arriba y por abajo. No cualquier
//      precio: los pivotes donde el mercado ya se dio la vuelta, agrupados
//      cuando están tan juntos que son el mismo nivel tocado varias veces.
//   2. Medir cuánto falta hasta cada nivel en unidades de ATR, no en dólares.
//      "Faltan 300 $" no dice nada; "falta 0,4 ATR" dice que es un recorrido
//      corriente para este activo y este timeframe.
//   3. Contar cuántas de las velas anteriores recorrieron esa distancia desde
//      su apertura. Ese porcentaje es la probabilidad que se muestra.
//
// El ajuste por tiempo: a una vela a la que le queda el 30% de su vida no se le
// puede exigir el recorrido de una vela entera. Como la volatilidad de un
// recorrido escala con la raíz del tiempo, la distancia pendiente se compara
// contra la muestra dividida por sqrt(fracción restante).
//
// Límites que conviene tener presentes:
//   - La muestra es incondicional: no sabe si la vela ya gastó su empuje.
//   - El ATR usado para normalizar cada vela histórica es el previo a esa vela,
//     nunca el posterior; si no, el cálculo miraría el futuro.
//   - Frecuencia histórica no es probabilidad futura. Es análisis de mercado,
//     no una recomendación de inversión.

const {
  atrSeries,
  emaSeries,
  rsi,
  pivots,
  clusterLevels,
  shareAtLeast,
  requiredExcursion,
  findLevels,
} = require('./indicators');

const MIN_CANDLES = 60;

const { formatPrice, formatDuration, num, priceDecimals } = require('./format');

function pct(value) {
  return Math.round(value * 1000) / 10; // 0.4312 -> 43.1
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// Excursión de cada vela cerrada desde su apertura, en ATR. Es la muestra
// contra la que se compara lo que le falta a la vela en curso.
function excursionSample(candles, atrLength) {
  const atrs = atrSeries(candles, atrLength);
  const up = [];
  const down = [];

  for (let i = atrLength; i < candles.length; i++) {
    const reference = atrs[i - 1]; // ATR conocido antes de que abriera la vela i
    if (!(reference > 0)) continue;
    const c = candles[i];
    up.push((c.high - c.open) / reference);
    down.push((c.open - c.low) / reference);
  }

  return { up, down };
}

function describeLevel(level, price, atr, sample, remainingFraction, direction) {
  if (!level || !(atr > 0)) return null;

  const distance = Math.abs(level.price - price);
  const distanceAtr = distance / atr;
  // A menos tiempo restante, más exigente es el mismo recorrido.
  const scaled = requiredExcursion(distanceAtr, remainingFraction);
  const probability = shareAtLeast(sample, scaled);
  // Cuando a la vela en curso apenas le queda vida, su probabilidad tiende a
  // cero por falta de tiempo, no por falta de fuerza. La de una vela completa
  // responde a la pregunta útil: ¿y en la siguiente?
  const fullCandle = shareAtLeast(sample, distanceAtr);

  return {
    direction,
    level: round(level.price, priceDecimals(level.price)),
    touches: level.touches,
    fallback: Boolean(level.fallback),
    lastTouch: level.lastTouch,
    distance: round(distance, priceDecimals(distance)),
    distancePct: round((distance / price) * 100, 3),
    distanceAtr: round(distanceAtr, 2),
    requiredAtr: round(scaled, 2),
    probability: probability === null ? null : round(probability, 3),
    probabilityFullCandle: fullCandle === null ? null : round(fullCandle, 3),
    sampleSize: sample.length,
  };
}

function mean(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

// Señales de contexto. No entran en el cálculo de la probabilidad —que es
// puramente empírica— sino que se muestran aparte: son las que explican por qué
// una ruptura, si llega, tendría o no continuidad.
function buildContext({ completed, current, atr, price, elapsed, emaFast, emaSlow, atrs }) {
  const factors = [];

  // 1. Compresión de volatilidad
  const atrRecent = atrs.slice(-50).filter((v) => Number.isFinite(v));
  const atrAvg = mean(atrRecent);
  if (atrAvg > 0) {
    const ratio = atr / atrAvg;
    factors.push({
      key: 'compresion',
      label: 'Volatilidad',
      value: round(ratio, 2),
      lean: 'neutral',
      text:
        ratio < 0.8
          ? `Comprimida: el ATR está al ${num(pct(ratio), 1)}% de su media de 50 velas. Los rangos estrechos preceden a los movimientos amplios, y la ruptura que salga de aquí suele ser rápida.`
          : ratio > 1.25
            ? `Expandida: el ATR está al ${num(pct(ratio), 1)}% de su media. El movimiento ya está en marcha; entrar en una ruptura aquí es entrar tarde y con el stop lejos.`
            : `Normal: el ATR está al ${num(pct(ratio), 1)}% de su media de 50 velas.`,
    });
  }

  // 2. Posición dentro del rango reciente
  const recent = completed.slice(-50);
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  if (hi > lo) {
    const position = (price - lo) / (hi - lo);
    factors.push({
      key: 'posicion',
      label: 'Posición en el rango',
      value: round(position, 3),
      lean: position > 0.7 ? 'alza' : position < 0.3 ? 'baja' : 'neutral',
      text:
        position > 0.7
          ? `En la parte alta del rango de 50 velas (${num(pct(position), 1)}%): pegado al techo, que es donde nacen las rupturas al alza y también las trampas.`
          : position < 0.3
            ? `En la parte baja del rango de 50 velas (${num(pct(position), 1)}%): cerca del suelo, con la ruptura bajista a tiro.`
            : `A media altura del rango de 50 velas (${num(pct(position), 1)}%): sin nivel cerca, lo normal es que no rompa nada.`,
    });
  }

  // 3. Volumen proyectado de la vela en curso
  const volAvg = mean(completed.slice(-20).map((c) => c.volume));
  if (volAvg > 0 && Number.isFinite(current.volume) && elapsed > 0.05) {
    const projected = current.volume / elapsed;
    const ratio = projected / volAvg;
    factors.push({
      key: 'volumen',
      label: 'Volumen proyectado',
      value: round(ratio, 2),
      lean: ratio > 1.3 ? (current.close >= current.open ? 'alza' : 'baja') : 'neutral',
      text:
        ratio > 1.3
          ? `Al ritmo actual la vela cerrará con ${num(ratio)}× el volumen medio. El volumen es lo que separa una ruptura de un pinchazo: sin él, el nivel se recupera.`
          : ratio < 0.7
            ? `Al ritmo actual la vela cerrará con ${num(ratio)}× el volumen medio. Con tan poco papel, una ruptura tiene todas las papeletas de ser falsa.`
            : `Volumen en línea con la media (${num(ratio)}×).`,
    });
  }

  // 4. Tendencia por EMAs
  if (Number.isFinite(emaFast) && Number.isFinite(emaSlow)) {
    const gap = (emaFast - emaSlow) / price;
    factors.push({
      key: 'tendencia',
      label: 'Tendencia (EMA 20/50)',
      value: round(gap * 100, 3),
      lean: emaFast > emaSlow ? 'alza' : 'baja',
      text:
        emaFast > emaSlow
          ? `EMA rápida por encima de la lenta (${num(gap * 100)}% de separación): las rupturas al alza tienen el viento a favor y las bajistas van contra corriente.`
          : `EMA rápida por debajo de la lenta (${num(gap * 100)}%): la presión de fondo es bajista.`,
    });
  }

  // 5. RSI como contexto de agotamiento
  const rsiValue = rsi(completed.map((c) => c.close), 14);
  if (Number.isFinite(rsiValue)) {
    factors.push({
      key: 'rsi',
      label: 'RSI(14)',
      value: round(rsiValue, 1),
      lean: rsiValue > 70 ? 'baja' : rsiValue < 30 ? 'alza' : 'neutral',
      text:
        rsiValue > 70
          ? `RSI en ${num(rsiValue, 1)}: sobrecomprado. En tendencia fuerte puede quedarse aquí semanas, pero avisa de que el recorrido fácil ya se hizo.`
          : rsiValue < 30
            ? `RSI en ${num(rsiValue, 1)}: sobrevendido. Un rebote técnico es tan probable como la continuación bajista.`
            : `RSI en ${num(rsiValue, 1)}: sin extremos.`,
    });
  }

  // 6. Forma de la vela en curso
  const range = current.high - current.low;
  if (range > 0) {
    const body = Math.abs(current.close - current.open) / range;
    const upperWick = (current.high - Math.max(current.open, current.close)) / range;
    const lowerWick = (Math.min(current.open, current.close) - current.low) / range;
    factors.push({
      key: 'forma',
      label: 'Forma de la vela',
      value: round(body, 2),
      lean: upperWick > 0.5 ? 'baja' : lowerWick > 0.5 ? 'alza' : 'neutral',
      text:
        upperWick > 0.5
          ? `Mecha superior larga (${num(pct(upperWick), 1)}% del rango): alguien está vendiendo cada intento de subida.`
          : lowerWick > 0.5
            ? `Mecha inferior larga (${num(pct(lowerWick), 1)}% del rango): las caídas se están comprando.`
            : `Cuerpo del ${num(pct(body), 1)}% del rango, sin rechazo claro en ninguna de las dos puntas.`,
    });
  }

  return factors;
}

function biasFrom(up, down) {
  const pu = up && up.probability !== null ? up.probability : 0;
  const pd = down && down.probability !== null ? down.probability : 0;
  if (pu === 0 && pd === 0) return { bias: 'ninguna', strength: 0 };
  const diff = pu - pd;
  const strength = Math.min(Math.abs(diff) / Math.max(pu, pd, 0.01), 1);
  if (Math.abs(diff) < 0.05) return { bias: 'equilibrio', strength: round(strength, 2) };
  return { bias: diff > 0 ? 'alza' : 'baja', strength: round(strength, 2) };
}

function analyzeBreakout(candles, options = {}) {
  const {
    interval = '1h',
    now = Date.now(),
    atrLength = 14,
    fast = 20,
    slow = 50,
    livePrice = null,
  } = options;

  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    return {
      ok: false,
      reason: `Hacen falta al menos ${MIN_CANDLES} velas para estimar nada; llegaron ${Array.isArray(candles) ? candles.length : 0}.`,
    };
  }

  const current = candles[candles.length - 1];
  const completed = candles.slice(0, -1);
  const atrs = atrSeries(completed, atrLength);
  const atr = atrs[atrs.length - 1];

  if (!(atr > 0)) {
    return { ok: false, reason: 'No se pudo calcular el ATR: las velas recibidas no tienen rango.' };
  }

  // El precio en vivo llega por WebSocket y puede ir por delante de la vela
  // cacheada; si está disponible, manda.
  const price = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : current.close;
  const step = Math.max(current.closeTime - current.openTime + 1, 1);
  const elapsed = Math.min(Math.max((now - current.openTime) / step, 0.01), 1);
  const remaining = Math.min(Math.max(1 - elapsed, 0.01), 1);
  const remainingMs = Math.max(current.closeTime - now, 0);

  const sample = excursionSample(completed, atrLength);
  const { resistance, support, rangeHigh, rangeLow } = findLevels(completed, price, atr * 0.35);

  const up = describeLevel(resistance, price, atr, sample.up, remaining, 'alza');
  const down = describeLevel(support, price, atr, sample.down, remaining, 'baja');

  const closes = completed.map((c) => c.close);
  const emaFast = emaSeries(closes, fast).at(-1);
  const emaSlow = emaSeries(closes, slow).at(-1);

  const context = buildContext({ completed, current, atr, price, elapsed, emaFast, emaSlow, atrs });
  const { bias, strength } = biasFrom(up, down);

  const volAvg = mean(completed.slice(-20).map((c) => c.volume));

  return {
    ok: true,
    interval,
    generatedAt: now,
    price: round(price, priceDecimals(price)),
    atr: round(atr, priceDecimals(atr)),
    atrPct: round((atr / price) * 100, 3),
    candle: {
      openTime: current.openTime,
      closeTime: current.closeTime,
      open: round(current.open, priceDecimals(current.open)),
      high: round(current.high, priceDecimals(current.high)),
      low: round(current.low, priceDecimals(current.low)),
      close: round(current.close, priceDecimals(current.close)),
      volume: round(current.volume, 2),
      elapsed: round(elapsed, 3),
      remainingMs,
      remainingLabel: formatDuration(remainingMs),
    },
    range: { high: round(rangeHigh, priceDecimals(rangeHigh)), low: round(rangeLow, priceDecimals(rangeLow)) },
    up,
    down,
    bias,
    biasStrength: strength,
    trigger: buildTriggers({ up, down, volAvg, interval }),
    context,
    explanation: buildExplanation({ interval, price, atr, up, down, current, remainingMs, bias, context }),
    // La muestra viaja al navegador para poder recalcular la probabilidad con
    // cada tick del WebSocket sin volver a preguntar al servidor.
    sample: {
      up: sample.up.map((v) => round(v, 3)),
      down: sample.down.map((v) => round(v, 3)),
      remainingFraction: round(remaining, 3),
    },
    disclaimer:
      'Frecuencia histórica de recorridos, no una predicción ni una recomendación de inversión.',
  };
}

// Qué hay que ver para dar una ruptura por buena. Separar esto de la
// probabilidad es la parte útil: el número dice si es plausible, el disparador
// dice cómo distinguir la ruptura de la trampa.
function buildTriggers({ up, down, volAvg, interval }) {
  const volumeNote = volAvg > 0 ? `con volumen por encima de ${num(volAvg * 1.3, 0)} (1,3× la media de 20 velas)` : 'con volumen por encima de la media';

  return {
    up: up
      ? {
          level: up.level,
          text: `Ruptura alcista válida: cierre de ${interval} por encima de ${formatPrice(up.level)} ${volumeNote}. Un pico que toca el nivel y vuelve dentro antes del cierre es un rechazo, no una ruptura.`,
          invalidation: `Se cae si el precio vuelve por debajo de ${formatPrice(up.level)} en la vela siguiente: eso es la trampa alcista clásica.`,
        }
      : null,
    down: down
      ? {
          level: down.level,
          text: `Ruptura bajista válida: cierre de ${interval} por debajo de ${formatPrice(down.level)} ${volumeNote}.`,
          invalidation: `Se cae si el precio recupera ${formatPrice(down.level)} en la vela siguiente.`,
        }
      : null,
  };
}

function buildExplanation({ interval, price, atr, up, down, current, remainingMs, bias, context }) {
  const lines = [];

  lines.push(
    `Vela de ${interval} en curso: abrió en ${formatPrice(current.open)}, va por ${formatPrice(price)} y le quedan ${formatDuration(remainingMs)}. El ATR(14) es de ${formatPrice(atr)}, que es lo que se mueve una vela corriente de este timeframe.`
  );

  if (up) {
    const strength = up.fallback
      ? 'el máximo de las últimas 60 velas, sin pivotes por encima'
      : `un nivel tocado ${up.touches} ${up.touches === 1 ? 'vez' : 'veces'}`;
    lines.push(
      up.probability === null
        ? `Al alza, la referencia está en ${formatPrice(up.level)} (${strength}), a ${num(up.distancePct)}% de aquí. No hay muestra suficiente para ponerle número.`
        : `Para romper al alza faltan ${num(up.distancePct)}% hasta ${formatPrice(up.level)} (${strength}), que son ${num(up.distanceAtr)} ATR. Ajustado al tiempo que le queda a la vela equivale a exigirle ${num(up.requiredAtr)} ATR de recorrido completo: de las ${up.sampleSize} velas anteriores de ${interval}, el ${num(pct(up.probability), 1)}% recorrió eso o más desde su apertura. Ésa es la probabilidad.`
    );
  } else {
    lines.push('Al alza no hay nivel por delante: el precio está en máximos del rango analizado.');
  }

  if (down) {
    const strength = down.fallback
      ? 'el mínimo de las últimas 60 velas, sin pivotes por debajo'
      : `un nivel tocado ${down.touches} ${down.touches === 1 ? 'vez' : 'veces'}`;
    lines.push(
      down.probability === null
        ? `A la baja, la referencia está en ${formatPrice(down.level)} (${strength}), a ${num(down.distancePct)}% de aquí.`
        : `Para romper a la baja faltan ${num(down.distancePct)}% hasta ${formatPrice(down.level)} (${strength}), ${num(down.distanceAtr)} ATR, equivalentes a ${num(down.requiredAtr)} ATR completos: el ${num(pct(down.probability), 1)}% de las ${down.sampleSize} velas anteriores bajó eso o más desde su apertura.`
    );
  } else {
    lines.push('A la baja no hay nivel por delante dentro del rango analizado.');
  }

  const leaning = context.filter((f) => f.lean !== 'neutral');
  if (bias === 'equilibrio' || bias === 'ninguna') {
    lines.push('Las dos distancias son parecidas: por recorrido puro, la vela no tiene lado favorito. Lo que decide es el contexto.');
  } else {
    lines.push(
      `Por distancia, el lado ${bias === 'alza' ? 'alcista' : 'bajista'} está más a mano. Eso no dice hacia dónde quiere ir el precio, sólo qué pared tiene más cerca.`
    );
  }

  if (leaning.length) {
    const alza = leaning.filter((f) => f.lean === 'alza').map((f) => f.label);
    const baja = leaning.filter((f) => f.lean === 'baja').map((f) => f.label);
    const partes = [];
    if (alza.length) partes.push(`a favor del alza: ${alza.join(', ')}`);
    if (baja.length) partes.push(`a favor de la baja: ${baja.join(', ')}`);
    lines.push(`Contexto ${partes.join('; ')}.`);
  }

  return lines;
}

module.exports = { analyzeBreakout, excursionSample, findLevels, formatPrice, formatDuration, MIN_CANDLES };
