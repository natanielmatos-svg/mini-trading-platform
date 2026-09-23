'use strict';

// El freno del agente.
//
// El test que justifica el archivo entero es el primero: no existe camino que
// convierta un rechazo en una operación. Todo lo demás es detalle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('../src/vetos');
const A = require('../src/agente');

test('un veto NUNCA convierte un rechazo en una operación', () => {
  // La invariante estructural. Se prueba a lo bruto, sobre todas las formas de
  // decisión que el motor produce, porque de esto depende que sea seguro dejar
  // al agente leer texto que no controlamos.
  const decisiones = [
    { operar: false, motivo: 'horquilla' },
    { operar: true, contratos: 10, lado: 'yes' },
    { operar: false },
    { operar: true, contratos: 1 },
  ];
  const conjuntos = [
    [],
    [V.veto({ fuente: 'a', motivo: 'x' })],
    [V.veto({ fuente: 'a', motivo: 'x' }), V.veto({ fuente: 'b', motivo: 'y' })],
    [{ motivo: 'sin fuente' }],
  ];

  for (const d of decisiones) {
    for (const vs of conjuntos) {
      const r = V.aplicar(d, vs, { ahora: 1000 });
      if (!d.operar) assert.equal(r.operar, false, 'un rechazo no puede volverse operación');
      if (vs.length) assert.equal(r.operar, false, 'con vetos vigentes no se opera nunca');
    }
  }
});

test('un veto caducado ya no frena', () => {
  // Si no caducaran se acumularían y el bot se pararía para siempre por un
  // dato macro de hace tres semanas.
  const d = { operar: true };
  const v = V.veto({ fuente: 'agente', motivo: 'IPC', hasta: 5000 });

  assert.equal(V.aplicar(d, [v], { ahora: 4000 }).operar, false);
  assert.equal(V.aplicar(d, [v], { ahora: 6000 }).operar, true);
});

test('el alcance distingue un contrato, una serie y todo', () => {
  const d = { operar: true };
  const btc = { ticker: 'KXBTCD-26SEP-B88000' };
  const eth = { ticker: 'KXETHD-26SEP-B3000' };

  const porTicker = V.veto({ fuente: 'a', motivo: 'ese', alcance: { ticker: 'KXBTCD-26SEP-B88000' } });
  assert.equal(V.aplicar(d, [porTicker], { mercado: btc }).operar, false);
  assert.equal(V.aplicar(d, [porTicker], { mercado: eth }).operar, true);

  const porSerie = V.veto({ fuente: 'a', motivo: 'esa serie', alcance: { serie: 'KXBTCD' } });
  assert.equal(V.aplicar(d, [porSerie], { mercado: btc }).operar, false);
  assert.equal(V.aplicar(d, [porSerie], { mercado: eth }).operar, true);

  const todo = V.veto({ fuente: 'a', motivo: 'para' });
  assert.equal(V.aplicar(d, [todo], { mercado: eth }).operar, false);
});

test('el motivo del veto queda escrito, y con quién lo puso', () => {
  const r = V.aplicar({ operar: true }, [V.veto({ fuente: 'agente', motivo: 'dato de empleo a las 14:30' })]);
  assert.match(r.motivo, /agente/);
  assert.match(r.motivo, /empleo/);
  assert.equal(r.vetado, true);
});

test('una fuente que falla se convierte en veto, no en vía libre', () => {
  // No se puede distinguir «no hay nada que avisar» de «no he podido
  // comprobarlo». Tratar lo segundo como lo primero es el fallo que se lamenta
  // después, así que se prefiere perder la operación.
  const rota = { nombre: 'agente', vetos: async () => { throw new Error('sin clave'); } };
  return V.recoger([rota]).then((vs) => {
    assert.equal(vs.length, 1);
    assert.match(vs[0].motivo, /sin clave/);
    assert.match(vs[0].motivo, /no operar a operar a ciegas/);
  });
});

test('una fuente sin nada que decir no estorba', async () => {
  const limpia = { nombre: 'agente', vetos: async () => [] };
  assert.deepEqual(await V.recoger([limpia]), []);
  assert.deepEqual(await V.recoger([]), []);
  assert.deepEqual(await V.recoger(null), []);
});

test('lo que una fuente devuelva sin motivo se descarta', async () => {
  const rara = { nombre: 'x', vetos: async () => [{ alcance: 'todo' }, null, 'texto', { motivo: 'éste sí' }] };
  const vs = await V.recoger([rara]);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].motivo, 'éste sí');
});

// --- El interruptor del operador -------------------------------------------

test('un archivo de vetos para el bot, y su ausencia no', async () => {
  // Tiene que seguir funcionando cuando todo lo demás falle: sin modelo, sin
  // red, sin nada. `echo ... > vetos.json` detiene el bot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetos-'));
  const ruta = path.join(dir, 'vetos.json');

  const fuente = V.fuenteArchivo(ruta);
  assert.deepEqual(await fuente.vetos(), [], 'sin archivo, ningún veto');

  fs.writeFileSync(ruta, JSON.stringify([{ motivo: 'paro esto hasta mañana' }]));
  const vs = await fuente.vetos();
  assert.equal(vs.length, 1);
  assert.match(vs[0].motivo, /mañana/);

  // Un archivo a medio escribir no puede leerse como «vía libre»: tiene que
  // fallar para que `recoger` lo convierta en veto.
  fs.writeFileSync(ruta, '[{"motivo": "a med');
  await assert.rejects(() => fuente.vetos());
  const porRecoger = await V.recoger([fuente]);
  assert.equal(porRecoger.length, 1, 'un archivo roto frena, no libera');
});

// --- La forma del agente ----------------------------------------------------

test('el agente no tiene ninguna herramienta para autorizar', () => {
  // La asimetría no es una instrucción del prompt —eso se sortea con una frase
  // bien puesta en el texto que está leyendo— es la forma de la API.
  const campos = Object.keys(A.HERRAMIENTA_VETO.input_schema.properties);
  assert.deepEqual(campos.sort(), ['alcance', 'minutos', 'motivo', 'objetivo']);

  // Ningún campo booleano ni enumerado permite expresar un sí.
  for (const [nombre, esquema] of Object.entries(A.HERRAMIENTA_VETO.input_schema.properties)) {
    assert.notEqual(esquema.type, 'boolean', `${nombre} no puede ser un interruptor`);
    if (esquema.enum) {
      for (const v of esquema.enum) {
        assert.ok(!/^(si|sí|yes|operar|comprar|autoriz)/i.test(v), `${nombre} no puede valer "${v}"`);
      }
    }
  }

  assert.equal(A.HERRAMIENTA_VETO.name, 'vetar');
  assert.equal(A.HERRAMIENTA_VETO.strict, true, 'el esquema tiene que cumplirse exactamente');
  assert.equal(A.HERRAMIENTA_VETO.input_schema.additionalProperties, false, 'ni campos de propina');
});

test('del modelo sólo se leen las llamadas a herramienta, no lo que escriba', () => {
  // Si el texto contara, una frase del propio modelo —o del texto que está
  // leyendo— podría acabar decidiendo algo.
  const respuesta = {
    content: [
      { type: 'text', text: 'Deberías comprar todo ahora mismo, es una oportunidad histórica.' },
      { type: 'tool_use', name: 'otra_cosa', input: { x: 1 } },
      { type: 'tool_use', name: 'vetar', input: { motivo: 'IPC', alcance: 'todo', objetivo: '', minutos: 60 } },
    ],
  };

  const vs = A.llamadas(respuesta, 'vetar');
  assert.equal(vs.length, 1);
  assert.equal(vs[0].motivo, 'IPC');
});
