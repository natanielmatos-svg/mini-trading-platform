'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluateSignals, DEFAULTS } = require('../src/signals');

const STEP = 3_600_000;
const T0 = 1_700_000_000_000 - 400 * STEP;

// Rango que oscila entre 100 y 110 con pivotes limpios: deja una resistencia
// alrededor de 110,6 y un soporte alrededor de 99,4.
function rango({ count = 160, low = 100, high = 110, period = 20, volume = 100 } = {}) {
  const level = (i) => low + (high - low) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i % period)) / period));
  return Array.from({ length: count }, (_, i) => {
    const openTime = T0 + i * STEP;
    const open = level(i);
    const close = level(i + 1);
    const cresta = i % period === period / 2;
    const valle = i % period === 0;
    return {
      openTime,
      closeTime: openTime + STEP - 1,
      open,
      high: Math.max(open, close) + (cresta ? 0.6 : 0.1),
      low: Math.min(open, close) - (valle ? 0.6 : 0.1),
      close,
      volume,
      closed: true,
    };
  });
}

function vela(base, { open, high, low, close, volume, closed = true }) {
  const openTime = base.closeTime + 1;
  return { openTime, closeTime: openTime + STEP - 1, open, high, low, close, volume, closed };
}

// Rango + vela que rompe + vela en formación, que es lo que ve la interfaz.
function conRuptura({ close = 115, volume = 300, high = null, low = 109.8 } = {}) {
  const base = rango();
  const breaker = vela(base[base.length - 1], {
    open: 110, high: high ?? close + 0.2, low, close, volume,
  });
  const forming = vela(breaker, { open: close, high: close + 0.1, low: close - 0.1, close, volume: 10, closed: false });
  return [...base, breaker, forming];
}

const contexto = { symbol: 'BTCUSDT', interval: '1h', now: 1_700_000_000_000 };

test('sin velas suficientes no se inventa ninguna señal', () => {
  const out = evaluateSignals({ candles: rango({ count: 10 }), ...contexto });
  assert.deepStrictEqual(out.signals, []);
  assert.strictEqual(out.position, null);
});

