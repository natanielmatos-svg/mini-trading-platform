'use strict';
// Export only: no installs, training, model promotion or network calls.
const fs=require('node:fs'),path=require('node:path');
function dataset(state){
 const rows=[];
 for(const p of state.predictions||[]){
  if(!Number.isFinite(p.actual)||!Array.isArray(p.values)||p.values.length<256||!Number.isFinite(p.at)||p.at>=p.closesAt)continue;
  const future=(state.series[p.symbol]||[]).filter(c=>c.openTime>=p.inputEndAt&&c.closeTime<p.closesAt).sort((a,b)=>a.openTime-b.openTime);
  if(future.length!==p.horizon||future.some((c,i)=>c.openTime!==p.inputEndAt+i*60000||!Number.isFinite(c.close)||c.close<=0))continue;
  rows.push({symbol:p.symbol,at:p.at,closesAt:p.closesAt,inputEndAt:p.inputEndAt,context:p.values.slice(-256),future_values:future.map(c=>c.close),inputHash:p.inputHash});
 }
 rows.sort((a,b)=>a.at-b.at);const closes=[...new Set(rows.map(r=>r.closesAt))].sort((a,b)=>a-b),cutoff=closes[Math.floor(closes.length*.8)];
 const train=rows.filter(r=>r.closesAt<cutoff),validation=rows.filter(r=>r.inputEndAt>=cutoff);
 return {train,validation,manifest:{status:closes.length>=100&&train.length>=60&&validation.length>=20?'ready-for-offline-experiment':'insufficient-data',cutoff:cutoff??null,independentCloseTimes:closes.length,trainingRows:train.length,validationRows:validation.length,context:256,maxHorizon:15,normalization:'raw USD; model internal normalization',promotionAllowed:false,note:'Separate time blocks with embargo; overlapping forecasts within a block are not independent examples. No training or promotion performed.'}};
}
if(require.main===module){const root=path.join(__dirname,'..','datos','timesfm-minute'),file=path.join(root,'state.json');const result=dataset(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}),out=path.join(root,'lora-export');fs.mkdirSync(out,{recursive:true});for(const split of ['train','validation'])fs.writeFileSync(path.join(out,split+'.jsonl'),result[split].map(r=>JSON.stringify(r)).join('\n')+(result[split].length?'\n':''));fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(result.manifest,null,2));console.log(JSON.stringify(result.manifest));}
module.exports={dataset};
