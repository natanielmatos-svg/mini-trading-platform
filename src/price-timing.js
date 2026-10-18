'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { consolidate } = require('./consolidated');
const VENUES = ['binance', 'coinbase', 'gemini', 'kraken'];
function createSampler({ prices, reference, market, onSample, dir, now = Date.now, maxBytes = 64 * 1024 * 1024 } = {}) {
  let timer, running = false, pending, latest, startedAt = null, count = 0, error = null;
  async function capture() {
    if (pending) return pending;
    pending = (async () => {
      const requestedAt = now();
      startedAt ??= requestedAt;
      const read = async fn => {
        const sentAt = now();
        try { const value=await fn(); return {sentAt,receivedAt:now(),value}; }
        catch { return { sentAt, receivedAt: now(), error: 'Fuente no disponible' }; }
      };
      const [spot, index, marketData] = await Promise.all([
        read(async () => consolidate(await prices({symbol:'BTCUSDT', venues:VENUES}))),
        read(() => reference({symbol:'BTCUSDT'})),
        market?read(market):Promise.resolve(null),
      ]);
      const row = { schema:1, symbol:'BTCUSDT', currency:'USD', requestedAt, completedAt:now(), spot, index,
        timestampMeaning:'spot.venues.at = captura local; index.value.at = origen del índice; no son relojes equivalentes' };
      if(marketData)row.market=marketData;
      fs.mkdirSync(dir,{recursive:true});
      const file = path.join(dir, 'btc-synchronized-'+new Date(startedAt ?? requestedAt).toISOString().replace(/[:.]/g,'-')+'.jsonl');
      const line = JSON.stringify(row)+'\n';
      if ((fs.existsSync(file)?fs.statSync(file).size:0)+Buffer.byteLength(line)>maxBytes) {
        running=false; error='Límite de almacenamiento alcanzado'; return row;
      }
      fs.appendFileSync(file,line); count++; latest=row; error=null;
      if(onSample)onSample(row);
      return row;
    })().catch(()=>{error='No se pudo guardar la muestra';}).finally(()=>{pending=null;});
    return pending;
  }
  async function tick() {
    const begin=now();
    await capture();
    if (running && now()-startedAt < 86400000) timer=setTimeout(tick,Math.max(0,2000-(now()-begin)));
    else running=false;
  }
  return {
    capture,
    start(){if(running)return;running=true;startedAt=now();void tick();},
    stop(){running=false;clearTimeout(timer);},
    status(){return {running,startedAt,count,error,lastSampleAt:latest?.completedAt??null,intervalMs:2000,durationHours:24,maxBytes};},
  };
}
module.exports={createSampler,VENUES};
