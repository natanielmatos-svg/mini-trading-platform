'use strict';
const mid=require('./kalshi-midpoint'),{createHash}=require('node:crypto');
const VERSION='market-residual-midpoint-v1';
// Frozen exploratory rule: five market-probability bins, shrink toward market.
const POLICY=Object.freeze({minimumTotal:100,minimumBin:30,shrinkage:50,bins:5,window:500,orders:false});
function input(s){const f=mid.features(s),p=s.midpointCalibrationTrial;if(!f||!p||p.at!==s.at||p.key!==f.key||!Number.isFinite(p.market)||p.market<0||p.market>1)return null;return {key:f.key,market:p.market,bin:Math.min(4,Math.floor(p.market*5))};}
function official(s,r){return r&&['settled','finalized'].includes(r.status)&&['yes','no'].includes(r.resultado)&&Number.isFinite(r.at)&&r.at>=s.closesAt;}
function propose(s,history,settlements,fees){
 const f=input(s),base={version:VERSION,at:s.at,status:'warming',policy:POLICY,liveEnabled:false};if(!f)return {...base,reason:'Referencia de mercado comparable no disponible'};
 const rows=[],seen=new Set();for(const h of [...history].sort((a,b)=>a.at-b.at)){const x=input(h),r=settlements.get(h.ticker);if(!x||x.key!==f.key||seen.has(h.ticker)||h.ticker===s.ticker||h.at>=s.requestedAt||!official(h,r)||r.at>=s.requestedAt)continue;seen.add(h.ticker);rows.push({ticker:h.ticker,at:h.at,resolvedAt:r.at,market:x.market,bin:x.bin,y:Number(r.resultado==='yes')});}
 const training=rows.slice(-POLICY.window),bin=training.filter(r=>r.bin===f.bin),info={...base,key:f.key,marketP:f.market,trainingSamples:training.length,binSamples:bin.length};
 if(training.length<POLICY.minimumTotal||bin.length<POLICY.minimumBin)return {...info,reason:'Esperando 100 contratos previos y 30 en el tramo de probabilidad'};
 const correction=bin.reduce((n,r)=>n+r.y-r.market,0)/(bin.length+POLICY.shrinkage),pYes=Math.max(.001,Math.min(.999,f.market+correction));
 const artifact={version:VERSION,policy:POLICY,key:f.key,training,bin:f.bin,correction};
 return {...info,status:'candidate',pYes,correction,modelId:createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),artifact,economy:mid.economy(s,{status:'candidate',pYes},fees)};
}
function summarize(history,settlements){const groups=new Map(),seen=new Set();let latest=null;for(const s of [...history].sort((a,b)=>a.at-b.at)){const p=s.marketResidualTrial;if(!p||p.version!==VERSION)continue;latest=p;if(p.status!=='candidate'||seen.has(s.ticker))continue;const f=input(s);if(!f||f.key!==p.key||p.at!==s.at||!Number.isFinite(p.pYes))continue;seen.add(s.ticker);let g=groups.get(p.key);if(!g){g={key:p.key,contracts:0,pending:0,brier:0,marketBrier:0,entries:0,wins:0,abstentions:0,netUSD:0,stressNetUSD:0};groups.set(p.key,g);}const r=settlements.get(s.ticker);if(!official(s,r)){g.pending++;continue;}const y=Number(r.resultado==='yes');g.contracts++;g.brier+=(p.pYes-y)**2;g.marketBrier+=(p.marketP-y)**2;const e=p.economy;if(e?.status==='observed'){const n=Number(e.side===r.resultado)-e.ask-e.feeBoundUSD-mid.POLICY.operatingReserveUSD;g.entries++;g.wins+=Number(e.side===r.resultado);g.netUSD+=n;g.stressNetUSD+=n-.02;}else g.abstentions++;}for(const g of groups.values()){g.brier=g.contracts?g.brier/g.contracts:null;g.marketBrier=g.contracts?g.marketBrier/g.contracts:null;}return {version:VERSION,latest,groups:[...groups.values()],executedOrders:0};}
module.exports={VERSION,POLICY,input,propose,summarize};
