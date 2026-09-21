#!/usr/bin/env node
'use strict';

// Lista los eventos que el analizador cree que son el mismo en varias
// plataformas, con los títulos enfrentados y su puntuación. Sirve para
// auditarlos a ojo: un emparejamiento falso inventa un consenso entre mercados
// que no hablan de lo mismo, y en pantalla parece igual de fiable que uno bueno.
//
//   npm run matches              -- una muestra repartida por puntuación
//   npm run matches -- --todos   -- la lista entera
//   npm run matches -- --flojos  -- sólo los que rozan el umbral, que es donde
//                                   se esconden los falsos positivos

const providers = require('../src/providers');
const { clusterEvents } = require('../src/match');
const { analyzeEvents } = require('../src/analyze');

const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const FLOJOS = args.includes('--flojos');

const trunc = (t, n = 52) => {
  const s = String(t ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function barra(score) {
  const n = Math.round(score * 20);
  return '█'.repeat(n) + '·'.repeat(20 - n);
}

async function main() {
  console.log('Descargando el catálogo completo...\n');
  const { events, sources } = await providers.fetchAll({ full: true, timeoutMs: 25000 });

  for (const s of sources) {
    const estado = s.ok ? (s.partial ? 'parcial' : 'completo') : 'FALLO';
    console.log(`  ${s.platformLabel}: ${s.events} eventos (${estado})`);
  }

  const clusters = clusterEvents(events).filter((c) => c.events.length > 1);
  clusters.sort((a, b) => a.matchScore - b.matchScore);

  console.log(`\n${events.length} eventos → ${clusters.length} agrupados entre plataformas.\n`);

  // Los falsos positivos se concentran cerca del umbral: un 0,95 es casi
  // siempre el mismo mercado, un 0,52 casi nunca.
  const tramos = [
    ['0.50 - 0.60  (dudosos)', clusters.filter((c) => c.matchScore < 0.6)],
    ['0.60 - 0.75  (probables)', clusters.filter((c) => c.matchScore >= 0.6 && c.matchScore < 0.75)],
    ['0.75 - 1.00  (seguros)', clusters.filter((c) => c.matchScore >= 0.75)],
  ];

  console.log('Reparto por puntuación:');
  for (const [nombre, lista] of tramos) {
    console.log(`  ${nombre.padEnd(26)} ${String(lista.length).padStart(4)}`);
  }

  let mostrar;
  if (TODOS) {
    mostrar = clusters;
  } else if (FLOJOS) {
    mostrar = clusters.filter((c) => c.matchScore < 0.65);
  } else {
    // Una muestra de cada tramo, empezando por los dudosos.
    mostrar = [...tramos[0][1].slice(0, 15), ...tramos[1][1].slice(0, 8), ...tramos[2][1].slice(0, 5)];
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`Mostrando ${mostrar.length} de ${clusters.length}. Revisa si cada pareja es el MISMO contrato.`);
  console.log('─'.repeat(78));

  for (const c of mostrar) {
    console.log(`\n${c.matchScore.toFixed(3)}  ${barra(c.matchScore)}`);
    for (const e of c.events) {
      console.log(`   ${e.platformLabel.padEnd(19)} ${trunc(e.title)}`);
    }
    // Las opciones son la prueba definitiva: si los candidatos no coinciden,
    // el título engañaba.
    const anchor = c.events[0];
    console.log(`   opciones del ancla: ${anchor.options.slice(0, 4).map((o) => trunc(o.label, 22)).join(' · ')}${anchor.options.length > 4 ? ' …' : ''}`);
  }

  const analyses = analyzeEvents(events, { limit: Number.MAX_SAFE_INTEGER });
  const conArbitraje = analyses.filter((a) => a.arbitrage);
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`Eventos con arbitraje aparente: ${conArbitraje.length}`);

  // Un arbitraje sólo es real si las opciones cubren todos los desenlaces y se
  // pueden comprar todas en el mismo sitio. Estas cifras dicen si se cumple:
  // sumaMid muy por debajo de 1 significa que la lista de opciones está
  // incompleta, y entonces el "beneficio" es la parte que falta.
  console.log('\n  coste  opciones  sumaMid  excl  anid  plataforma  evento');
  for (const a of conArbitraje.slice(0, 15)) {
    const arb = a.arbitrage;
    const sumaMid = a.options.reduce((acc, o) => acc + (o.probability || 0), 0);
    const sumaCrudos = a.options.reduce((acc, o) => {
      const q = (o.platforms || []).find((x) => x.platform === arb.platform);
      return acc + (q && Number.isFinite(q.impliedProb) ? q.impliedProb : 0);
    }, 0);

    console.log(
      `  ${(arb.cost * 100).toFixed(1).padStart(5)}¢ ` +
      `${String(a.options.length).padStart(8)} ` +
      `${sumaCrudos.toFixed(3).padStart(8)} ` +
      `${String(a.mutuallyExclusive).padStart(5)} ` +
      `${String(Boolean(a.nestedThresholds)).padStart(5)}  ` +
      `${arb.platformLabel.slice(0, 10).padEnd(10)}  ${trunc(a.title, 34)}`
    );
    console.log(`         opciones: ${a.options.slice(0, 5).map((o) => trunc(o.label, 16)).join(' · ')}`);
  }

  if (conArbitraje.length) {
    console.log('\n  Trátalos como sospechosos, no como oportunidades: casi siempre son');
    console.log('  un emparejamiento falso, un tamaño irrisorio a ese precio, o reglas de');
    console.log('  resolución que no coinciden.');
  }

  console.log('\nPega esta salida en la conversación.');
}

main().catch((err) => {
  console.error('No se pudo completar:', err.message);
  process.exit(1);
});
