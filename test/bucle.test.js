'use strict';

// El proceso que corre solo, su cuaderno y el registro de series aprobadas.
//
// Todo con dependencias inyectadas: ni red, ni Kalshi, ni modelo. Lo que se
// prueba es el comportamiento del bucle, que es lo que va a llevar días
// encendido sin que nadie lo mire.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { crearBucle, reconstruir, FALLOS_SEGUIDOS_MAX } = require('../src/bucle');
const R = require('../src/registro');
const Reglas = require('../src/reglas');
const V = require('../src/vetos');
const F = require('../src/forecast');
const { zNormal } = require('../src/calibracion');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bucle-'));

// Un cuaderno que se queda en memoria, para mirar lo que el bucle anota.
function cuaderno() {
  const entradas = [];
  return { entradas, anotar: (e) => { entradas.push({ t: new Date().toISOString(), ...e }); return true; } };
}

function prediccionFalsa({ cobertura = 0.9, sigmaBloque = 0.0008 } = {}) {
  const xs = Array.from({ length: 400 }, (_, i) => zNormal((i + 0.5) / 400));
  const rejilla = F.rejillaZ(xs);
  const h = (bloques, ms) => ({
    ok: true, bloques, ms, desde: '1m',
    sigmaBloque, vLargo: sigmaBloque ** 2, persistencia: 0.97,
    sigmaHorizonte: Math.sqrt(F.varianzaHorizonte(sigmaBloque, sigmaBloque ** 2, bloques, 0.97)),
    rejilla,
    calibracion: { ok: true, cobertura: [{ nominal: 0.9, observada: cobertura }] },
  });
  return { horizontes: [h(1, 60_000), h(15, 900_000)] };
}

// Un mercado con ventaja de sobra, para que el bucle tenga algo que operar.
const mercadoJugoso = (extra = {}) => ({
  ticker: 'KXBTCD-TEST', tipo: 'mayor', suelo: 99.9, techo: null,
  vencimiento: 1_000_000 + 900_000,
  yesBid: 0.40, yesAsk: 0.42, noBid: 0.58, noAsk: 0.60,
  libro: { yesAsk: 5000, noAsk: 5000 },
  ...extra,
});

function bucleDe({ mercados = [mercadoJugoso()], fuentes = [], reg = cuaderno(), ...resto } = {}) {
  const b = crearBucle({
    obtenerMercados: async () => ({ mercados }),
    obtenerPrediccion: async () => prediccionFalsa(),
    obtenerPrecio: async () => 100,
    fuentes,
    capital: 2000,
    reloj: () => 1_000_000,
    registro: reg,
    ...resto,
  });
  return { b, reg };
}

test('una vuelta anota TODO, se opere o no', async () => {
  // El cuaderno que sólo guarda lo operado no sirve para la autopsia: la
  // pregunta interesante casi siempre es qué se dejó pasar.
  const { b, reg } = bucleDe({
    mercados: [mercadoJugoso(), mercadoJugoso({ ticker: 'KXBTCD-CARO', yesBid: 0.60, yesAsk: 0.62, noBid: 0.38, noAsk: 0.40 })],
  });

  const r = await b.ciclo();
  assert.equal(r.vistos, 2);

  const decisiones = reg.entradas.filter((e) => e.tipo === 'decision');
  assert.equal(decisiones.length, 2, 'las dos, no sólo la buena');
  assert.ok(decisiones.some((d) => !d.operar), 'y el rechazo con su motivo');
  assert.ok(decisiones.every((d) => d.ticker && d.motivo !== undefined || d.operar));
  assert.ok(reg.entradas.some((e) => e.tipo === 'vuelta'));
});

test('lo que se decide operar entra en la cartera de papel, una sola vez', async () => {
  const { b, reg } = bucleDe();

  await b.ciclo();
  assert.equal(b.estado.posiciones.size, 1);
  const entradas = reg.entradas.filter((e) => e.tipo === 'entrada');
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0].papel, true, 'papel, no dinero');

  // La vuelta siguiente ve el mismo mercado y no dobla la posición.
  await b.ciclo();
  assert.equal(b.estado.posiciones.size, 1);
  assert.equal(reg.entradas.filter((e) => e.tipo === 'entrada').length, 1);
});

