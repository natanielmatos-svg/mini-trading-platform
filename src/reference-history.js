'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', 'datos', 'indices');
function ruta(index) {
  if (!/^[A-Z0-9_]+$/.test(index)) throw new Error('Índice inválido');
  return path.join(ROOT, index + '.json');
}
function leer(index) {
  try { return JSON.parse(fs.readFileSync(ruta(index), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function velas(raw, now = Date.now()) {
  const buckets = new Map();
  for (const row of raw?.data?.payload || []) {
    let at = Number(row.time ?? row.timestamp);
    if (at < 1e12) at *= 1000;
    const value = Number(row.value), sec = Math.floor(at / 1000), minute = Math.floor(at / 60000) * 60000;
    if (!Number.isFinite(at) || !(value > 0) || !Number.isFinite(value) || minute + 60000 > now) continue;
    if (!buckets.has(minute)) buckets.set(minute, new Map());
    // No rellenar segundos perdidos ni inventar volumen.
    const old = buckets.get(minute).get(sec);
    if (!old || at > old.at) buckets.get(minute).set(sec, { at, value });
  }
  return [...buckets].filter(([, seconds]) => seconds.size === 60).map(([openTime, seconds]) => {
    const values = [...seconds.values()].sort((a, b) => a.at - b.at).map(r => r.value);
    return { openTime, closeTime: openTime + 59999, open: values[0], close: values.at(-1), high: Math.max(...values), low: Math.min(...values), mean60: values.reduce((a,b) => a+b,0)/60, volume: 0, closed: true };
  }).sort((a, b) => a.openTime - b.openTime);
}
function guardar(index, raw, now = Date.now()) {
  const all = new Map(leer(index).map(c => [c.openTime, c]));
  for (const candle of velas(raw, now)) all.set(candle.openTime, candle);
  const candles = [...all.values()].sort((a,b) => a.openTime - b.openTime).slice(-10000);
  fs.mkdirSync(ROOT, { recursive: true });
  const file = ruta(index), temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(candles)); fs.renameSync(temp, file);
  return candles;
}
function continuas(candles, now = Date.now()) {
  if (!candles.length || now - candles.at(-1).closeTime > 90000) return [];
  let start = candles.length - 1;
  while (start > 0 && candles[start].openTime - candles[start - 1].openTime === 60000) start--;
  return candles.slice(start);
}
module.exports = { leer, velas, guardar, continuas };
