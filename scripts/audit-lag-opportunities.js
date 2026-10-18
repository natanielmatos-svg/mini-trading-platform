'use strict';
// Read-only audit: no historical trades, policy selection, or order submission.
const fs=require('node:fs'),path=require('node:path');
const {readJsonl}=require('../src/read-jsonl'),{quote,POLICY}=require('../src/kalshi-lag-lab');
const root=path.join(__dirname,'..'),dir=path.join(root,'datos/diagnosticos/timing');
const counts={samples:0,valid:0,comparable:0,movesOverThreshold:0,unchangedBook:0,rawSignalMatches:0},spreads=[],moves=[],latencies=[],files=[],contracts=new Set(),sources={};let first=null,last=null;
// Earlier files predate the market-book instrumentation and cannot answer this question.
for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')&&n>='btc-synchronized-2026-10-07T00-10').sort()){
 let recent=[],used=0;
 for(const row of readJsonl(path.join(dir,name))){if(!row.market)continue;used++;counts.samples++;first=first==null?row.completedAt:Math.min(first,row.completedAt);last=Math.max(last||0,row.completedAt);latencies.push(row.completedAt-row.requestedAt);
  const q=quote(row);if(!q)continue;counts.valid++;contracts.add(q.ticker);sources[q.bookSource]=(sources[q.bookSource]||0)+1;spreads.push(q.yesAsk-q.yesBid);
  const p=[...recent].reverse().find(p=>p.ticker===q.ticker&&q.at-p.at>=POLICY.lookbackMs&&q.at-p.at<=POLICY.lookbackMs+3000);
  if(p&&q.indexAt>p.indexAt){counts.comparable++;const move=Math.abs(100*(q.indexPrice/p.indexPrice-1)),unchanged=Math.abs(q.mid-p.mid)<=POLICY.unchangedMid;moves.push(move);if(move>=POLICY.movePct)counts.movesOverThreshold++;if(unchanged)counts.unchangedBook++;if(move>=POLICY.movePct&&unchanged)counts.rawSignalMatches++;}
  recent.push(q);recent=recent.filter(p=>q.at-p.at<=20000);
 }
 if(used)files.push({name,samples:used});
}
const quantile=(a,p)=>{const s=[...a].sort((a,b)=>a-b);return s.length?s[Math.floor((s.length-1)*p)]:null;};
const result={generatedAt:new Date().toISOString(),policy:POLICY,period:{first,last},counts,contracts:contracts.size,sources,spreadUSD:{median:quantile(spreads,.5),p90:quantile(spreads,.9)},absoluteMove10sPct:{median:quantile(moves,.5),p90:quantile(moves,.9),max:moves.length?Math.max(...moves):null},captureLatencyMs:{median:quantile(latencies,.5),p90:quantile(latencies,.9)},files,limitations:['Muestras solapadas no son operaciones independientes.','Sólo exploración de cobertura; ningún backtest se presenta como resultado prospectivo.','No se reducen umbrales basándose en esta muestra.']};
fs.writeFileSync(path.join(root,'datos/diagnosticos/lag-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
