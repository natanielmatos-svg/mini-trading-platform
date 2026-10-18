'use strict';
const midpoint=require('./kalshi-midpoint');
const VERSION='midpoint-price-band-v1';
const POLICY=Object.freeze({version:VERSION,minAsk:.25,maxAskExclusive:.5,reviewEntries:100,reviewDays:7,stressPerEntryUSD:.02,orders:false});
function freeze(s,p,fees,comparison){
 const f=midpoint.features(s);if(!f||!comparison||!Number.isFinite(comparison.market)||comparison.market<0||comparison.market>1||comparison.key!==f.key)return null;
 const original=midpoint.economy(s,p,fees),market=midpoint.economy(s,{status:'candidate',pYes:comparison.market},fees);
 const filter=e=>e.status==='observed'&&(e.ask<POLICY.minAsk||e.ask>=POLICY.maxAskExclusive)?{status:'abstained',reason:'Fuera del rango fijado [0,25; 0,50) USD'}:e;
 return {version:VERSION,at:s.at,key:f.key,modelId:p.modelId,policy:POLICY,pYes:p.pYes,marketP:comparison.market,decision:filter(original),marketDecision:filter(market)};
}
function summarize(history,settlements){
 const groups=new Map(),seen=new Set();
 for(const s of [...history].sort((a,b)=>a.at-b.at)){
 const p=s.midpointPriceTrial;if(!p||p.version!==VERSION||seen.has(s.ticker))continue;
 const f=midpoint.features(s);if(!f||f.key!==p.key||p.at!==s.at||![p.pYes,p.marketP].every(n=>Number.isFinite(n)&&n>=0&&n<=1))continue;seen.add(s.ticker);
 let g=groups.get(p.key);if(!g){g={key:p.key,observations:0,abstentions:0,pending:0,entries:0,wins:0,netUSD:0,stressNetUSD:0,maxDrawdownUSD:0,meanPredictedWin:0,meanMarketWin:0,brier:0,marketBrier:0,marketEntries:0,marketNetUSD:0,days:new Set(),peak:0};groups.set(p.key,g);}g.observations++;
 const e=p.decision,r=settlements.get(s.ticker),resolved=r&&['settled','finalized'].includes(r.status)&&['yes','no'].includes(r.resultado)&&r.at>=s.closesAt;
 if(e.status!=='observed'){g.abstentions++;continue;}if(!resolved){g.pending++;continue;}
 const y=Number(e.side===r.resultado),prob=e.probability,market=e.side==='yes'?p.marketP:1-p.marketP,n=y-e.ask-e.feeBoundUSD-midpoint.POLICY.operatingReserveUSD;
 g.entries++;g.wins+=y;g.netUSD+=n;g.stressNetUSD+=n-POLICY.stressPerEntryUSD;g.peak=Math.max(g.peak,g.netUSD);g.maxDrawdownUSD=Math.max(g.maxDrawdownUSD,g.peak-g.netUSD);g.meanPredictedWin+=prob;g.meanMarketWin+=market;g.brier+=(prob-y)**2;g.marketBrier+=(market-y)**2;g.days.add(new Date(s.at).toISOString().slice(0,10));
 const me=p.marketDecision;if(me.status==='observed'){g.marketEntries++;g.marketNetUSD+=Number(me.side===r.resultado)-me.ask-me.feeBoundUSD-midpoint.POLICY.operatingReserveUSD;}
 }
 for(const g of groups.values()){g.observedDays=g.days.size;delete g.days;delete g.peak;for(const k of ['meanPredictedWin','meanMarketWin','brier','marketBrier'])g[k]=g.entries?g[k]/g.entries:null;g.reviewDue=g.entries>=POLICY.reviewEntries&&g.observedDays>=POLICY.reviewDays;}
 return {version:VERSION,policy:POLICY,groups:[...groups.values()],executedOrders:0,note:'Prueba futura separada: precio [0,25; 0,50) USD, calibración vigente, misma selección previa. Revisión a 100 entradas y 7 días UTC con entradas; no activa operaciones. Estrés: 0,02 USD adicionales por entrada. Mercado comparado sobre las entradas seleccionadas.'};
}
module.exports={VERSION,POLICY,freeze,summarize};
