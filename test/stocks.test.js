'use strict';

// La capa de acciones: catálogo, sesión, reloj y velas de demostración.
//
// Lo que se prueba aquí no es el formato de Alpaca —eso está en
// alpaca.test.js— sino las tres cosas que la bolsa tiene y las criptos no: que
// el mercado cierra, que hay festivos y fines de semana, y que sin clave la
// página tiene que funcionar igual con datos de ejemplo.

const test = require('node:test');
const assert = require('node:assert');

const stocks = require('../src/stocks');

// Instantes de referencia, en UTC. Nueva York está en UTC-4 en septiembre.
const MIERCOLES_MEDIODIA = Date.UTC(2026, 8, 23, 17, 0);  // 13:00 NY, abierto
const MIERCOLES_MADRUGADA = Date.UTC(2026, 8, 23, 5, 0);  // 01:00 NY, cerrado
const DOMINGO = Date.UTC(2026, 8, 20, 12, 0);
const APERTURA_EXACTA = Date.UTC(2026, 8, 23, 13, 30);    // 9:30 NY
const CIERRE_EXACTO = Date.UTC(2026, 8, 23, 20, 0);       // 16:00 NY

test('el catálogo viene agrupado y sin grupos vacíos', () => {
  const grupos = stocks.stockGroups();
  assert.ok(grupos.length >= 4);
  for (const g of grupos) {
    assert.ok(g.name, 'todo grupo tiene nombre');
    assert.ok(g.symbols.length > 0, `el grupo ${g.name} no está vacío`);
    for (const s of g.symbols) assert.ok(s.symbol && s.name);
  }

  // Ningún ticker repetido entre grupos: saldría dos veces en el desplegable.
  const todos = grupos.flatMap((g) => g.symbols.map((s) => s.symbol));
  assert.equal(new Set(todos).size, todos.length);
  assert.equal(todos.length, stocks.CATALOG.length);
});

test('un ticker fuera del catálogo no llega a Alpaca', () => {
  assert.equal(stocks.parseTicker('NVDA'), 'NVDA');
  assert.equal(stocks.parseTicker('nvda'), 'NVDA');
  assert.equal(stocks.parseTicker('brk.b'), 'BRK.B', 'las clases con punto se aceptan');
  // Un ticker inventado gastaría una llamada para devolver un error críptico.
  assert.equal(stocks.parseTicker('ZZZZ'), 'AAPL');
  assert.equal(stocks.parseTicker(''), 'AAPL');
  assert.equal(stocks.parseTicker(null), 'AAPL');
  assert.equal(stocks.parseTicker('<script>'), 'AAPL');
});

test('la sesión son los días hábiles de 9:30 a 16:00 en Nueva York', () => {
  assert.equal(stocks.enSesion(MIERCOLES_MEDIODIA), true);
  assert.equal(stocks.enSesion(MIERCOLES_MADRUGADA), false);
  assert.equal(stocks.enSesion(DOMINGO), false);
  assert.equal(stocks.enSesion(Date.UTC(2026, 8, 26, 17, 0)), false, 'sábado');

  // Los bordes: la apertura entra, el cierre no.
  assert.equal(stocks.enSesion(APERTURA_EXACTA), true);
  assert.equal(stocks.enSesion(APERTURA_EXACTA - 60_000), false);
  assert.equal(stocks.enSesion(CIERRE_EXACTO - 60_000), true);
  assert.equal(stocks.enSesion(CIERRE_EXACTO), false);
});

test('el horario de verano mueve la sesión, no se usa un desfase fijo', () => {
  // En enero Nueva York está en UTC-5: las 14:30 UTC son las 9:30 allí.
  assert.equal(stocks.enSesion(Date.UTC(2026, 0, 14, 14, 30)), true);
  assert.equal(stocks.enSesion(Date.UTC(2026, 0, 14, 13, 30)), false, 'en invierno a esa hora aún no ha abierto');
  // En julio está en UTC-4 y sí.
  assert.equal(stocks.enSesion(Date.UTC(2026, 6, 15, 13, 30)), true);
});

test('el reloj de demostración cae en la apertura exacta, no en los segundos de la consulta', () => {
  // Con una hora cualquiera, la apertura no debe heredar minutos ni segundos.
  const r = stocks.relojDemo(Date.UTC(2026, 8, 23, 5, 3, 44, 123));
  assert.equal(r.isOpen, false);
  assert.equal(r.nextOpen, APERTURA_EXACTA);
  assert.equal(r.nextClose, null);

  const abierto = stocks.relojDemo(MIERCOLES_MEDIODIA);
  assert.equal(abierto.isOpen, true);
  assert.equal(abierto.nextClose, CIERRE_EXACTO);
  assert.equal(abierto.nextOpen, null);
});

test('el viernes por la tarde la siguiente apertura es el lunes', () => {
  const viernesTarde = Date.UTC(2026, 8, 18, 21, 0); // 17:00 NY del viernes
  const r = stocks.relojDemo(viernesTarde);
  assert.equal(r.isOpen, false);
  assert.equal(r.nextOpen, Date.UTC(2026, 8, 21, 13, 30), 'lunes a las 9:30 NY');
});

