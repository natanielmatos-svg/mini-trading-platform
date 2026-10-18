'use strict';
const crypto=require('node:crypto');
const VERSION='local-ridge-v1';
const FEATURES=['remaining','returnPct','rangePct','momentumPct','basisPct','basisMissing'];
function features(block,o){
  if(!(o.price>0)||!(o.open>0)||!Number.isFinite(o.high)||!Number.isFinite(o.low)||o.at<block.opensAt||o.at>=block.closesAt)return null;
  const previous=block.observations.filter(p=>p.at<o.at).at(-1);
  const remaining=(block.closesAt-o.at)/(block.closesAt-block.opensAt);
  const x=[remaining,100*(o.price/o.open-1),100*(o.high-o.low)/o.price,previous?.price>0?100*(o.price/previous.price-1):0,Number.isFinite(o.basisPct)?o.basisPct:0,Number.isFinite(o.basisPct)?0:1];
  return x.every(Number.isFinite)?x:null;
}
function phase(block,o){return Math.min(3,Math.floor(4*(o.at-block.opensAt)/(block.closesAt-block.opensAt)));}
function solve(a,b){
  const n=b.length,m=a.map((r,i)=>[...r,b[i]]);
  for(let k=0;k<n;k++){let pivot=k;for(let i=k+1;i<n;i++)if(Math.abs(m[i][k])>Math.abs(m[pivot][k]))pivot=i;
    [m[k],m[pivot]]=[m[pivot],m[k]];if(Math.abs(m[k][k])<1e-12)return null;
    const d=m[k][k];for(let j=k;j<=n;j++)m[k][j]/=d;
    for(let i=0;i<n;i++)if(i!==k){const f=m[i][k];for(let j=k;j<=n;j++)m[i][j]-=f*m[k][j];}
  }return m.map(r=>r[n]);
}
function propose(block,observation,blocks){
  const x=features(block,observation);if(!x)return null;const bucket=phase(block,observation);
  const rows=[];
  for(const b of blocks){
    if(b.group!==block.group||!(b.actual>0)||!(b.resolvedAt<observation.at)||b.closesAt>=observation.at)continue;
    const o=b.observations.find(o=>phase(b,o)===bucket&&features(b,o));if(!o)continue;
    rows.push({x:features(b,o),y:100*(b.actual/o.price-1),closesAt:b.closesAt,resolvedAt:b.resolvedAt});
  }
  rows.sort((a,b)=>a.closesAt-b.closesAt);const training=rows.slice(-500);if(training.length<30)return null;
  const n=training.length,means=x.map((_,j)=>training.reduce((s,r)=>s+r.x[j],0)/n);
  const scales=x.map((_,j)=>Math.sqrt(training.reduce((s,r)=>s+(r.x[j]-means[j])**2,0)/n)||1);
  const design=r=>[1,...r.map((v,j)=>(v-means[j])/scales[j])];
  const dim=x.length+1,a=Array.from({length:dim},()=>Array(dim).fill(0)),b=Array(dim).fill(0);
  for(const r of training){const z=design(r.x);for(let i=0;i<dim;i++){b[i]+=z[i]*r.y;for(let j=0;j<dim;j++)a[i][j]+=z[i]*z[j];}}
  for(let i=1;i<dim;i++)a[i][i]+=10; // Regularización fija: no se elige usando resultados futuros.
  a[0][0]+=1e-8;const weights=solve(a,b);if(!weights)return null;
  const pct=design(x).reduce((s,v,j)=>s+v*weights[j],0);
  if(!Number.isFinite(pct))return null;
  const bounded=Math.max(-2,Math.min(2,pct));
  const model={version:VERSION,features:FEATURES,means,scales,weights,phase:bucket,trainingSamples:n,trainedThrough:training.at(-1).closesAt,trainingDigest:crypto.createHash('sha256').update(JSON.stringify(training)).digest('hex')};
  const modelId=crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0,20);
  return {version:VERSION,modelId,model,at:observation.at,closesAt:block.closesAt,phase:bucket,price:observation.price*(1+bounded/100),baseline:observation.price,rawNeural:block.prediction?.at<=observation.at?block.prediction.raw:null,predictedReturnPct:bounded,clipped:bounded!==pct,trainingSamples:n,active:false,features:x};
}
module.exports={VERSION,FEATURES,features,phase,propose};
