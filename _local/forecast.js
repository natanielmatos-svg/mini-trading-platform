'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {TtlCache} = require('./cache');
const cache = new TtlCache({ttlMs:86400000,maxEntries:64});
const root = path.join(__dirname,'..');
let worker = null;
let serial = 0;
const pending = new Map();

function closeWorker() {
  if (worker) { const previous = worker; worker = null; previous.kill(); }
  for (const job of pending.values()) {clearTimeout(job.timer);job.reject(new Error('Motor reiniciado o tiempo de cálculo agotado.'));}
  pending.clear();
}
function infer(values) {
  const python = process.env.FORECAST_PYTHON || path.join(root,'.venv-forecast',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if (!fs.existsSync(python)) return Promise.reject(new Error('Motor local no instalado. Consulta forecast/README.md.'));
  if (pending.size >= 4) return Promise.reject(new Error('Motor ocupado; vuelve a intentarlo en unos segundos.'));
  if (!worker) {
    const child = spawn(python,[path.join(root,'forecast/worker.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    worker = child;
    readline.createInterface({input:child.stdout}).on('line',line => {
      let message; try {message=JSON.parse(line);} catch {return;}
      const job=pending.get(message.id); if(!job)return;
      clearTimeout(job.timer); pending.delete(message.id);
      if(message.error) job.reject(new Error(message.error)); else job.resolve(message.result);
    });
    child.stderr.on('data',()=>{}); // La interfaz recibe errores del protocolo, nunca trazas ni credenciales.
    child.on('error',()=>{if(worker===child)closeWorker();});
    child.on('exit',()=>{if(worker===child)closeWorker();});
    child.stdin.on('error',()=>{if(worker===child)closeWorker();});
  }
  return new Promise((resolve,reject)=>{
    const id=++serial;
    const timer=setTimeout(closeWorker,180000);
    pending.set(id,{resolve,reject,timer});
    worker.stdin.write(JSON.stringify({id,values})+'\n');
  });
}
process.once('exit',()=>{if(worker)worker.kill();});

function prepare(candles,{now=Date.now(),market='crypto',clock=null}={}) {
  if(market==='stocks' && (!clock || !clock.isOpen)) return {ok:false,reason:'Mercado cerrado o reloj de sesión no disponible.'};
  if(!Array.isArray(candles) || candles.length<101)return {ok:false,reason:'Se requieren al menos 100 velas cerradas y una vela actual.'};
  if(candles.some((c,i)=>!Number.isFinite(c.close)||c.close<=0||!Number.isFinite(c.openTime)||!Number.isFinite(c.closeTime)||c.closeTime<c.openTime||(i>0 && c.openTime<=candles[i-1].openTime))) return {ok:false,reason:'Serie de precios inválida o desordenada.'};
  const current=candles.at(-1);
  if(market==='stocks' && current.closeTime-current.openTime>86400000)return {ok:false,reason:'Los bloques de bolsa superiores a un día requieren calendario de cierre; todavía no se pronostican.'};
  if(current.openTime>now || current.closeTime<=now)return {ok:false,reason:'No hay una vela actual: los datos están atrasados o el bloque terminó.'};
  const completed=candles.slice(0,-1).filter(c=>c.closeTime<=now && c.closed!==false);
  if(completed.length<100)return {ok:false,reason:'Historial insuficiente de velas cerradas.'};
  if(market==='crypto' && candles.some((c,i)=>i && c.openTime-candles[i-1].closeTime>1000))return {ok:false,reason:'El historial tiene huecos; no se emite pronóstico.'};
  const closesAt=market==='stocks' && clock.nextClose ? Math.min(current.closeTime+1,clock.nextClose) : current.closeTime+1;
  return {ok:true,completed,current,closesAt};
}
async function forecast(data,{market='crypto',clock=null,now=Date.now(),predict=infer}={}) {
  const prepared=prepare(data.candles,{market,clock,now});
  if(!prepared.ok)return prepared;
  const {completed,current,closesAt}=prepared;
  const key=[market,data.symbol,data.interval,data.source,completed.at(-1).closeTime,completed.at(-1).close].join(':');
  const model=await cache.wrap(key,()=>predict(completed.map(c=>c.close)));
  if(Date.now()>=closesAt && now>1e12 && Math.abs(Date.now()-now)<180000)return {ok:false,reason:'El bloque terminó durante el cálculo; solicita el siguiente.'};
  const price=current.close;
  const low=model.quantiles[0], high=model.quantiles[8];
  const direction=low>price?'alza':high<price?'baja':'sin ventaja clara';
  return {ok:true,symbol:data.symbol,interval:data.interval,source:data.source,demo:data.source==='demo',
    generatedAt:Date.now(),dataAsOf:data.fetchedAt,trainedThrough:completed.at(-1).closeTime,
    blockOpen:current.openTime,closesAt,referencePrice:price,referenceUnit:market==='stocks'?'USD':'USDT',
    direction,medianDirection:model.estimatedClose>price?'alza':model.estimatedClose<price?'baja':'plano',
    expectedChangePct:(model.estimatedClose/price-1)*100,range80:{low,high},...model,
    target:'Cierre de la vela de '+data.source+'; no es el promedio de liquidación de Kalshi.'};
}
module.exports={forecast,prepare,infer,closeWorker,cache};
