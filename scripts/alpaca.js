#!/usr/bin/env node
'use strict';

// Comprueba la clave de Alpaca y nada más.
//
//   npm run alpaca
//
// `npm run smoke` ya lo hace, pero de paso consulta Binance, Kraken,
// Polymarket, Kalshi y Manifold: para saber si una clave recién creada sirve,
// eso son veinte segundos de espera y mucho ruido. Esto tarda dos.
//
// Nunca imprime el secreto. Del identificador sólo salen los primeros
// caracteres: bastan para ver si se ha pegado el que era.

const alpaca = require('../src/alpaca');
const stocks = require('../src/stocks');
const { formatPrice, num } = require('../src/format');

const trunc = (t, max = 120) => {
  const s = String(t ?? '').replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

function pista(err) {
  const msg = String(err && err.message);

  if (/HTTP 40[13]/.test(msg) || /papel y las reales/.test(msg)) {
    return [
      'La clave no es válida para esa cuenta. Cosas que suelen ser:',
      '  · el secreto se ve una sola vez al crearla; si no lo guardaste, genera otra',
      '  · sobra un espacio o un salto de línea al copiar',
      '  · la clave se borró o se regeneró desde el panel de Alpaca',
    ].join('\n        ');
  }
  if (/HTTP 429/.test(msg)) return 'Has pasado el límite de peticiones. Espera un minuto.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|tunnel/.test(msg)) {
    return 'No hay salida a Internet desde aquí (proxy, firewall o red corporativa).';
  }
  return null;
}

async function main() {
  const id = process.env.ALPACA_KEY_ID || '';
  const secreto = process.env.ALPACA_SECRET_KEY || '';

  if (!id || !secreto) {
    console.error('Faltan variables de entorno:');
    if (!id) console.error('  ALPACA_KEY_ID');
    if (!secreto) console.error('  ALPACA_SECRET_KEY');
    console.error('\nSe sacan de https://app.alpaca.markets/ → API Keys. La cuenta gratuita sirve.');
    console.error('El secreto sólo se enseña al crear la clave: si no lo tienes, genera otra.');
    console.error('\n  export ALPACA_KEY_ID=...');
    console.error('  export ALPACA_SECRET_KEY=...');
    console.error('  npm run alpaca');
    process.exit(1);
  }

  // Del identificador, lo justo para reconocerlo. El secreto, nunca.
  console.log(`Clave ${id.slice(0, 6)}… (${id.length} caracteres), feed ${alpaca.FEED}.\n`);

  try {
    const reloj = await alpaca.fetchClock();
    const cuenta = /paper-api/.test(reloj.api || '') ? 'papel' : 'real';
    const cuando = reloj.isOpen ? reloj.nextClose : reloj.nextOpen;
    console.log(
      `  OK    Cuenta de ${cuenta}: el mercado está ${reloj.isOpen ? 'ABIERTO' : 'cerrado'}` +
        (cuando ? `, ${reloj.isOpen ? 'cierra' : 'abre'} ${new Date(cuando).toLocaleString('es-ES')}` : '')
    );
  } catch (err) {
    console.error(`  FALLO Reloj del mercado: ${trunc(err.message)}`);
    const p = pista(err);
    if (p) console.error(`        ${p}`);
    process.exit(1);
  }

  try {
    const { candles, source } = await alpaca.fetchCandles({ symbol: 'AAPL', interval: '1h', limit: 100 });
    const ultima = candles[candles.length - 1];
    console.log(`  OK    ${source}: ${candles.length} velas de 1h · AAPL cerró en ${formatPrice(ultima.close)}`);

    const fuera = candles.filter((c) => !stocks.enSesion(c.openTime)).length;
    if (fuera) console.log(`  AVISO ${fuera} velas caen fuera de la sesión regular (¿feed con horario extendido?)`);
  } catch (err) {
    console.error(`  FALLO Velas: ${trunc(err.message)}`);
    const p = pista(err);
    if (p) console.error(`        ${p}`);
    process.exit(1);
  }

  try {
    const q = await alpaca.fetchQuote({ symbol: 'AAPL' });
    console.log(`  OK    Precio AAPL: ${formatPrice(q.price)} (horquilla ${num(((q.ask - q.bid) / q.price) * 100, 3)}%)`);
  } catch (err) {
    // El libro puede no estar disponible fuera de sesión; no invalida la clave.
    console.log(`  AVISO Precio: ${trunc(err.message)}`);
  }

  console.log('\nLa clave funciona. Arranca con `npm start` y abre /acciones.html.');
}

main().catch((err) => {
  console.error('No se pudo completar la comprobación:', err.message);
  process.exit(1);
});
