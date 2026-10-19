#!/usr/bin/env node
'use strict';

// ¿Cómo van los pronósticos?
//
//   npm run pronosticos
//   npm run pronosticos -- --version v3
//
// Lee el registro del piloto BTC 15m y dice, por cada modelo, cuántos
// contratos acertó y si la muestra da para concluir algo. Lo segundo importa
// más que lo primero: «11 de 17» no significa nada sin el intervalo, y leerlo
// como una tasa de acierto es la forma más rápida de creerse rentable sin
// serlo.

const fs = require('node:fs');
const path = require('node:path');
const { evaluar } = require('../src/pronosticos');
const P = require('../src/potencia');
const { num } = require('../src/format');

const ETIQUETAS = {
  raw: 'TimesFM',
  candidate: 'IA local',
  last: 'Mantener precio',
  market: 'Kalshi',
};

function arg(nombre, pordefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const registro = path.resolve(__dirname, '..', 'datos/piloto-btc15m/events.jsonl');
if (!fs.existsSync(registro)) {
  console.error(`No hay registro del piloto en ${registro}.`);
  console.error('El piloto todavía no ha capturado nada, o la app corre desde otra carpeta.');
  process.exit(1);
}

const eventos = [];
for (const linea of fs.readFileSync(registro, 'utf8').split('\n')) {
  if (!linea.trim()) continue;
  try { eventos.push(JSON.parse(linea)); } catch { /* una línea a medio escribir no invalida el resto */ }
}

const { groups, coverage } = evaluar(eventos);
const pct = x => `${num(x * 100, 1)}%`;

console.log('');
console.log(`Piloto BTC 15m · ${coverage.samples} capturas · ${coverage.contracts} contratos · ${coverage.settled} liquidados`);
console.log(`${coverage.fixedWindowSamples} en la ventana fija · ${coverage.evaluated} puntuables (liquidado + predicción previa)`);

if (!coverage.evaluated) {
  console.log('');
  console.log('Todavía no hay ningún contrato puntuable. Sin liquidación oficial no se');
  console.log('puede saber quién acertó, y los pendientes no cuentan como fallos.');
  process.exit(0);
}

const soloVersion = arg('version');
for (const g of groups.filter(g => !soloVersion || g.version === soloVersion)) {
  console.log('');
  console.log(`── versión ${g.version} · ${g.n} contratos ${'─'.repeat(Math.max(0, 44 - String(g.version).length))}`);
  console.log('');
  console.log('  modelo            aciertos      intervalo 95%     equilibrio   veredicto');

  for (const [clave, etiqueta] of Object.entries(ETIQUETAS)) {
    const s = g.strategies[clave];
    const precio = s.meanCost;
    const d = P.diagnostico({ aciertos: s.wins, casos: g.n, precio });
    const celda = `${s.wins}/${g.n}`.padEnd(9);
    if (!d.ok) { console.log(`  ${etiqueta.padEnd(16)}${celda} ${d.reason}`); continue; }
    console.log(
      `  ${etiqueta.padEnd(16)}${celda}` +
      `${(pct(d.intervalo.bajo) + ' a ' + pct(d.intervalo.alto)).padStart(17)}` +
      `${pct(d.equilibrio.acierto).padStart(13)}` +
      `   ${d.concluyente ? (d.intervalo.bajo > d.equilibrio.acierto ? 'gana' : 'PIERDE') : 'no concluye'}`
    );
  }

  console.log('');
  for (const [clave, etiqueta] of Object.entries(ETIQUETAS)) {
    const s = g.strategies[clave];
    console.log(`  ${etiqueta.padEnd(16)}bruto ${num(s.gross, 2).padStart(7)} · tras comisión ilustrativa ${num(s.afterIllustrativeFees, 2).padStart(7)} · con 1¢ en contra ${num(s.afterFeesAndOneCentAdverseMove, 2).padStart(7)}`);
  }
}

console.log('');
console.log('El equilibrio es la tasa de acierto que hace falta sólo para no perder al');
console.log('precio medio pagado, comisión incluida.');
console.log('');
console.log('  gana          el intervalo entero queda por encima del equilibrio');
console.log('  PIERDE        el intervalo entero queda por debajo: pierde dinero');
console.log('  no concluye   el intervalo cruza el equilibrio; la muestra no distingue');
console.log('                una estrategia ganadora de una perdedora');
console.log('');
console.log('Un contrato teórico por caso, al ask anunciado. Sin prioridad de cola, sin');
console.log('latencia y sin fills verificados: no son beneficios reales.');
console.log('');
