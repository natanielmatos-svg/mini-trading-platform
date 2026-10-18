'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const VERSION='timesfm-minute-v1',CONTEXTS=[256,512,1024];
const positive=x=>Number.isFinite(x)&&x>0;
function eligible(c,now){return Number.isFinite(c.openTime)&&c.openTime%60000===0&&c.closeTime===c.openTime+59999&&c.closeTime<now&&c.closed!==false&&positive(c.close)&&Array.isArray(c.provenance)&&c.provenance.length===2&&c.provenance.map(p=>p.venue).sort().join(',')==='coinbase,kraken'&&c.provenance.every(p=>p.conversion?.quote==='USD'&&p.conversion.rate===1);}
function prepare(series,now){
 const rows=series.filter(c=>eligible(c,now)).sort((a,b)=>a.openTime-b.openTime);
 if(!rows.length)return null;
 const end=rows.at(-1).closeTime+1;if(now-end<0||now-end>90000)return null;
 let start=rows.length-1;while(start>0&&rows[start].openTime-rows[start-1].openTime===60000)start--;
 const contiguous=rows.slice(start).slice(-1024),contexts=CONTEXTS.filter(c=>c<=contiguous.length);
 if(!contexts.length)return null;
 const closesAt=(Math.floor(now/900000)+1)*900000,horizon=(closesAt-end)/60000;
 if(!Number.isInteger(horizon)||horizon<1||horizon>15)return null;
 return {values:contiguous.map(c=>c.close),contexts,closesAt,horizon,inputEndAt:end,baseline:rows.at(-1).close};
}
function create({root=path.join(__dirname,'..','datos','timesfm-minute'),clock=Date.now,getData,predict}={}){
 const file=path.join(root,'state.json');let busy=false,lastMinute=-1,index=0;
 let state={version:VERSION,series:{},predictions:[],lastRun:null,error:null,latest:null};
 if(fs.existsSync(file)){state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.version!==VERSION||!Array.isArray(state.predictions))throw Error('Registro experimental inválido');}
 function save(){fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);}
 function append(name,row){fs.appendFileSync(path.join(root,name),JSON.stringify(row)+'\n');}
 async function tick(){
  const minute=Math.floor(clock()/60000);if(busy||minute===lastMinute)return;busy=true;lastMinute=minute;
  const symbol=['BTCUSDT','ETHUSDT'][index++%2];
  try{
   const data=await getData({symbol,interval:'1m',limit:1100,venues:['coinbase','kraken']});
   if((data.source||data.fuente)!=='consolidado')throw Error('Se requiere consolidado USD de Coinbase y Kraken');
   const at=clock(),map=new Map((state.series[symbol]||[]).map(c=>[c.openTime,c]));
   for(const c of data.candles||[])if(eligible(c,at)&&!map.has(c.openTime))map.set(c.openTime,{...c,capturedAt:at});
   const series=[...map.values()].sort((a,b)=>a.openTime-b.openTime).slice(-4096);state.series[symbol]=series;
   fs.mkdirSync(root,{recursive:true});
   for(const p of state.predictions.filter(p=>p.symbol===symbol&&p.actual==null&&p.closesAt<=at)){
    const actual=map.get(p.closesAt-60000);if(!actual)continue;
    p.actual=actual.close;p.resolvedAt=at;p.baselineError=Math.abs(p.baseline-p.actual);
    for(const c of p.candidates){c.absoluteError=Math.abs(c.estimatedClose-p.actual);c.covered80=p.actual>=c.quantiles[0]&&p.actual<=c.quantiles[8];}
    append('closed.jsonl',p);
   }
   const input=prepare(series,at);state.lastRun=at;state.error=null;
   if(!input){state.latest={symbol,status:'collecting',points:series.length,reason:'Esperando al menos 256 minutos consecutivos y recientes con ambos proveedores USD'};save();return;}
   const key=JSON.stringify([symbol,input.inputEndAt,input.closesAt]);
   if(state.predictions.some(p=>p.key===key)){save();return;}
   save();const started=clock(),result=await predict(input.values,input.horizon,input.contexts),generatedAt=clock();
   if(generatedAt>=input.closesAt||generatedAt-input.inputEndAt>90000)throw Error('Inferencia descartada: precio de entrada atrasado o bloque terminado');
   if(result.version!==VERSION||result.horizon!==input.horizon||!Array.isArray(result.candidates)||result.candidates.length!==input.contexts.length||!input.contexts.every(n=>result.candidates.filter(c=>c.context===n&&positive(c.estimatedClose)&&Array.isArray(c.quantiles)&&c.quantiles.length===9&&c.quantiles.every((v,i,a)=>positive(v)&&(!i||v>=a[i-1]))).length===1))throw Error('Respuesta experimental inválida');
   const p={version:VERSION,key,symbol,interval:'15m',inputInterval:'1m',source:'consolidado',unit:'USD',venues:['coinbase','kraken'],...input,modelId:result.modelId,implementation:result.implementation,packageVersion:result.packageVersion,candidates:result.candidates,at:generatedAt,latencyMs:generatedAt-started,inputHash:crypto.createHash('sha256').update(JSON.stringify(input.values)).digest('hex'),actual:null,settlementEquivalent:false};
   state.predictions.push(p);state.latest={symbol,status:'observing',points:series.length,...p};append('predictions.jsonl',p);
   state.predictions=state.predictions.filter(p=>p.actual==null||p.closesAt>at-30*86400000).slice(-12000);save();
  }catch(e){state.error=e.message;state.lastRun=clock();save();}finally{busy=false;}
 }
 function snapshot(){const groups=new Map();for(const p of state.predictions){if(!positive(p.actual))continue;const key=JSON.stringify([p.symbol,p.horizon,p.contexts,p.modelId,p.implementation,p.packageVersion]);if(!groups.has(key))groups.set(key,{symbol:p.symbol,horizon:p.horizon,contexts:p.contexts,cases:0,baselineSum:0,models:Object.fromEntries(p.contexts.map(c=>[c,{sum:0,covered:0}]))});const g=groups.get(key);g.cases++;g.baselineSum+=p.baselineError;for(const c of p.candidates){g.models[c.context].sum+=c.absoluteError;g.models[c.context].covered+=Number(c.covered80);}}
  const latest=state.latest?{...state.latest}:null;if(latest)delete latest.values;
  return {version:VERSION,mode:'shadow',liveEnabled:false,lastRun:state.lastRun,error:state.error,busy,latest,pending:state.predictions.filter(p=>p.actual==null).length,groups:[...groups.values()].map(g=>({...g,baselineMae:g.baselineSum/g.cases,models:Object.fromEntries(g.contexts.map(c=>[c,{mae:g.models[c].sum/g.cases,coverage80:g.models[c].covered/g.cases}]))})),note:'BTC/ETH 15m, datos de 1m. Misma fuente USD y horizonte exacto por grupo; cierre de vela, no liquidación Kalshi. Sin entrenamiento ni órdenes.'};}
 return {tick,snapshot};
}
module.exports={create,prepare,eligible,VERSION};