test('las velas de demostración no existen fuera de sesión', () => {
  for (const interval of ['1m', '15m', '1h', '4h']) {
    const velas = stocks.velasDemo({ symbol: 'AAPL', interval, limit: 200, now: MIERCOLES_MEDIODIA });
    assert.equal(velas.length, 200, `${interval}: se devuelven las que se piden`);
    for (const c of velas) {
      assert.equal(stocks.enSesion(c.openTime), true, `${interval}: vela de ${new Date(c.openTime).toISOString()} fuera de sesión`);
    }
    // Y siguen ordenadas y encadenadas.
    for (let i = 1; i < velas.length; i++) {
      assert.ok(velas[i].openTime > velas[i - 1].openTime, `${interval}: orden cronológico`);
    }
  }
});

test('las velas diarias no caen en fin de semana', () => {
  const velas = stocks.velasDemo({ symbol: 'SPY', interval: '1d', limit: 120, now: MIERCOLES_MEDIODIA });
  assert.equal(velas.length, 120);
  for (const c of velas) {
    const { dia } = stocks.horaNuevaYork(c.openTime + 15 * 3_600_000);
    assert.ok(dia !== 0 && dia !== 6, `vela diaria en fin de semana: ${new Date(c.openTime).toISOString()}`);
  }
});

test('pedir una sola vela un domingo devuelve el cierre del viernes, no nada', () => {
  // Es el fallo que tenía: la ventana de búsqueda no llegaba a ninguna sesión
  // y el precio salía vacío justo cuando lo que toca enseñar es el último.
  const velas = stocks.velasDemo({ symbol: 'AAPL', interval: '1m', limit: 1, now: DOMINGO });
  assert.equal(velas.length, 1);
  assert.equal(stocks.enSesion(velas[0].openTime), true);
  assert.ok(velas[0].openTime < DOMINGO);
});

test('sin clave, el precio de demostración se fecha en su vela cuando el mercado está cerrado', async () => {
  const cerrado = await stocks.getStockQuote({ symbol: 'AAPL', demo: true, now: DOMINGO });
  assert.ok(cerrado.price > 0);
  assert.equal(cerrado.sesion, false);
  assert.ok(cerrado.at < DOMINGO, 'el precio no se hace pasar por actual');
  assert.match(cerrado.aviso || '', /ALPACA_KEY_ID/);

  const abierto = await stocks.getStockQuote({ symbol: 'AAPL', demo: true, now: MIERCOLES_MEDIODIA });
  assert.equal(abierto.sesion, true);
  assert.equal(abierto.at, MIERCOLES_MEDIODIA);
});

test('las velas de demostración tienen la forma que espera el análisis', async () => {
  const { candles, source } = await stocks.getStockCandles({ symbol: 'MSFT', interval: '1h', limit: 50, demo: true, now: MIERCOLES_MEDIODIA });
  assert.equal(source, 'demo');
  assert.equal(candles.length, 50);

  for (const c of candles) {
    for (const campo of ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime']) {
      assert.ok(Number.isFinite(c[campo]), `falta ${campo}`);
    }
    assert.ok(c.high >= c.low);
    assert.ok(c.high >= Math.max(c.open, c.close));
    assert.ok(c.low <= Math.min(c.open, c.close));
    assert.ok(c.open > 0);
  }
});

test('el reloj de acciones no sale a la red sin clave', async () => {
  const r = await stocks.getClock({ demo: true, now: MIERCOLES_MEDIODIA });
  assert.equal(r.source, 'demo');
  assert.equal(r.isOpen, true);
});

test('con el mercado cerrado el análisis no habla de una vela en curso', () => {
  // La explicación decía «le quedan nada» y exigía 30 ATR de recorrido: el
  // tiempo restante de una vela que ya cerró es cero, y descontarlo da un 0%
  // que es cierto e inútil.
  const { analyzeBreakout } = require('../src/breakout');

  const velas = [];
  let precio = 100;
  for (let i = 0; i < 300; i++) {
    const open = precio;
    const close = open * (1 + Math.sin(i / 7) * 0.004);
    velas.push({
      openTime: i * 3_600_000, open, close,
      high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998,
      volume: 1000, closeTime: i * 3_600_000 + 3_599_999, closed: true,
    });
    precio = close;
  }

  const ahora = 299 * 3_600_000 + 1_800_000;
  const abierto = analyzeBreakout(velas, { interval: '1h', now: ahora });
  const cerrado = analyzeBreakout(velas, { interval: '1h', now: ahora, mercadoCerrado: true });

  assert.match(abierto.explanation[0], /en curso/);
  assert.match(cerrado.explanation[0], /Mercado cerrado/);
  assert.doesNotMatch(cerrado.explanation[0], /le quedan/);
  assert.doesNotMatch(cerrado.explanation[1], /Ajustado al tiempo/);

  // Y las cuentas son las de una vela entera: nunca más exigente que abierta.
  assert.equal(cerrado.up.requiredAtr, cerrado.up.distanceAtr);
  assert.ok(cerrado.up.probability >= abierto.up.probability);
});
