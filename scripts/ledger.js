#!/usr/bin/env node
'use strict';

// Informe del registro de oportunidades.
//
//   npm run ledger              -- resumen y las señales más recientes
//   npm run ledger -- --todas   -- la lista entera
//   npm run ledger -- --cerradas -- sólo eventos que ya deberían haber resuelto
//
// Mientras el servidor corre, cada refresco del catálogo va anotando señales.
// Este informe las lee. La pregunta que responde, cuando haya pasado tiempo
// suficiente, es si las divergencias que detecta la app se cierran a favor de
// la plataforma barata —habría edge— o se cierran al azar —no lo hay.

const { leer, resumen, LEDGER_FILE, DIVERGENCIA_MINIMA } = require('../src/ledger');

const args = process.argv.slice(2);
const TODAS = args.includes('--todas');
const CERRADAS = args.includes('--cerradas');

const trunc = (t, n = 44) => {
  const s = String(t ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
const pts = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + ' pts' : '—');

function dias(desde, hasta = Date.now()) {
  if (!desde) return null;
  return (hasta - new Date(desde)) / 86400000;
}

function main() {
  const r = resumen();

  if (r.total === 0) {
    console.log('El registro está vacío.\n');
    console.log(`Fichero: ${LEDGER_FILE}`);
    console.log('\nSe llena solo mientras el servidor corre: cada refresco del catálogo');
    console.log('anota las señales nuevas. Arráncalo con "npm start" y déjalo.');
    console.log(`\nSe anota una divergencia cuando dos plataformas con dinero real`);
    console.log(`discrepan más de ${pts(DIVERGENCIA_MINIMA)} en la misma opción.`);
    return;
  }

  console.log(`Registro: ${r.total} señales`);
  console.log(`Desde ${new Date(r.primera).toLocaleString('es-ES')}`);
  console.log(`Hasta ${new Date(r.ultima).toLocaleString('es-ES')}`);

  const transcurridos = dias(r.primera);
  if (transcurridos !== null) {
    console.log(`Llevan acumulándose ${transcurridos.toFixed(1)} días.`);
  }

  console.log('\nPor tipo:');
  for (const [tipo, n] of Object.entries(r.porTipo)) {
    console.log(`  ${tipo.padEnd(14)} ${String(n).padStart(5)}`);
  }

  console.log('\nPor categoría:');
  const cats = Object.entries(r.porCategoria).sort((a, b) => b[1] - a[1]);
  for (const [cat, n] of cats.slice(0, 10)) {
    console.log(`  ${cat.padEnd(16)} ${String(n).padStart(5)}`);
  }

  if (r.divergenciaMedia !== null) {
    console.log(`\nDivergencia media entre plataformas: ${pts(r.divergenciaMedia)}`);
  }

  const registros = leer();
  const ahora = Date.now();

  // Los eventos que ya cerraron son los únicos que pueden decir algo: hasta que
  // resuelven, una divergencia no es ni acierto ni error.
  const cerradas = registros.filter((x) => x.cierraEn && new Date(x.cierraEn) < ahora);
  const abiertas = registros.length - cerradas.length;

  console.log(`\n${cerradas.length} señales sobre eventos que ya cerraron, ${abiertas} todavía abiertas.`);

  if (cerradas.length === 0) {
    console.log('\nTodavía no hay nada que evaluar. Las señales sólo dicen algo cuando');
    console.log('el evento resuelve: hasta entonces una divergencia no es ni acierto ni');
    console.log('error. Deja el servidor corriendo y vuelve dentro de unas semanas.');
  } else if (cerradas.every((x) => x.resuelto === null)) {
    console.log('\nHay señales cerradas pero sin resultado anotado. Comprobar cómo');
    console.log('resolvió cada evento requiere volver a consultar las plataformas, que');
    console.log('es el paso que falta por construir.');
  }

  let mostrar;
  if (TODAS) mostrar = registros;
  else if (CERRADAS) mostrar = cerradas;
  else mostrar = registros.slice(-20);

  if (mostrar.length) {
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`${mostrar.length} señales:`);
    console.log('─'.repeat(78));

    for (const s of mostrar) {
      const edad = dias(s.vistaEn);
      const cierre = s.cierraEn
        ? new Date(s.cierraEn) < ahora
          ? 'CERRADO'
          : `cierra en ${Math.max(0, Math.round(dias(ahora, new Date(s.cierraEn))))} d`
        : 'sin fecha';

      if (s.tipo === 'divergencia') {
        console.log(
          `\n  divergencia ${pts(s.divergencia).padStart(9)}  ${cierre.padEnd(14)} hace ${edad.toFixed(1)} d`
        );
        console.log(`    ${trunc(s.titulo, 60)}`);
        console.log(`    opción "${trunc(s.opcion, 28)}" · consenso ${pct(s.consenso)} · match ${s.matchScore?.toFixed(2)}`);
        console.log(`    comprar en ${s.comprarEn} a ${pct(s.comprarA)} · vender en ${s.venderEn} a ${pct(s.venderA)}`);
      } else {
        console.log(
          `\n  arbitraje ${pct(s.retorno).padStart(11)}  ${cierre.padEnd(14)} hace ${edad.toFixed(1)} d`
        );
        console.log(`    ${trunc(s.titulo, 60)}`);
        console.log(`    ${s.plataforma} · coste ${pct(s.coste)} · cobertura ${pct(s.cobertura)} · ${s.patas} patas`);
      }
    }
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`Fichero: ${LEDGER_FILE}`);
  console.log('Es JSONL: una línea JSON por señal, se puede abrir con cualquier cosa.');
}

main();
