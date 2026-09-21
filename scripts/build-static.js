#!/usr/bin/env node
'use strict';

// Genera una copia estática y autocontenida del analizador, con el análisis ya
// resuelto incrustado en la propia página. Sirve para compartir una instantánea
// del resultado donde no hay backend: la página detecta window.__ANALYSIS__ y
// se salta las llamadas a /api/predictions.
//
//   node scripts/build-static.js [salida.html] [--demo]
//
// Sin --demo consulta las plataformas de verdad y congela lo que devuelvan.

const fs = require('fs');
const path = require('path');

const { getPredictions } = require('../src/api');

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const outPath = path.resolve(args.find((a) => !a.startsWith('--')) || 'consenso-predicciones.html');

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'predicciones.html'), 'utf8');
  const analysis = await getPredictions({ demo, limit: 25 });

  const style = source.match(/<style>[\s\S]*?<\/style>/)[0];
  const body = source.match(/<body>([\s\S]*)<\/body>/)[1];

  // Fuera del servidor no existe la otra página, así que el enlace se sustituye
  // por una nota que deja claro que esto es una instantánea.
  const staticBody = body.replace(
    /<a href="\/index\.html">[^<]*<\/a>/,
    `<span class="brand-note">Instantánea${demo ? ' · datos de ejemplo' : ''}</span>`
  );

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Consenso de Predicciones</title>
${style}
<style>.brand-note{color:var(--ink-faint);font-size:0.75rem;}</style>
</head>
<body>
<script>window.__ANALYSIS__ = ${JSON.stringify(analysis)};</script>
${staticBody}
</body>
</html>
`;

  fs.writeFileSync(outPath, html);
  console.log(`${outPath} — ${analysis.events.length} eventos, ${(html.length / 1024).toFixed(0)} kB`);
}

main().catch((err) => {
  console.error('No se pudo generar la página estática:', err.message);
  process.exit(1);
});
