#!/usr/bin/env node
'use strict';

// Comprobación de despliegue: llama a las APIs reales de las tres plataformas y
// verifica que lo que devuelven se sigue pudiendo parsear y analizar.
//
//   npm run smoke
//
// Sale con código 1 si alguna fuente falla o si el análisis no produce ningún
// evento, para poder encadenarlo en un script de despliegue. Con --tolerante
// sólo falla si caen TODAS las fuentes, que es el criterio razonable para un
// reinicio automático: el agregador funciona con las que respondan.

const providers = require('../src/providers');
const { analyzeEvents } = require('../src/analyze');

const TOLERANTE = process.argv.includes('--tolerante');

function trunc(text, max = 90) {
  const clean = String(text).replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

async function main() {
  console.log('Consultando Polymarket, Robinhood/Kalshi y Manifold...\n');

  const { events, sources } = await providers.fetchAll({ limit: 40, timeoutMs: 15000 });

  let caidas = 0;
  for (const s of sources) {
    if (s.ok && s.events > 0) {
      console.log(`  OK    ${s.platformLabel}: ${s.events} eventos en ${s.elapsedMs} ms`);
    } else if (s.ok) {
      // Responde pero no devuelve nada: normalmente significa que cambió el
      // formato y el parser descarta todo, no que no haya mercados abiertos.
      caidas++;
      console.log(`  VACÍO ${s.platformLabel}: respondió sin eventos utilizables (¿cambió el formato?)`);
    } else {
      caidas++;
      console.log(`  FALLO ${s.platformLabel}: ${trunc(s.error)}`);
    }
  }

  const analyses = analyzeEvents(events, { limit: 5 });
  const cruzados = analyses.filter((a) => a.crossPlatform).length;

  console.log(`\n${events.length} eventos crudos → ${analyses.length} analizados, ${cruzados} contrastados entre plataformas.`);

  if (analyses.length === 0) {
    console.error('\nNingún evento analizable. El despliegue no está sirviendo nada útil.');
    process.exit(1);
  }

  console.log('\nMuestra:');
  for (const a of analyses.slice(0, 3)) {
    console.log(`  · ${trunc(a.title, 70)}`);
    console.log(`      ${a.verdict.text}`);
  }

  if (cruzados === 0) {
    console.log(
      '\nAviso: ninguna coincidencia entre plataformas. Puede ser normal si cada una\n' +
      'cubre temas distintos hoy, pero si se repite revisa el umbral de emparejamiento.'
    );
  }

  const falloTotal = TOLERANTE ? caidas === sources.length : caidas > 0;
  if (falloTotal) {
    console.error(`\n${caidas} de ${sources.length} fuentes no están utilizables.`);
    process.exit(1);
  }

  console.log('\nTodo correcto.');
}

main().catch((err) => {
  console.error('El smoke test no pudo completarse:', err.message);
  process.exit(1);
});
