#!/usr/bin/env node
'use strict';

// ¿Deja dinero entrar y vender antes del vencimiento?
//
//   npm run precio-contrato
//   npm run precio-contrato -- --horizonte 3
//
// Entrena, caminando hacia adelante, un modelo del PRECIO del contrato dentro
// de N minutos, y mide qué habría pasado operando sólo cuando el modelo promete
// beneficio. Nunca entrena con un par que siguiera abierto en el momento de
// entrar: eso sería usar el futuro.

const fs = require('node:fs');
const path = require('node:path');
const PC = require('../src/precio-contrato');
const P = require('../src/potencia');
const { num } = require('../src/format');

function arg(nombre, pordefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const registro = path.resolve(__dirname, '..', 'datos/piloto-btc15m/events.jsonl');
if (!fs.existsSync(registro)) {
  console.error(`No hay registro del piloto en ${registro}.`);
  process.exit(1);
}

const minutos = Number(arg('horizonte', 5));
if (!(minutos > 0 && minutos < 15)) { console.error('El horizonte va entre 1 y 14 minutos.'); process.exit(1); }
const horizonteMs = minutos * 60000;

const eventos = [];
for (const linea of fs.readFileSync(registro, 'utf8').split('\n')) {
  if (!linea.trim()) continue;
  try { eventos.push(JSON.parse(linea)); } catch { /* línea a medio escribir */ }
}

const rutas = PC.rutas(eventos);
const muestras = PC.muestras(eventos, { horizonteMs });

const c = x => (x * 100 >= 0 ? '+' : '') + num(x * 100, 2) + 'c';

console.log('');
console.log(`Precio del contrato a ${minutos} min · ${rutas.size} contratos con trayectoria · ${muestras.length} pares entrada/salida`);

if (muestras.length < PC.MINIMO_ENTRENAMIENTO) {
  console.log('');
  console.log(`Hacen falta al menos ${PC.MINIMO_ENTRENAMIENTO} pares para ajustar nada; hay ${muestras.length}.`);
  console.log('Cada contrato de 15 minutos da unos 20 pares, así que son unos diez contratos');
  console.log('completos. Déjalo recolectar y vuelve.');
  process.exit(0);
}

// Qué habría dado entrar SIEMPRE: la base contra la que se compara el modelo.
const todas = PC.rendimiento(muestras.map(m => ({ ...m, prediccion: Infinity })), -Infinity);
console.log('');
console.log(`Entrar siempre, sin modelo:  ${c(todas.media)} por contrato  (±${num(todas.error * 100, 2)})  sobre ${todas.operaciones}`);
console.log('Eso es lo que cuesta la horquilla más las dos comisiones. El modelo tiene que');
console.log('superarlo para existir.');

const predicciones = PC.caminar(muestras, { horizonteMs });
if (!predicciones.length) {
  console.log('');
  console.log('Ningún par tuvo suficiente historia cerrada por delante para evaluarse.');
  process.exit(0);
}

console.log('');
console.log(`Evaluado caminando hacia adelante sobre ${predicciones.length} pares:`);
console.log('');
console.log('  si opero cuando promete más de   operaciones    neto/contrato     ganadas   veredicto');

for (const umbral of [0, 0.01, 0.02, 0.03]) {
  const r = PC.rendimiento(predicciones, umbral);
  if (!r.operaciones) {
    console.log(`  ${c(umbral).padStart(28)}              0            —           —   nunca entra`);
    continue;
  }
  // ¿Es distinguible de cero, o es ruido con forma de resultado?
  const d = P.diagnostico({ aciertos: r.aciertos, casos: r.operaciones, precio: 0.5 });
  const dosErrores = Math.abs(r.media) > 2 * r.error;
  const veredicto = !dosErrores ? 'indistinguible de cero'
    : r.media > 0 ? 'POSITIVO · comprobar con más muestra'
    : 'negativo';
  console.log(
    `  ${c(umbral).padStart(28)}` +
    `${String(r.operaciones).padStart(15)}` +
    `${(c(r.media) + ' ±' + num(r.error * 100, 2)).padStart(17)}` +
    `${(num(100 * r.aciertos / r.operaciones, 0) + '%').padStart(12)}   ${veredicto}`
  );
}

console.log('');
console.log('«Indistinguible de cero» significa que el neto no llega a dos errores estándar:');
console.log('con esta muestra, ese resultado es compatible con no tener ninguna ventaja.');
console.log('');
console.log('Un contrato teórico por par, entrando al ask y saliendo al bid anunciados.');
console.log('Sin prioridad de cola, sin latencia y sin fills verificados.');
console.log('');
