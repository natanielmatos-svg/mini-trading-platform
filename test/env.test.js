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
    else fs.writeFileSync(RUTA, contenido);

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