test('un veto impide abrir, y queda anotado con su motivo', async () => {
  const fuente = { nombre: 'agente', vetos: async () => [{ motivo: 'dato de empleo a las 14:30' }] };
  const { b, reg } = bucleDe({ fuentes: [fuente] });

  const r = await b.ciclo();
  assert.equal(r.operables, 0);
  assert.equal(r.vetados, 1);
  assert.equal(b.estado.posiciones.size, 0, 'no se abre nada');

  const d = reg.entradas.find((e) => e.tipo === 'decision');
  assert.equal(d.vetado, true);
  assert.match(d.motivo, /empleo/);
});

test('un veto impide abrir pero NO impide salir', async () => {
  // Confundir las dos cosas dejaría posiciones atrapadas justo cuando algo va
  // mal, que es cuando más importa poder salir.
  const { b, reg } = bucleDe();
  await b.ciclo();
  assert.equal(b.estado.posiciones.size, 1);

  // Ahora el precio se da la vuelta y además hay un veto puesto.
  const b2 = crearBucle({
    obtenerMercados: async () => ({ mercados: [mercadoJugoso({ suelo: 100.3, yesBid: 0.40, yesAsk: 0.42, noBid: 0.58, noAsk: 0.60 })] }),
    obtenerPrediccion: async () => prediccionFalsa(),
    obtenerPrecio: async () => 99.9,
    fuentes: [{ nombre: 'operador', vetos: async () => [{ motivo: 'parado a mano' }] }],
    capital: 2000,
    reloj: () => 1_000_000,
    registro: reg,
  });
  b2.estado.posiciones.set('KXBTCD-TEST', { ticker: 'KXBTCD-TEST', lado: 'yes', contratos: 50, precioEntrada: 0.5 });

  const r = await b2.ciclo();
  assert.equal(r.operables, 0, 'con veto no se abre');
  assert.equal(r.salidas, 1, 'pero sí se sale');
  assert.equal(b2.estado.posiciones.size, 0);
});

test('una posición que llega al vencimiento se cierra sola y gratis', async () => {
  const { b, reg } = bucleDe({ mercados: [mercadoJugoso({ vencimiento: 999_000 })] });
  b.estado.posiciones.set('KXBTCD-TEST', { ticker: 'KXBTCD-TEST', lado: 'yes', contratos: 10, precioEntrada: 0.5 });

  await b.ciclo();
  assert.equal(b.estado.posiciones.size, 0);
  assert.ok(reg.entradas.some((e) => e.tipo === 'vencida'));
});

test('una vuelta que falla no tumba el proceso', async () => {
  const reg = cuaderno();
  let falla = true;
  const b = crearBucle({
    obtenerMercados: async () => { if (falla) throw new Error('la red'); return { mercados: [mercadoJugoso()] }; },
    obtenerPrediccion: async () => prediccionFalsa(),
    obtenerPrecio: async () => 100,
    capital: 2000, reloj: () => 1_000_000, registro: reg,
  });

  const malo = await b.ciclo();
  assert.match(malo.error, /la red/);
  assert.equal(b.estado.fallosSeguidos, 1);

  falla = false;
  const bueno = await b.ciclo();
  assert.equal(bueno.vistos, 1);
  assert.equal(b.estado.fallosSeguidos, 0, 'el contador se reinicia al ir bien');
});

test('fallar sin parar acaba deteniendo el bucle, en vez de girar en vacío', async () => {
  const reg = cuaderno();
  const b = crearBucle({
    obtenerMercados: async () => { throw new Error('roto'); },
    obtenerPrediccion: async () => prediccionFalsa(),
    obtenerPrecio: async () => 100,
    capital: 2000, reloj: () => 1_000_000, registro: reg,
  });

  b.arrancar();
  for (let i = 0; i < FALLOS_SEGUIDOS_MAX; i++) await b.ciclo();

  assert.equal(b.estado.corriendo, false, 'se para solo');
  const parada = reg.entradas.find((e) => e.tipo === 'parada');
  assert.ok(parada, 'y lo dice');
  assert.match(parada.motivo, /roto/);
  b.parar();
});

