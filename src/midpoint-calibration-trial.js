'use strict';
const midpoint=require('./kalshi-midpoint');
const {logit}=require('./settlement-probability');
const VERSION='midpoint-calibration-trial-v1';
function freeze(s,p,fees){
 const f=midpoint.features(s);
 if(!f||p.status!=='candidate'||!p.artifact||p.key!==f.key)return null;
 const raw=1/(1+Math.exp(-Math.max(-30,Math.min(30,logit(p.artifact.model,f.x)))));
 const bids=side=>(s.book?.[side]||[]).filter(l=>l.cantidad>0&&l.precio>0&&l.precio<1).map(l=>l.precio);
 const yes=Math.max(...bids('yes')),no=Math.max(...bids('no'));
 const market=s.freshBook&&Number.isFinite(s.book?.at)&&s.book.at<=s.at&&s.at-s.book.at<=3000&&Number.isFinite(yes)&&Number.isFinite(no)&&yes+no<=1?(yes+(1-no))/2:null;
 return {version:VERSION,at:s.at,key:f.key,modelId:p.modelId,raw,calibrated:p.pYes,market,economies:{raw:midpoint.economy(s,{status:'candidate',pYes:raw},fees),calibrated:midpoint.economy(s,p,fees)}};
}
function summarize(history,settlements){
 const groups=new Map(),seen=new Set();let pending=0,excluded=0;
 for(const s of [...history].sort((a,b)=>a.at-b.at)){
  const p=s.midpointCalibrationTrial;if(!p||p.version!==VERSION||seen.has(s.ticker))continue;
  const f=midpoint.features(s);if(!f||p.key!==f.key||p.at!==s.at||!['raw','calibrated','market'].every(k=>Number.isFinite(p[k])&&p[k]>=0&&p[k]<=1)){excluded++;continue;}
  seen.add(s.ticker);const r=settlements.get(s.ticker);
  if(!r||!['settled','finalized'].includes(r.status)||!['yes','no'].includes(r.resultado)||r.at<s.closesAt){pending++;continue;}
  let g=groups.get(p.key);if(!g){g={key:p.key,contracts:0,models:{}};for(const k of ['raw','calibrated','market'])g.models[k]={brier:0,correct:0,entries:0,abstentions:0,netBoundUSD:0};groups.set(p.key,g);}
  g.contracts++;const y=Number(r.resultado==='yes');
  for(const k of ['raw','calibrated','market']){const m=g.models[k];m.brier+=(p[k]-y)**2;m.correct+=Number((p[k]>=.5)===Boolean(y));if(k==='market')continue;const e=p.economies?.[k];if(e?.status==='observed'){m.entries++;m.netBoundUSD+=Number(e.side===r.resultado)-e.ask-e.feeBoundUSD-midpoint.POLICY.operatingReserveUSD;}else m.abstentions++;}
 }
 for(const g of groups.values())for(const m of Object.values(g.models))m.brier/=g.contracts;
 return {version:VERSION,pending,excluded,groups:[...groups.values()],executedOrders:0,note:'Sólo capturas nuevas congeladas a mitad del bloque. Comparación emparejada; neto teórico, sin ejecuciones ni promoción automática.'};
}
module.exports={VERSION,freeze,summarize};
