'use strict';
const {createHash}=require('node:crypto');
const {fit,logit}=require('./settlement-probability');
const VERSION='kalshi-hybrid-intrablock-v1',MINIMUM=80;
const NAMES=['BRTI/meta %','TimesFM/meta %','consolidado/meta %','movimiento observado %','rango observado %','consolidado/BRTI %','minutos restantes'];
const positive=x=>Number.isFinite(x)&&x>0;
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
function features(s,config={}){
 if((!config.midpoint&&!s.fixedWindowEligible)||!s.ticker?.startsWith('KXBTC15M-')||s.unit!=='USD'||!positive(s.threshold)||!['>','>='].includes(s.operator)||!Number.isFinite(s.at)||s.at<s.requestedAt||s.at>=s.closesAt||Math.abs(s.closesAt-s.requestedAt-(config.horizonMs??600000))>30000)return null;
 const rows=(s.predictions||[]).filter(p=>p.source==='consolidado'&&p.unit==='USD');if(rows.length!==1)return null;
 const p=rows[0],o=p.observation,r=o?.reference,t=p.intrablock;
 const fresh=at=>Number.isFinite(at)&&at<=s.requestedAt&&s.requestedAt-at<=90000;
 if(!p.prediction?.version||!positive(p.prediction.raw)||!Number.isFinite(p.prediction.at)||p.prediction.at<s.opensAt||p.prediction.at>s.requestedAt||!fresh(o?.at)||!fresh(o?.snapshotAt)||r?.index!=='BRTI'||!fresh(r.at)||!positive(r.price)||!positive(o.price))return null;
 if(!t||t.version!==1||t.count<3||!Number.isFinite(t.firstAt)||t.firstAt<s.opensAt||t.lastAt!==o.at||t.lastAt-t.firstAt<60000||!positive(t.first)||t.last!==o.price||!positive(t.low)||!positive(t.high)||t.low>Math.min(t.first,t.last)||t.high<Math.max(t.first,t.last))return null;
 const x=[100*(r.price/s.threshold-1),100*(p.prediction.raw/s.threshold-1),100*(o.price/s.threshold-1),100*(t.last/t.first-1),100*(t.high/t.low-1),100*(o.price/r.price-1),(s.closesAt-s.requestedAt)/60000];
 if(!x.every(Number.isFinite))return null;
 return {x,key:JSON.stringify([config.version||VERSION,p.group,p.venues,p.prediction.version,s.operator,...(config.midpoint?[config.rulesKey?config.rulesKey(s):s.rulesHash]:[])]),prices:{timesfm:p.prediction.raw,spot:o.price,brti:r.price}};
}
function official(s,r){return r&&['finalized','settled'].includes(r.status)&&['yes','no'].includes(r.resultado)&&Number.isFinite(r.at)&&r.at>=s.closesAt;}
function propose(s,history,settlements,variant='full',config={}){
 const indices=variant==='without-timesfm'?[0,2,3,4,5,6]:variant==='brti-only'?[0,6]:[0,1,2,3,4,5,6];
 if(!['full','without-timesfm','brti-only'].includes(variant))throw Error('Variante desconocida');
 const project=x=>indices.map(i=>x[i]);
 const f=features(s,config),base={version:config.version||VERSION,active:false,prospectivelyValidated:false,minimum:MINIMUM,at:s.at};
 if(!f)return {...base,status:'ineligible',trainingSamples:0,reason:'Faltan observaciones intrabloque previas y recientes, BRTI o TimesFM comparables.'};
 const seen=new Set(),rows=[];
 for(const h of [...history].sort((a,b)=>a.requestedAt-b.requestedAt)){
  const hf=features(h,config),r=settlements.get(h.ticker);
  if(!hf||hf.key!==f.key||h.ticker===s.ticker||seen.has(h.ticker)||!official(h,r)||r.at>=s.requestedAt)continue;
  seen.add(h.ticker);rows.push({ticker:h.ticker,x:hf.x,y:Number(r.resultado==='yes'),at:h.requestedAt,resolvedAt:r.at});
 }
 const selected=rows.slice(-500),calibration=selected.slice(-20),training=selected.slice(0,-20).filter(r=>r.resolvedAt<calibration[0].at);
 const balanced=rs=>[0,1].every(y=>rs.filter(r=>r.y===y).length>=5);
 if(training.length<60||calibration.length<20||!balanced(training)||!balanced(calibration))return {...base,status:'warming',availableContracts:selected.length,trainingSamples:training.length,calibrationSamples:calibration.length,reason:'Acumulando al menos 60 contratos de ajuste y 20 posteriores de calibración, con ambos resultados y separación temporal.'};
 const model=fit(training.map(r=>project(r.x)),training.map(r=>r.y)),calibrator=fit(calibration.map(r=>[logit(model,project(r.x))]),calibration.map(r=>r.y),.2);
 const artifact={version:config.version||VERSION,key:f.key,features:indices.map(i=>NAMES[i]),label:'official Kalshi YES/NO',model,calibrator,training,calibration};
 if(variant!=='full')artifact.variant=variant;
 return {...base,status:'candidate',variant,key:f.key,pYes:sigmoid(logit(calibrator,[logit(model,project(f.x))])),prices:f.prices,modelId:createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),trainingSamples:training.length,calibrationSamples:20,artifact};
}
function summarize(history,settlements,config={}){
 let latest=null,pending=0;const groups=new Map(),seen=new Set();
 for(const s of [...history].sort((a,b)=>a.at-b.at)){
  const p=s[config.predictionField||'hybridProbability'];if(!p||p.version!==(config.version||VERSION))continue;latest=p;
  const f=features(s,config);if(p.status!=='candidate'||!f||p.key!==f.key||p.at!==s.at||!Number.isFinite(p.pYes)||p.pYes<0||p.pYes>1||seen.has(s.ticker))continue;
  seen.add(s.ticker);const r=settlements.get(s.ticker);if(!official(s,r)){pending++;continue;}
  if(!groups.has(p.key))groups.set(p.key,{key:p.key,contracts:0,correct:0,brierSum:0,timesfmCorrect:0,spotCorrect:0,brtiCorrect:0});
  const g=groups.get(p.key),y=r.resultado==='yes',side=v=>s.operator==='>='?v>=s.threshold:v>s.threshold;
  g.contracts++;g.correct+=Number((p.pYes>=.5)===y);g.brierSum+=(p.pYes-Number(y))**2;
  for(const n of ['timesfm','spot','brti'])g[n+'Correct']+=Number(side(f.prices[n])===y);
 }
 return {version:config.version||VERSION,minimum:MINIMUM,latest,pending,liveEnabled:false,promotionAllowed:false,groups:[...groups.values()].map(g=>({...g,wrong:g.contracts-g.correct,accuracy:g.correct/g.contracts,brier:g.brierSum/g.contracts}))};
}
function movement(observations,opensAt,requestedAt){
 const rows=observations.filter(o=>Number.isFinite(o.at)&&o.at>=opensAt&&o.at<=requestedAt&&positive(o.price)&&Number.isFinite(o.snapshotAt)&&o.snapshotAt<=o.at&&o.at-o.snapshotAt<=90000).sort((a,b)=>a.at-b.at);
 if(!rows.length)return null;return {version:1,count:new Set(rows.map(o=>o.at)).size,firstAt:rows[0].at,lastAt:rows.at(-1).at,first:rows[0].price,last:rows.at(-1).price,low:Math.min(...rows.map(o=>o.price)),high:Math.max(...rows.map(o=>o.price))};
}
module.exports={VERSION,MINIMUM,features,propose,summarize,movement};