test('la cartera se rehace desde el cuaderno al reiniciar', () => {
  // Sin esto, un proceso que lleva días encendido se cree plano al arrancar y
  // vuelve a «comprar» lo que ya tenía.
  const posiciones = reconstruir([
    { t: '2026-01-01T00:00:00Z', tipo: 'entrada', ticker: 'A', lado: 'yes', contratos: 10, precio: 0.4 },
    { t: '2026-01-01T00:01:00Z', tipo: 'entrada', ticker: 'B', lado: 'no', contratos: 5, precio: 0.6 },
    { t: '2026-01-01T00:02:00Z', tipo: 'salida', ticker: 'A' },
    { t: '2026-01-01T00:03:00Z', tipo: 'decision', ticker: 'C', operar: false },
  ]);

  assert.deepEqual([...posiciones.keys()], ['B']);
  assert.equal(posiciones.get('B').contratos, 5);
});

// --- El cuaderno ------------------------------------------------------------

test('el cuaderno se escribe por el final y sobrevive a una línea rota', () => {
  const ruta = path.join(tmp(), 'd.jsonl');
  R.anotar({ tipo: 'decision', ticker: 'A', operar: true }, { ruta });
  R.anotar({ tipo: 'decision', ticker: 'B', operar: false, motivo: 'horquilla' }, { ruta });

  fs.appendFileSync(ruta, '{"tipo":"decision", esto no es\n');
  R.anotar({ tipo: 'decision', ticker: 'C', operar: false, motivo: 'otra' }, { ruta });

  const { entradas, rotas } = R.leer({ ruta });
  assert.equal(entradas.length, 3, 'lo que hay antes y después de la línea rota sigue valiendo');
  assert.equal(rotas, 1);
  assert.equal(entradas[0].ticker, 'A');
});

test('leer un cuaderno que no existe no es un error', () => {
  assert.deepEqual(R.leer({ ruta: path.join(tmp(), 'no-existe.jsonl') }), { entradas: [], rotas: 0 });
});

test('el resumen agrupa los motivos por familia, no por texto exacto', () => {
  // Los motivos llevan números dentro, así que contar cadenas exactas daría un
  // motivo distinto por mercado y el resumen no diría nada.
  const r = R.resumir([
    { t: '1', tipo: 'decision', operar: false, motivo: 'ventaja neta de 0.8¢, por debajo del mínimo de 2¢' },
    { t: '2', tipo: 'decision', operar: false, motivo: 'ventaja neta de 1.3¢, por debajo del mínimo de 2¢' },
    { t: '3', tipo: 'decision', operar: false, motivo: 'a ese plazo la banda del 90% contuvo el 100%: el modelo no está calibrado ahí' },
    { t: '4', tipo: 'decision', operar: true, evTotal: 2.5, coste: 30 },
  ]);

  assert.equal(r.vistas, 4);
  assert.equal(r.operables, 1);
  assert.equal(r.evTotal, 2.5);
  assert.deepEqual(r.motivos[0], { motivo: 'ventaja por debajo del mínimo', veces: 2 });
});

// --- Las series aprobadas ---------------------------------------------------

test('una serie sin aprobar no se opera, y ése es el estado por defecto', async () => {
  const ruta = path.join(tmp(), 'series.json');
  const fuente = Reglas.fuenteReglas({ ruta });

  const sinNada = await fuente.vetos({ mercados: [{ ticker: 'KXBTCD-26SEP-B88000' }] });
  assert.equal(sinNada.length, 1);
  assert.match(sinNada[0].motivo, /nadie ha aprobado/);

  // Tener ficha no basta: leerla no es aprobarla.
  Reglas.anotarFicha({ serie: 'KXBTCD', indice: 'Un índice', confianza: 'alta' }, { ruta });
  assert.equal((await fuente.vetos({ mercados: [{ ticker: 'KXBTCD-26SEP-B88000' }] })).length, 1);

  Reglas.aprobar('KXBTCD', { quien: 'nat', ruidoBase: 0.0003, ruta });
  assert.equal((await fuente.vetos({ mercados: [{ ticker: 'KXBTCD-26SEP-B88000' }] })).length, 0);
  assert.equal(Reglas.ruidoBaseDe('KXBTCD-26SEP-B88000', { ruta }), 0.0003);
});

