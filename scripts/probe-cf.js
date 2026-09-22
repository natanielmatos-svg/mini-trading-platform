#!/usr/bin/env node
'use strict';

// Sonda temporal para CF Benchmarks, segunda vuelta.
//
// La primera dejó claro dónde está el problema: /api/v1/values?id=BRTI
// responde 400 "Unknown id", no 404, así que la función existe y lo que falla
// es el identificador. /api/v1/assets pide clave (401), pero `values` no.
//
// Esta vuelta hace dos cosas: buscar un listado que diga qué ids valen, y
// probar identificadores plausibles contra la función que ya sabemos buena.
//
//   node scripts/probe-cf.js

const CLAVE = process.env.CFBENCHMARKS_API_KEY || '';
const BASE = 'https://www.cfbenchmarks.com/api/v1';

// Rutas que podrían enumerar los índices disponibles.
const LISTADOS = ['/indices', '/index', '/values', '/families', '/products', '/ids', '/assets'];

// Identificadores plausibles para el índice de bitcoin en tiempo real y sus
// equivalentes de ethereum.
const IDS = [
  'BRTI', 'BRR', 'BRRNY', 'BTCUSD_RTI', 'BTCUSD_RR', 'BTCUSD',
  'ETHUSD_RTI', 'ETHUSD_RR', 'ETHUSD', 'BRTIUSD', 'brti',
];

function recorta(texto, max = 200) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

async function pedir(url) {
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
    return { status: res.status, tipo: (res.headers.get('content-type') || '?').split(';')[0], cuerpo };
  } catch (err) {
    return { status: 'ERR', tipo: '', cuerpo: err.message };
  }
}

(async () => {
  console.log(`CF Benchmarks${CLAVE ? ' (con clave)' : ' (sin clave)'} — segunda vuelta\n`);

  console.log('1) ¿Hay algún listado de índices?');
  for (const ruta of LISTADOS) {
    const { status, tipo, cuerpo } = await pedir(`${BASE}${ruta}`);
    const marca = status === 200 ? '  <-- ESTA' : '';
    console.log(`   ${String(status).padEnd(4)} ${tipo.padEnd(18)} ${ruta}${marca}`);
    if (status === 200 || (tipo.includes('json') && status !== 404)) console.log(`        ${recorta(cuerpo)}`);
  }

  console.log('\n2) ¿Qué identificador acepta /values?');
  for (const id of IDS) {
    const { status, tipo, cuerpo } = await pedir(`${BASE}/values?id=${encodeURIComponent(id)}`);
    const marca = status === 200 ? '  <-- ESTE' : '';
    console.log(`   ${String(status).padEnd(4)} ${tipo.padEnd(18)} id=${id}${marca}`);
    if (status === 200) console.log(`        ${recorta(cuerpo)}`);
  }

  console.log('\nPégame la salida. Si algo responde 200, con eso basta para ajustar el adaptador.');
})();
