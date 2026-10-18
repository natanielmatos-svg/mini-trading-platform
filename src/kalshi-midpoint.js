'use strict';
const hybrid=require('./kalshi-hybrid');
function rulesKey(s){
 const primary=s.rules?.primary,secondary=s.rules?.secondary;
 if(typeof primary!=='string'||typeof secondary!=='string')return s.rulesHash;
 // Normalize only the two dated observation instants, not source, averaging,
 // rounding, comparison, or any other contractual text.
 const instant=/\b(?:1[0-2]|[1-9]):[0-5]\d [AP]M (?:EDT|EST) on (?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) \d{1,2}, \d{4}\b/g;
 const matches=primary.match(instant);
 if(matches?.length!==2)return s.rulesHash;
 return require('node:crypto').createHash('sha256').update(JSON.stringify([primary.replace(instant,'<observation instant>'),secondary])).digest('hex');
}
const CONFIG=Object.freeze({version:'kalshi-midpoint-450s-v2',horizonMs:450000,midpoint:true,predictionField:'midpointProbability',rulesKey});
const POLICY=Object.freeze({version:'midpoint-margin-v1',quantity:1,minimumMarginUSD:.03,operatingReserveUSD:.01,exit:'official-settlement',liveEnabled:false});
function inWindow(s){return s.ticker?.startsWith('KXBTC15M-')&&Number.isFinite(s.requestedAt)&&Number.isFinite(s.at)&&s.at>=s.requestedAt&&s.at-s.requestedAt<=15000&&Math.abs(s.closesAt-s.requestedAt-450000)<=30000&&Math.abs(s.closesAt-s.at-450000)<=30000;}
function features(s){return inWindow(s)&&s.rulesHash?hybrid.features(s,CONFIG):null;}
function propose(s,history,settlements){
 if(!features(s))return {version:CONFIG.version,at:s.at,status:'ineligible',reason:'Faltan datos previos comparables en la mitad del bloque (7:30 ±30s).',active:false};
 return hybrid.propose(s,history.filter(features),settlements,'full',CONFIG);
}
function economy(s,p,fees){
 const base={policy:POLICY,at:s.at,ticker:s.ticker,status:'abstained'};
 if(p.status!=='candidate')return {...base,reason:'Modelo sin predicción válida'};
 const b=s.book;
 if(!s.freshBook||!b||!Number.isFinite(b.at)||b.at>s.at||s.at-b.at>3000)return {...base,reason:'Libro insuficientemente reciente'};
 if(!fees?.verified||!Number.isFinite(fees.upperBound)||fees.upperBound<0||!Number.isFinite(fees.checkedAt)||fees.checkedAt>s.at||s.at-fees.checkedAt>10000)return {...base,reason:'Tarifas no verificadas'};
 if((s.settlementBoundsType??'default')!=='default'||(s.settlementFloorUSD!=null&&Number(s.settlementFloorUSD)!==0))return {...base,reason:'Pago binario no estándar'};
 const levels=side=>(b[side]||[]).filter(l=>Number.isFinite(l.precio)&&l.precio>0&&l.precio<1&&Number.isFinite(l.cantidad)&&l.cantidad>0).sort((a,b)=>b.precio-a.precio);
 const yes=levels('yes'),no=levels('no');if(!yes.length||!no.length||yes[0].precio+no[0].precio>1)return {...base,reason:'Libro cruzado o incompleto'};
 const choices=['yes','no'].flatMap(side=>{let remaining=1,ask=0;for(const l of side==='yes'?no:yes){const q=Math.min(remaining,l.cantidad);ask+=q*(1-l.precio);remaining-=q;if(remaining<1e-9)break;}if(remaining>1e-9)return [];const probability=side==='yes'?p.pYes:1-p.pYes;return [{side,ask,probability,estimatedMarginUSD:probability-ask-fees.upperBound-POLICY.operatingReserveUSD}];}).sort((a,b)=>b.estimatedMarginUSD-a.estimatedMarginUSD);
 const best=choices[0];if(!best||best.estimatedMarginUSD<POLICY.minimumMarginUSD)return {...base,choices,reason:'No supera el margen previo fijado'};
 return {...base,...best,status:'observed',feeBoundUSD:fees.upperBound,marketP:(yes[0].precio+1-no[0].precio)/2,reason:'Un contrato teórico; no es fill ni señal validada'};
}
function summarize(history,settlements){
 const comparable=history.filter(features),base=hybrid.summarize(comparable,settlements,CONFIG),seen=new Set();let abstentions=0,pending=0,evaluated=0,net=0,peak=0,equity=0,maxDrawdown=0;
 for(const s of [...history].sort((a,b)=>a.at-b.at)){const e=s.midpointEconomy;if(!e||seen.has(s.ticker))continue;seen.add(s.ticker);if(e.status!=='observed'){abstentions++;continue;}const r=settlements.get(s.ticker);if(!r||!['settled','finalized'].includes(r.status)||!['yes','no'].includes(r.resultado)||r.at<s.closesAt){pending++;continue;}const n=Number(e.side===r.resultado)-e.ask-e.feeBoundUSD-POLICY.operatingReserveUSD;evaluated++;net+=n;equity+=n;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
 const latest=[...history].reverse().find(s=>s.midpointProbability?.version===CONFIG.version)?.midpointProbability||null;
 return {...base,latest,horizonSeconds:450,toleranceSeconds:30,historicalContracts:new Set(comparable.map(s=>s.ticker)).size,economy:{policy:POLICY,abstentions,pending,evaluated,netBoundUSD:evaluated?net:null,maxDrawdownUSD:evaluated?maxDrawdown:null,executedOrders:0},note:'Predicción congelada a mitad del bloque. Entrenamiento histórico no cuenta como aciertos. Resultado económico teórico a precios observados; no demuestra fills.'};
}
module.exports={CONFIG,POLICY,inWindow,features,propose,economy,summarize,rulesKey};
