#!/usr/bin/env node
'use strict';

// Sonda temporal para dar con el endpoint real de CF Benchmarks.
//
// El que supuse a partir de su documentación devuelve 404 —no 401, así que no
// es cuestión de clave: la ruta no existe—. Desde el entorno donde se escribe
// este código no hay salida a cfbenchmarks.com, así que en vez de encadenar
// suposiciones se prueban varias candidatas de una vez y se mira cuál
// responde.
//
//   node scripts/probe-cf.js
//
// Si alguna devuelve 200 con JSON, ahí está la buena: pégame la salida y
// ajusto el adaptador. Este archivo se borra después.

const CANDIDATAS = [
  'https://www.cfbenchmarks.com/api/v1/values/latest?id=BRTI',
  'https://www.cfbenchmarks.com/api/v1/values?id=BRTI',
  'https://www.cfbenchmarks.com/api/v1/index/BRTI/values/latest',
  'https://www.cfbenchmarks.com/api/v1/indices/BRTI',
  'https://www.cfbenchmarks.com/api/v2/values/latest?id=BRTI',
  'https://api.cfbenchmarks.com/v1/values/latest?id=BRTI',
  'https://api.cfbenchmarks.com/api/v1/values/latest?id=BRTI',
  'https://www.cfbenchmarks.com/api/v1/assets',
  'https://www.cfbenchmarks.com/api/v1/values/latest?id=brti',
];

const CLAVE = process.env.CFBENCHMARKS_API_KEY || '';

function recorta(texto, max = 220) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

async function probar(url) {
  const inicio = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'mini-trading-platform/probe',
        ...(CLAVE ? { authorization: `Bearer ${CLAVE}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });

    const cuerpo = await res.text().catch(() => '');
    const tipo = res.headers.get('content-type') || '?';
    const marca = res.ok && tipo.includes('json') ? '  <-- ESTA' : '';

    console.log(`${String(res.status).padEnd(4)} ${String(Date.now() - inicio).padStart(5)} ms  ${tipo.split(';')[0].padEnd(24)} ${url}${marca}`);
    if (cuerpo) console.log(`      ${recorta(cuerpo)}`);
  } catch (err) {
    console.log(`ERR  ${String(Date.now() - inicio).padStart(5)} ms  ${''.padEnd(24)} ${url}`);
    console.log(`      ${recorta(err.message)}`);
  }
}

(async () => {
  console.log(`Probando ${CANDIDATAS.length} rutas de CF Benchmarks${CLAVE ? ' (con clave)' : ' (sin clave)'}...\n`);
  for (const url of CANDIDATAS) await probar(url);
  console.log('\nBusca la que responda 200 con JSON y pégame su salida.');
})();
