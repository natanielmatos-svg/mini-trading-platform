'use strict';
// Exploratory counterfactual, NOT a simulated fill ledger or a trading strategy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const bytes=fs.readFileSync(path.join(root,'datos/piloto-btc15m/events.jsonl'));
const events=bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
const samples=events.filter(e=>e.type==='sample');
const results=new Map(events.filter(e=>e.type==='settlement').map(e=>[e.ticker,e.resultado]));
const first=new Map();
for(const e of samples.filter(e=>e.fixedWindowEligible))if(!first.has(e.ticker))first.set(e.ticker,e);
const rows=[];
for(const e of first.values()){
 if(!results.has(e.ticker))continue;
 const p=e.predictions.find(p=>p.source==='consolidado'&&p.unit==='USD'&&JSON.stringify(p.venues)===JSON.stringify(['binance','coinbase','gemini','kraken']));
 if(!p||!Number.isFinite(p.observation?.price))continue;
 const above=x=>e.operator==='>='?x>=e.threshold:x>e.threshold;
 const sides={raw:above(p.prediction.raw)?'yes':'no',candidate:above(p.prediction.candidate)?'yes':'no',last:above(p.observation.price)?'yes':'no',market:e.quotes.yesBid+e.quotes.yesAsk>=1?'yes':'no'};
 const row={ticker:e.ticker,at:e.requestedAt,result:results.get(e.ticker),version:p.prediction.version};
 for(const [name,side] of Object.entries(sides)){
  const cost=e.quotes[side+'Ask'],win=side===row.result;
  row[name]={side,cost,win,gross:(win?1:0)-cost,
   // Sensitivity assumption only: NOT actual fees by event/account/fill.
   illustrativeFee:Math.ceil((.07*cost*(1-cost)-1e-12)*100)/100};
 }
 rows.push(row);
}
const names=['raw','candidate','last','market'];
const groups=[...new Set(rows.map(r=>r.version))].map(version=>{
 const rs=rows.filter(r=>r.version===version);
 return {version,n:rs.length,strategies:Object.fromEntries(names.map(k=>[k,{wins:rs.filter(r=>r[k].win).length,
  gross:rs.reduce((s,r)=>s+r[k].gross,0),cost:rs.reduce((s,r)=>s+r[k].cost,0),
  afterIllustrativeFees:rs.reduce((s,r)=>s+r[k].gross-r[k].illustrativeFee,0),
  afterFeesAndOneCentAdverseMove:rs.reduce((s,r)=>s+r[k].gross-r[k].illustrativeFee-.01,0)}]))};
});
const report={generatedAt:new Date().toISOString(),inputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
 coverage:{samples:samples.length,contracts:new Set(samples.map(s=>s.ticker)).size,settled:results.size,fixedWindowSamples:samples.filter(s=>s.fixedWindowEligible).length},groups,rows,
 caveat:'Exploratorio seleccionado después de observar datos; sin validación independiente. Un contrato hipotético al ask anunciado por caso; sin prioridad, latencia ni verificación de fills. Comisión ilustrativa 0.07*p*(1-p) redondeada al céntimo; no tarifa certificada de cuenta/evento. No sumar como beneficio real. El cierre puntual neuronal no equivale al promedio oficial. Muestra pequeña correlacionada.'};
const dir=path.join(root,'datos/diagnosticos','research-'+Date.now());fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'events-snapshot.jsonl'),bytes);fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({dir,coverage:report.coverage,groups},null,2));
