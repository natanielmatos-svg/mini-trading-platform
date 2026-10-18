'use strict';
// Prospective transfer test: candle forecasts scored against official settlement.
// Never turns a point estimate into a calibrated probability or an order.
const VERSION='kalshi-point-transfer-v1';
const names=['timesfm','localAI','spot','brti'];
const positive=x=>Number.isFinite(x)&&x>0;
function freeze(s){
 if(!s.fixedWindowEligible||!s.ticker?.startsWith('KXBTC15M-')||s.unit!=='USD'||!positive(s.threshold)||!['>=','>'].includes(s.operator)||Math.abs(s.closesAt-s.requestedAt-600000)>30000||s.at>=s.closesAt)return null;
 const rows=(s.predictions||[]).filter(p=>p.source==='consolidado'&&p.unit==='USD');
 if(rows.length!==1)return null;
 const p=rows[0],o=p.observation,r=o?.reference;
 const fresh=t=>Number.isFinite(t)&&t<=s.requestedAt&&s.requestedAt-t<=90000;
 const local=(p.localPredictions||[]).filter(x=>x.closesAt===s.closesAt&&fresh(x.at)&&positive(x.price)&&x.version&&x.modelId).sort((a,b)=>b.at-a.at)[0];
 if(!local||!fresh(o?.at)||!fresh(o?.snapshotAt)||!fresh(r?.at)||r.index!=='BRTI'||!positive(r.price)||!positive(o.price)||!positive(p.prediction?.raw)||!p.prediction.version||p.prediction.at<s.opensAt||p.prediction.at>s.requestedAt)return null;
 return {version:VERSION,at:s.at,target:'official Kalshi expiration_value and YES/NO',transferTest:true,settlementTrained:false,
  key:JSON.stringify([VERSION,p.group,p.prediction.version,local.version,local.phase,s.operator]),
  rulesHash:s.rulesHash,prices:{timesfm:p.prediction.raw,localAI:local.price,spot:o.price,brti:r.price},
  emittedAt:{timesfm:p.prediction.at,localAI:local.at,spot:o.snapshotAt,brti:r.at},localModelId:local.modelId,active:false};
}
function summarize(history,settlements){
 const groups=new Map(),seen=new Set();let pending=0,invalid=0;
 for(const s of [...history].sort((a,b)=>a.at-b.at)){
  const b=s.modelBenchmark;if(!b||b.version!==VERSION)continue;
  const id=s.ticker+'|'+b.key;if(seen.has(id))continue;seen.add(id);
  if(b.at!==s.at||s.at>=s.closesAt||names.some(n=>!positive(b.prices?.[n]))){invalid++;continue;}
  const r=settlements.get(s.ticker);if(!r){pending++;continue;}
  if(!['finalized','settled'].includes(r.status)||!['yes','no'].includes(r.resultado)||r.at<s.closesAt){invalid++;continue;}
  if(!groups.has(b.key))groups.set(b.key,{key:b.key,contracts:0,numericContracts:0,models:Object.fromEntries(names.map(n=>[n,{correct:0,absoluteError:0}]))});
  const g=groups.get(b.key);g.contracts++;
  const raw=r.expirationValue,actual=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+(\.\d+)?$/.test(raw.trim())?Number(raw):null;
  // Only score a numeric label if it agrees with the final binary result.
  const side=v=>s.operator==='>='?v>=s.threshold:v>s.threshold;
  const numeric=positive(actual)&&side(actual)===(r.resultado==='yes');if(numeric)g.numericContracts++;
  for(const n of names){g.models[n].correct+=Number(side(b.prices[n])===(r.resultado==='yes'));if(numeric)g.models[n].absoluteError+=Math.abs(b.prices[n]-actual);}
 }
 return {version:VERSION,mode:'shadow',liveEnabled:false,promotionAllowed:false,pending,invalid,groups:[...groups.values()].map(g=>({...g,models:Object.fromEntries(names.map(n=>[n,{accuracy:g.models[n].correct/g.contracts,maeUSD:g.numericContracts?g.models[n].absoluteError/g.numericContracts:null}]))})),note:'Ventana: 10 min ±30 s antes del cierre. Mismos contratos por grupo. Pronósticos de vela evaluados contra liquidación: prueba de transferencia, no modelos entrenados para ese promedio. Acierto de lado no es probabilidad calibrada ni beneficio.'};
}
module.exports={VERSION,freeze,summarize};
