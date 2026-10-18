'use strict';
const fs=require('node:fs'),path=require('node:path');
const FILE=path.join(__dirname,'..','datos','neural','evidence.json');
const VERSION=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,'forecast-neural.js'))).update(fs.readFileSync(path.join(__dirname,'..','forecast','worker.py'))).digest('hex').slice(0,16);
// Una predicción por bloque y origen; nunca sustituirla después de conocer el cierre.
function record(result,data,{file=FILE,now=Date.now()}={}){
  let rows=[];try{rows=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(rows))throw Error('Registro inválido');}catch(e){if(e.code!=='ENOENT')throw e;}
  const source=data.source||data.fuente;
  const venues=(data.consolidado?.venues||[]).filter(v=>v.usado).map(v=>v.id).sort().join(',');
  const group=JSON.stringify([data.symbol,data.interval,source,venues,VERSION]);
  for(const r of rows){
    if(r.group!==group||r.actual!=null||r.closesAt>=now)continue;
    const candle=data.candles.find(c=>c.closeTime+1===r.closesAt&&c.closed!==false&&c.closeTime<now);
    if(candle&&Number.isFinite(candle.close)&&candle.close>0){r.actual=candle.close;r.scoredAt=now;r.absoluteError=Math.abs(r.predicted-r.actual);r.baselineError=Number.isFinite(r.baseline)?Math.abs(r.baseline-r.actual):null;}
  }
  if(result.ok&&!result.demo&&result.generatedAt<result.closesAt&&result.closesAt>now&&!rows.some(r=>r.group===group&&r.closesAt===result.closesAt)){
    rows.push({group,symbol:data.symbol,interval:data.interval,source,venues,model:result.modelId,generatedAt:result.generatedAt,closesAt:result.closesAt,predicted:result.estimatedClose,baseline:result.baseline?.price??null,actual:null});
  }
  rows=rows.slice(-2000);fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(rows));fs.renameSync(temp,file);
  const scored=rows.filter(r=>r.group===group&&Number.isFinite(r.actual));
  const paired=scored.filter(r=>Number.isFinite(r.baselineError));
  return {samples:scored.length,pairedSamples:paired.length,mae:scored.length?scored.reduce((s,r)=>s+r.absoluteError,0)/scored.length:null,baselineMae:paired.length?paired.reduce((s,r)=>s+r.baselineError,0)/paired.length:null,pairedMae:paired.length?paired.reduce((s,r)=>s+r.absoluteError,0)/paired.length:null,pending:rows.filter(r=>r.group===group&&r.actual==null).length,target:'Cierre de la misma serie de velas; no liquidación Kalshi',retainedLimit:2000};
}
module.exports={record};