test('un cierre por encima de la resistencia con volumen dice COMPRAR', () => {
  const out = evaluateSignals({ candles: conRuptura(), ...contexto });

  assert.strictEqual(out.signals.length, 1);
  const s = out.signals[0];
  assert.strictEqual(s.action, 'comprar');
  assert.strictEqual(s.type, 'compra');
  assert.strictEqual(s.sound, 'compra');
  assert.strictEqual(s.price, 115);
  assert.match(s.title, /^Comprar BTCUSDT/);
  assert.ok(s.level > 110 && s.level < 111, `nivel roto ${s.level}`);
  assert.match(s.message, /señal de compra/);
  assert.match(s.message, /no sólo lo toca/);
  assert.match(s.detail, /Comprar a .* vender si baja de .*\(objetivo/);

  assert.strictEqual(out.position.side, 'larga');
  assert.ok(out.position.stop < 110, 'el stop va bajo el mínimo de la vela que rompe');
  assert.ok(out.position.target > 115, 'el objetivo está por delante de la compra');
});

test('el objetivo no puede ser el máximo de la propia vela que rompe', () => {
  const { position } = evaluateSignals({ candles: conRuptura({ close: 115, high: 115.2 }), ...contexto });
  assert.ok(position.target > 115.2, `objetivo ${position.target} debe estar más allá de la vela que rompió`);
  assert.strictEqual(position.targetSource, 'doble del riesgo');
  assert.ok(position.rewardRisk >= 1.9 && position.rewardRisk <= 2.1);
});

// Rango + un pivote máximo en `precioNivel` + la vela que rompe.
function conNivelArriba(precioNivel) {
  const base = rango();
  const visita = [];
  let previa = base[base.length - 1];

  // Siete velas con una que sube a tocar el nivel y vuelve: eso deja un pivote.
  for (let k = 0; k < 7; k++) {
    const c = vela(previa, {
      open: 105, high: k === 3 ? precioNivel : 106, low: 104, close: 105, volume: 100,
    });
    visita.push(c);
    previa = c;
  }

  const breaker = vela(previa, { open: 110, high: 115.2, low: 109.8, close: 115, volume: 300 });
  const forming = vela(breaker, { open: 115, high: 115.1, low: 114.9, close: 115, volume: 10, closed: false });
  return [...base, ...visita, breaker, forming];
}

test('un nivel demasiado cerca para pagar el riesgo no sirve de objetivo', () => {
  // Compra en 115 con el stop en ~109,7: el riesgo es de unos 5,3 puntos. Un
  // objetivo en 117 daría un ratio de 0,4 —arriesgar cinco para ganar dos—,
  // así que se descarta y se usa el doble del riesgo.
  const { position, signals } = evaluateSignals({ candles: conNivelArriba(117), ...contexto });

  assert.strictEqual(signals[0].action, 'comprar');
  assert.ok(position.target > 117, `objetivo ${position.target}: no puede ser el nivel de 117`);
  assert.strictEqual(position.targetSource, 'doble del riesgo');
  assert.ok(position.rewardRisk >= 1.9);
});

test('un nivel lo bastante lejos sí sirve de objetivo', () => {
  const { position } = evaluateSignals({ candles: conNivelArriba(130), ...contexto });

  assert.ok(Math.abs(position.target - 130) < 0.5, `objetivo ${position.target}`);
  assert.strictEqual(position.targetSource, 'nivel');
  assert.ok(position.rewardRisk > 2.5);
});

test('el mínimo de beneficio sobre riesgo es configurable', () => {
  // Bajándolo, ese mismo nivel de 117 vuelve a valer.
  const { position } = evaluateSignals({
    candles: conNivelArriba(117),
    options: { minRewardRisk: 0.3 },
    ...contexto,
  });
  assert.ok(Math.abs(position.target - 117) < 0.5);
  assert.strictEqual(position.targetSource, 'nivel');
});

test('sin volumen que lo respalde, la ruptura no es compra', () => {
  const out = evaluateSignals({ candles: conRuptura({ volume: 100 }), ...contexto });
  assert.deepStrictEqual(out.signals, []);
  assert.strictEqual(out.position, null);
});

test('un pico que toca el nivel pero cierra dentro no es compra', () => {
  // Máximo en 115, cierre en 108: el rechazo clásico.
  const out = evaluateSignals({ candles: conRuptura({ close: 108, high: 115, volume: 400 }), ...contexto });
  assert.deepStrictEqual(out.signals, []);
});

// Ruptura bajista: en contado no hay nada que vender si no se ha comprado.
function conCaida() {
  const base = rango();
  const breaker = vela(base[base.length - 1], { open: 100, high: 100.2, low: 94.8, close: 95, volume: 300 });
  const forming = vela(breaker, { open: 95, high: 95.1, low: 94.9, close: 95, volume: 10, closed: false });
  return [...base, breaker, forming];
}

test('en contado, romper el soporte avisa de venta pero no abre seguimiento', () => {
  const out = evaluateSignals({ candles: conCaida(), ...contexto });

  assert.strictEqual(out.signals.length, 1);
  const s = out.signals[0];
  assert.strictEqual(s.action, 'senal_venta');
  assert.strictEqual(s.type, 'venta');
  assert.strictEqual(s.sound, 'venta');
  assert.match(s.title, /^Señal de venta/);
  assert.match(s.message, /Si tienes BTC, es la señal de venta/);
  assert.match(s.detail, /no se puede vender lo que no se tiene/);
  assert.strictEqual(out.position, null, 'en contado no se abre nada al caer');
});

test('con cortos activados, romper el soporte sí abre una venta en corto', () => {
  const out = evaluateSignals({ candles: conCaida(), options: { operativa: 'ambos' }, ...contexto });

  assert.strictEqual(out.signals[0].action, 'vender_corto');
  assert.strictEqual(out.signals[0].type, 'venta');
  assert.match(out.signals[0].title, /^Vender en corto BTCUSDT/);
  assert.strictEqual(out.position.side, 'corta');
  assert.ok(out.position.stop > 95, 'en corto el stop va por encima');
  assert.ok(out.position.target < 95);
});

test('cerrar un corto se llama recomprar y suena a compra', () => {
  const candles = conCaida();
  const { position } = evaluateSignals({ candles, options: { operativa: 'ambos' }, ...contexto });

  const out = evaluateSignals({ candles, position, price: position.target, options: { operativa: 'ambos' }, ...contexto });
  assert.match(out.signals[0].title, /^Recomprar BTCUSDT/);
  assert.strictEqual(out.signals[0].type, 'compra');
  assert.strictEqual(out.signals[0].sound, 'compra');
  assert.ok(out.signals[0].change > 0, 'un corto cerrado en el objetivo gana');
});

test('comprado y tocando el stop, dice VENDER', () => {
  const candles = conRuptura();
  const { position } = evaluateSignals({ candles, ...contexto });

  const out = evaluateSignals({ candles, position, price: position.stop - 0.01, ...contexto });
  assert.strictEqual(out.signals[0].action, 'vender_stop');
  assert.strictEqual(out.signals[0].type, 'venta');
  assert.strictEqual(out.signals[0].sound, 'venta');
  assert.match(out.signals[0].title, /^Vender BTCUSDT/);
  assert.strictEqual(out.position, null, 'el seguimiento se cierra');
  assert.ok(out.signals[0].change < 0);
  assert.match(out.signals[0].message, /La ruptura no aguantó/);
  assert.match(out.signals[0].detail, /Comprado a .* → vendido a/);
});

test('alcanzar el objetivo también manda vender, y con ganancia', () => {
  const candles = conRuptura();
  const { position } = evaluateSignals({ candles, ...contexto });

  const out = evaluateSignals({ candles, position, price: position.target, ...contexto });
  assert.strictEqual(out.signals[0].action, 'vender_objetivo');
  assert.ok(out.signals[0].change > 0);
  assert.strictEqual(out.position, null);
});

test('si una vela posterior cierra de vuelta bajo el nivel, se avisa de la trampa', () => {
  const candles = conRuptura();
  const { position } = evaluateSignals({ candles, ...contexto });

  // Vela siguiente que recupera el nivel hacia abajo sin llegar al stop.
  const trampa = vela(candles[candles.length - 1], { open: 115, high: 115, low: 109.9, close: 110, volume: 200 });
  const conTrampa = [...candles.slice(0, -1), { ...candles[candles.length - 1], closed: true }, trampa,
    vela(trampa, { open: 110, high: 110.1, low: 109.9, close: 110, volume: 5, closed: false })];

  const out = evaluateSignals({ candles: conTrampa, position, price: 110, ...contexto });
  assert.strictEqual(out.signals[0].action, 'vender_trampa');
  assert.match(out.signals[0].message, /trampa clásica/);
  assert.strictEqual(out.position, null);
});

test('mientras el precio está entre stop y objetivo no se dice nada', () => {
  const candles = conRuptura();
  const { position } = evaluateSignals({ candles, ...contexto });

  const out = evaluateSignals({ candles, position, price: position.entry + 0.1, ...contexto });
  assert.deepStrictEqual(out.signals, []);
  assert.strictEqual(out.position, position, 'la posición sigue igual');
});

test('con posición abierta no se emiten avisos de ruptura', () => {
  const candles = conRuptura();
  const { position } = evaluateSignals({ candles, ...contexto });
  const breakout = { ok: true, price: 115, up: { level: 120, probability: 0.95 }, down: null, candle: { remainingLabel: '20 min' } };

  const out = evaluateSignals({ candles, position, breakout, price: position.entry, ...contexto });
  assert.deepStrictEqual(out.signals, [], 'lo urgente con posición abierta es la salida, no el ruido');
});

test('una probabilidad alta sin ruptura confirmada es aviso, no compra', () => {
  const breakout = {
    ok: true,
    price: 108,
    up: { level: 110.6, probability: 0.82 },
    down: { level: 99.4, probability: 0.05 },
    candle: { remainingLabel: '23 min' },
  };
  const out = evaluateSignals({ candles: rango({ count: 160 }), breakout, ...contexto });

  assert.strictEqual(out.signals.length, 1);
  assert.strictEqual(out.signals[0].action, 'aviso_compra');
  assert.strictEqual(out.signals[0].sound, 'aviso');
  assert.strictEqual(out.position, null, 'un aviso no abre seguimiento');
  assert.match(out.signals[0].title, /A punto de dar señal de compra/);
  assert.match(out.signals[0].detail, /Todavía no es una compra/);
});

test('el mismo nivel no se avisa una vez por vela, sino una por aproximación', () => {
  // El identificador lleva la zona del nivel: dos velas seguidas rondando la
  // misma resistencia producen la misma señal, y quien deduplica por id avisa
  // una sola vez.
  const breakout = (precio) => ({
    ok: true, price: precio,
    up: { level: 110.6, probability: 0.9 },
    down: { level: 99.4, probability: 0.05 },
    candle: { remainingLabel: '20 min' },
  });

  const a = evaluateSignals({ candles: rango({ count: 160 }), breakout: breakout(108), ...contexto });
  const b = evaluateSignals({ candles: rango({ count: 162 }), breakout: breakout(109), ...contexto });

  assert.strictEqual(a.signals[0].id, b.signals[0].id, 'misma zona, mismo identificador');
  assert.match(a.signals[0].id, /^aviso-compra-z\d+$/);
});

test('los avisos previos se pueden apagar sin tocar compras ni ventas', () => {
  const breakout = {
    ok: true, price: 108,
    up: { level: 110.6, probability: 0.95 },
    down: { level: 99.4, probability: 0.05 },
    candle: { remainingLabel: '20 min' },
  };

  const con = evaluateSignals({ candles: rango({ count: 160 }), breakout, ...contexto });
  assert.strictEqual(con.signals.length, 1);

  const sin = evaluateSignals({ candles: rango({ count: 160 }), breakout, options: { avisosPrevios: false }, ...contexto });
  assert.deepStrictEqual(sin.signals, []);

  // Y la compra sigue saltando con los avisos apagados.
  const compra = evaluateSignals({ candles: conRuptura(), options: { avisosPrevios: false }, ...contexto });
  assert.strictEqual(compra.signals[0].action, 'comprar');
});

test('por debajo del umbral no se avisa', () => {
  const breakout = {
    ok: true, price: 108,
    up: { level: 110.6, probability: DEFAULTS.warnProbability - 0.01 },
    down: { level: 99.4, probability: 0.05 },
    candle: { remainingLabel: '23 min' },
  };
  assert.deepStrictEqual(evaluateSignals({ candles: rango({ count: 160 }), breakout, ...contexto }).signals, []);
});

test('los identificadores son deterministas para no repetir la misma alerta', () => {
  const candles = conRuptura();
  const a = evaluateSignals({ candles, ...contexto });
  const b = evaluateSignals({ candles, ...contexto });
  assert.strictEqual(a.signals[0].id, b.signals[0].id);
  assert.match(a.signals[0].id, /^comprar-larga-\d+$/);
});

test('la función es pura: no toca las velas ni la posición que recibe', () => {
  const candles = conRuptura();
  const copia = JSON.parse(JSON.stringify(candles));
  const { position } = evaluateSignals({ candles, ...contexto });
  const posicionCopia = { ...position };

  evaluateSignals({ candles, position, price: position.entry + 0.2, ...contexto });

  assert.deepStrictEqual(candles, copia);
  assert.deepStrictEqual(position, posicionCopia);
});

test('el umbral de volumen es configurable', () => {
  const candles = conRuptura({ volume: 110 }); // 1,1x la media
  assert.deepStrictEqual(evaluateSignals({ candles, ...contexto }).signals, []);
  const out = evaluateSignals({ candles, options: { volumeFactor: 1.05 }, ...contexto });
  assert.strictEqual(out.signals[0].action, 'comprar');
});