test('aprobar exige nombre y ruido de base medido', () => {
  const ruta = path.join(tmp(), 'series.json');
  Reglas.anotarFicha({ serie: 'KXBTCD', indice: 'X' }, { ruta });

  assert.throws(() => Reglas.aprobar('KXBTCD', { ruidoBase: 0.0003, ruta }), /quién aprueba/);
  assert.throws(() => Reglas.aprobar('KXBTCD', { quien: 'nat', ruta }), /ruido de base/);
  assert.throws(() => Reglas.aprobar('OTRA', { quien: 'nat', ruidoBase: 0, ruta }), /no hay ficha/);
});

test('releer el reglamento retira la aprobación anterior', () => {
  // Si el reglamento cambió —que es la razón de volver a leerlo— la aprobación
  // de antes era sobre otro texto.
  const ruta = path.join(tmp(), 'series.json');
  Reglas.anotarFicha({ serie: 'KXBTCD', indice: 'Índice viejo' }, { ruta });
  Reglas.aprobar('KXBTCD', { quien: 'nat', ruidoBase: 0.0003, ruta });
  assert.equal(Reglas.cargar(ruta).KXBTCD.aprobado, true);

  Reglas.anotarFicha({ serie: 'KXBTCD', indice: 'Índice nuevo' }, { ruta });
  assert.equal(Reglas.cargar(ruta).KXBTCD.aprobado, false, 'hay que volver a mirarla');
  assert.equal(Reglas.cargar(ruta).KXBTCD.aprobadoPor, null);
});

test('la serie más específica manda sobre la más general', () => {
  const fichas = { KXBTC: { aprobado: true }, KXBTCD: { aprobado: false } };
  assert.equal(Reglas.fichaDe('KXBTCD-26SEP', fichas).serie, 'KXBTCD');
  assert.equal(Reglas.fichaDe('KXBTC-26SEP', fichas).serie, 'KXBTC');
});

test('el bucle entero no opera una serie sin aprobar, por buena que sea la ventaja', async () => {
  // El caso completo: el motor encuentra la mejor operación de su vida y el
  // registro de series la para porque nadie ha mirado contra qué liquida.
  const ruta = path.join(tmp(), 'series.json');
  const reg = cuaderno();
  const { b } = bucleDe({ fuentes: [Reglas.fuenteReglas({ ruta })], reg });

  const r = await b.ciclo();
  assert.equal(r.operables, 0);
  assert.equal(b.estado.posiciones.size, 0);
  assert.match(reg.entradas.find((e) => e.tipo === 'decision').motivo, /nadie ha aprobado/);
});

test('cada serie se evalúa con el ruido de base que se declaró al aprobarla', async () => {
  // Usar el de por defecto cuando hay uno firmado sería saltarse justo la parte
  // que la aprobación existía para fijar.
  const vistos = [];
  const b = crearBucle({
    obtenerMercados: async () => ({ mercados: [mercadoJugoso()] }),
    obtenerPrediccion: async () => prediccionFalsa(),
    obtenerPrecio: async () => 100,
    capital: 2000, reloj: () => 1_000_000, registro: cuaderno(),
    limites: { ruidoBase: 0.09 },
    limitesPara: (m) => { vistos.push(m.ticker); return { ruidoBase: 0.0001 }; },
  });

  await b.ciclo();
  assert.ok(vistos.length >= 1 && vistos.every((t) => t === 'KXBTCD-TEST'), 'se le pregunta por cada mercado');
  assert.equal(b.estado.posiciones.size, 1, 'y se abre con esos límites');
});

test('lo que se acaba de comprar no se vende en la misma vuelta', () => {
  // Abrir y revisar salidas ocurren en el mismo ciclo. No puede haber vaivén:
  // se compra al ask porque el justo está por encima, y vender pide que la puja
  // esté por encima del justo — o sea, puja por encima del ask, que no existe.
  const { b } = bucleDe();
  return b.ciclo().then(async () => {
    assert.equal(b.estado.posiciones.size, 1);
    const r = await b.ciclo();
    assert.equal(r.salidas, 0, 'sigue dentro');
    assert.equal(b.estado.posiciones.size, 1);
  });
});
