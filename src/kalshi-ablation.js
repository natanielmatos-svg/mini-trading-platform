'use strict';
const hybrid=require('./kalshi-hybrid');
const VERSION='kalshi-ablation-v1',VARIANTS=['full','without-timesfm','brti-only'];
function propose(sample,history,settlements){const forecasts=Object.fromEntries(VARIANTS.map(v=>[v,hybrid.propose(sample,history,settlements,v)]));return {version:VERSION,at:sample.at,key:forecasts.full.key||null,forecasts,active:false};}
function summarize(history,settlements){const groups=new Map(),seen=new Set();let pending=0;
 for(const s of [...history].sort((a,b)=>a.at-b.at)){const a=s.ablation;if(a?.version!==VERSION||a.at!==s.at||!Number.isFinite(s.at)||!Number.isFinite(s.closesAt)||s.at>=s.closesAt||!a.key||hybrid.features(s)?.key!==a.key||seen.has(s.ticker)||!VARIANTS.every(v=>{const p=a.forecasts?.[v];return p?.status==='candidate'&&p.variant===v&&p.at===s.at&&p.key===a.key&&Number.isFinite(p.pYes)&&p.pYes>=0&&p.pYes<=1;}))continue;
 seen.add(s.ticker);const r=settlements.get(s.ticker);if(!r||!Number.isFinite(r.at)||!['settled','finalized'].includes(r.status)||!['yes','no'].includes(r.resultado)||r.at<s.closesAt){pending++;continue;}
 if(!groups.has(a.key))groups.set(a.key,{key:a.key,cases:0,models:Object.fromEntries(VARIANTS.map(v=>[v,{correct:0,brierSum:0}]))});const g=groups.get(a.key);g.cases++;const y=Number(r.resultado==='yes');for(const v of VARIANTS){const p=a.forecasts[v].pYes;g.models[v].correct+=Number((p>=.5)===(y===1));g.models[v].brierSum+=(p-y)**2;}}
 return {version:VERSION,active:false,productionValidated:false,pending,groups:[...groups.values()].map(g=>({...g,models:Object.fromEntries(VARIANTS.map(v=>[v,{correct:g.models[v].correct,brier:g.models[v].brierSum/g.cases,accuracy:g.models[v].correct/g.cases}]))})),note:'Mismos contratos futuros, mismas particiones temporales y calibración. Sin rellenar predicciones históricas. Acierto y Brier no son rentabilidad.'};}
module.exports={VERSION,VARIANTS,propose,summarize};
