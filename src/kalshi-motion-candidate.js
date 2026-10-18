'use strict';
const {createHash}=require('node:crypto');
const {fit,logit}=require('./settlement-probability');
const VERSION='kalshi-brti-motion-logistic-v1',MINIMUM=80;
const NAMES=['distancePct','secondsRemaining','return5s','return15s','return60s','range60s','yesAsk','noAsk','spread','depthImbalance'];
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
function features(s){
 const f=s.marketFeatures,b=s.book;
 if(s.type!=='sample'||!s.ticker?.startsWith('KXBTC15M-')||f?.version!=='kalshi-market-features-v1'||!f.usableReference||!s.freshBook||s.unit!=='USD'||!['>=','>'].includes(s.operator)||!s.rulesHash)return null;
 const at=f.frozenAt;
 if(!Number.isFinite(at)||at!==s.at||at>=s.closesAt||Math.abs(s.closesAt-at-600000)>30000||f.observedAt>at||f.referenceAt>at||at-f.referenceAt>15000||b.at>at||at-b.at>10000)return null;
 const w=f.movement?.windows;
 if(!w||![5,15,60].every(n=>w[n]?.complete)||f.movement.cutoff>at)return null;
 const levels=side=>(b[side]||[]).filter(l=>Number.isFinite(l.precio)&&l.precio>0&&l.precio<1&&Number.isFinite(l.cantidad)&&l.cantidad>0).sort((a,b)=>b.precio-a.precio);
 const yes=levels('yes'),no=levels('no');if(!yes.length||!no.length||yes[0].precio+no[0].precio>1)return null;
 const dy=yes.slice(0,3).reduce((n,l)=>n+l.cantidad,0),dn=no.slice(0,3).reduce((n,l)=>n+l.cantidad,0);
 const x=[f.thresholdDistancePct,f.secondsRemaining,w[5].returnPct,w[15].returnPct,w[60].returnPct,w[60].rangePct,1-no[0].precio,1-yes[0].precio,1-no[0].precio-yes[0].precio,(dy-dn)/(dy+dn)];
 if(!x.every(Number.isFinite))return null;
 return {x,at,key:JSON.stringify([VERSION,'BRTI','USD',s.operator,s.rulesHash]),marketP:(yes[0].precio+1-no[0].precio)/2};
}
function propose(sample,history,settlements){
 const f=features(sample),base={version:VERSION,active:false,prospectivelyValidated:false,minimum:MINIMUM};
 if(!f)return {...base,status:'ineligible',reason:'Falta cobertura BRTI de 5/15/60 segundos, libro reciente o trazabilidad.'};
 const seen=new Set(),rows=[];
 for(const s of [...history].sort((a,b)=>a.at-b.at)){
  const h=features(s),r=settlements.get(s.ticker);
  if(!h||h.key!==f.key||s.ticker===sample.ticker||seen.has(s.ticker)||!r||!['yes','no'].includes(r.resultado)||!(r.at<f.at&&r.at>=s.closesAt))continue;
  seen.add(s.ticker);rows.push({ticker:s.ticker,at:h.at,resolvedAt:r.at,x:h.x,y:r.resultado==='yes'?1:0});
 }
 const selected=rows.slice(-500),calibration=selected.slice(-20),training=selected.slice(0,-20).filter(r=>r.resolvedAt<calibration[0]?.at);
 const balanced=a=>[0,1].every(y=>a.filter(r=>r.y===y).length>=5);
 if(training.length<60||calibration.length<20||!balanced(training)||!balanced(calibration))return {...base,status:'warming',availableContracts:selected.length,trainingSamples:training.length,calibrationSamples:calibration.length,reason:'Requiere 60 contratos de ajuste y 20 posteriores de calibración, con etiquetas previas y ambos resultados.'};
 const model=fit(training.map(r=>r.x),training.map(r=>r.y)),calibrator=fit(calibration.map(r=>[logit(model,r.x)]),calibration.map(r=>r.y),.2);
 const artifact={version:VERSION,key:f.key,features:NAMES,model,calibrator,training,calibration,label:'official Kalshi YES/NO'};
 return {...base,status:'candidate',at:f.at,key:f.key,pYes:sigmoid(logit(calibrator,[logit(model,f.x)])),marketP:f.marketP,trainingSamples:training.length,calibrationSamples:20,modelId:createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),artifact};
}
function summarize(history,settlements){
 const groups=new Map();let latest=null;
 for(const s of history){const p=s.motionProbability;if(p)latest=p;if(p?.status!=='candidate')continue;
  const f=features(s);if(!f||p.at!==s.at||p.key!==f.key)continue;
  const g=groups.get(f.key)||{key:f.key,evaluated:0,pending:0,brierSum:0,marketSum:0,correct:0};groups.set(f.key,g);
  const r=settlements.get(s.ticker);if(!r||!['yes','no'].includes(r.resultado)||r.at<s.closesAt){g.pending++;continue;}
  const y=r.resultado==='yes'?1:0;g.evaluated++;g.brierSum+=(p.pYes-y)**2;g.marketSum+=(p.marketP-y)**2;g.correct+=Number((p.pYes>=.5)===(y===1));
 }
 return {version:VERSION,latest,active:false,validated:false,groups:[...groups.values()].map(g=>({key:g.key,evaluated:g.evaluated,pending:g.pending,correct:g.correct,brier:g.evaluated?g.brierSum/g.evaluated:null,marketBrier:g.evaluated?g.marketSum/g.evaluated:null})),note:'Sólo pronósticos nuevos congelados; calibración no cuenta como evaluación. Sin órdenes ni afirmación de rentabilidad.'};
}
module.exports={VERSION,MINIMUM,NAMES,features,propose,summarize};
