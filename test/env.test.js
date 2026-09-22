'use strict';

// El cargador de .env.
//
// Existe porque la sintaxis para exportar una variable cambia con el shell
// —`export` en bash, `$env:X = "..."` en PowerShell, `set` en cmd— y depurar
// el shell en vez de la aplicación es una pérdida de tiempo garantizada.
//
// Lo que se fija aquí es la regla que importa: un .env NO pisa lo que ya
// estaba en el entorno. Al revés, una variable puesta para un arranque
// concreto (`PORT=3999 node server.js`) dejaría de funcionar en cuanto
// alguien creara un .env con otro puerto, y el fallo sería incomprensible.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RUTA = path.join(__dirname, '..', '.env');

// Se ejecuta en un proceso aparte: el módulo lee el archivo al cargarse y
// escribe en process.env, así que hacerlo aquí contaminaría los demás tests.
function conEnv(contenido, script, entorno = {}) {
  const habia = fs.existsSync(RUTA) ? fs.readFileSync(RUTA) : null;
  try {
    if (contenido === null) fs.rmSync(RUTA, { force: true });
    else fs.writeFileSync(RUTA, contenido); // acepta texto o Buffer

    return execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, ...entorno },
      cwd: path.join(__dirname, '..'),
    }).trim();
  } finally {
    if (habia !== null) fs.writeFileSync(RUTA, habia);
    else fs.rmSync(RUTA, { force: true });
  }
}

const LEER = "const e = require('./src/env'); console.log(JSON.stringify({ cargado: e.cargado, motivo: e.motivo, k: process.env.CLAVE_DE_PRUEBA, p: process.env.OTRA_DE_PRUEBA }));";

test('sin .env no pasa nada: no es obligatorio', () => {
  const r = JSON.parse(conEnv(null, LEER));
  assert.equal(r.cargado, false);
  assert.equal(r.motivo, 'no hay .env');
  assert.equal(r.k, undefined);
});

test('con .env, las variables llegan a process.env', () => {
  const r = JSON.parse(conEnv('CLAVE_DE_PRUEBA=valor-del-archivo\nOTRA_DE_PRUEBA=dos\n', LEER));
  assert.equal(r.cargado, true);
  assert.equal(r.motivo, null);
  assert.equal(r.k, 'valor-del-archivo');
  assert.equal(r.p, 'dos');
});

test('lo que ya está en el entorno manda sobre el archivo', () => {
  // Es la regla importante: `PORT=3999 node server.js` tiene que seguir
  // funcionando aunque el .env diga otro puerto.
  const r = JSON.parse(
    conEnv('CLAVE_DE_PRUEBA=valor-del-archivo\nOTRA_DE_PRUEBA=dos\n', LEER, { CLAVE_DE_PRUEBA: 'valor-del-entorno' })
  );
  assert.equal(r.cargado, true);
  assert.equal(r.k, 'valor-del-entorno', 'el entorno gana');
  assert.equal(r.p, 'dos', 'y el resto del archivo se sigue leyendo');
});

test('una variable vacía en el archivo no se toma por puesta', () => {
  // .env.example deja `ALPACA_KEY_ID=` sin rellenar: si eso contara como
  // clave, la aplicación intentaría autenticarse con una cadena vacía en vez
  // de decir que falta.
  const r = JSON.parse(conEnv('CLAVE_DE_PRUEBA=\n', LEER));
  assert.equal(r.cargado, true);
  assert.ok(!r.k, `debería quedar vacía, quedó ${JSON.stringify(r.k)}`);
});

test('un .env ilegible no tumba el arranque', () => {
  // Un archivo con basura no debe impedir arrancar: las variables exportadas
  // a mano siguen valiendo y la aplicación funciona sin claves.
  const salida = conEnv('esto no es\x00un archivo válido\n', "const e = require('./src/env'); console.log(e.cargado);");
  assert.match(salida, /true|false/, 'devuelve un resultado en vez de lanzar');
});

test('.env.example está y no lleva ningún secreto', () => {
  const ejemplo = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(ejemplo, /ALPACA_KEY_ID=/);
  assert.match(ejemplo, /ALPACA_SECRET_KEY=/);

  // Toda clave del ejemplo tiene que estar vacía o comentada.
  for (const linea of ejemplo.split('\n')) {
    if (!linea.trim() || linea.trim().startsWith('#')) continue;
    const [, valor = ''] = linea.split('=');
    assert.equal(valor.trim(), '', `el ejemplo trae un valor: ${linea}`);
  }

  const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m, '.env tiene que estar en .gitignore');
});

// --- Codificaciones de Windows ---------------------------------------------

// El Bloc de notas guarda UTF-8 con BOM y `>` de PowerShell escribe UTF-16.
// Node no lo tiene en cuenta: el BOM se pega al nombre de la PRIMERA variable
// —`\uFEFFALPACA_KEY_ID`— así que `process.env.ALPACA_KEY_ID` queda sin
// definir y la aplicación dice que falta una clave que está escrita ahí
// mismo. Es el fallo más desconcertante posible y en Windows es el caso
// normal, no el raro.

const LINEAS = 'CLAVE_DE_PRUEBA=valor\nOTRA_DE_PRUEBA=dos\n';

const CODIFICACIONES = [
  ['UTF-8 sin BOM', Buffer.from(LINEAS, 'utf8'), null],
  ['UTF-8 con BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINEAS, 'utf8')]), 'UTF-8 con BOM'],
  ['UTF-16LE con BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LINEAS, 'utf16le')]), 'UTF-16LE'],
  ['UTF-16LE sin BOM', Buffer.from(LINEAS, 'utf16le'), 'UTF-16LE sin BOM'],
  ['UTF-16BE con BOM', (() => {
    const b = Buffer.from(LINEAS, 'utf16le');
    b.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
  })(), 'UTF-16BE'],
];

for (const [nombre, bytes, esperado] of CODIFICACIONES) {
  test(`un .env en ${nombre} se lee igual`, () => {
    const r = JSON.parse(conEnv(bytes, LEER));
    assert.equal(r.cargado, true);
    // La PRIMERA variable es la que se pierde con un BOM: es la que importa.
    assert.equal(r.k, 'valor', `${nombre}: la primera variable no llegó`);
    assert.equal(r.p, 'dos');
  });
}

test('se dice qué codificación hubo que arreglar, y no se inventa una', () => {
  const leerArreglado = "const e = require('./src/env'); console.log(JSON.stringify({ arreglado: e.arreglado, k: process.env.CLAVE_DE_PRUEBA }));";

  for (const [nombre, bytes, esperado] of CODIFICACIONES) {
    const r = JSON.parse(conEnv(bytes, leerArreglado));
    assert.equal(r.arreglado, esperado, `${nombre}: se esperaba ${esperado}`);
    assert.equal(r.k, 'valor');
  }
});

test('un valor con acentos sobrevive a la normalización', () => {
  // Al convertir de UTF-16 es donde se estropearía, y un secreto puede
  // llevar cualquier carácter.
  const conAcentos = 'CLAVE_DE_PRUEBA=ñandú-Ω-€\nOTRA_DE_PRUEBA=dos\n';
  for (const [nombre, bytes] of [
    ['UTF-8 con BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(conAcentos, 'utf8')])],
    ['UTF-16LE con BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(conAcentos, 'utf16le')])],
  ]) {
    const r = JSON.parse(conEnv(bytes, LEER));
    assert.equal(r.k, 'ñandú-Ω-€', `${nombre}: se estropeó el valor`);
  }
});
