'use strict';
const {createHash}=require('node:crypto');
const VERSION='btc15m-logistic-platt-v1';
const MINIMUM=80;
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
function features(sample){
 if(sample.type!=='sample'||!sample.ticker?.startsWith('KXBTC15M-')||!sample.fixedWindowEligible||Math.abs(sample.closesAt-sample.requestedAt-600000)>30000)return null;
 const p=sample.predictions.find(p=>p.source==='consolidado'&&p.unit==='USD'&&JSON.stringify(p.venues)===JSON.stringify(['binance','coinbase','gemini','kraken']));
 const r=p?.observation?.reference;
 if(!r||r.index!=='BRTI'||!Number.isFinite(r.at)||r.at>sample.requestedAt||sample.requestedAt-r.at>90000||!(r.price>0)||!(sample.threshold>0)||!Number.isFinite(p.prediction?.raw)||p.prediction.at>sample.requestedAt)return null;
 const x=[100*(r.price/sample.threshold-1),100*(p.prediction.raw/sample.threshold-1)];
 if(!x.every(Number.isFinite))return null;
 return {x,key:JSON.stringify([VERSION,p.group,p.prediction.version,sample.operator]),referenceAt:r.at};
}
function fit(xs,ys,penalty=.1){
 const n=xs.length,d=xs[0].length,means=Array(d).fill(0),scales=Array(d).fill(1);
 for(let j=0;j<d;j++){means[j]=xs.reduce((s,x)=>s+x[j],0)/n;scales[j]=Math.max(1e-6,Math.sqrt(xs.reduce((s,x)=>s+(x[j]-means[j])**2,0)/n));}
 const z=xs.map(x=>[1,...x.map((v,j)=>(v-means[j])/scales[j])]),weights=Array(d+1).fill(0);
 for(let step=0;step<400;step++){
  const grad=weights.map((w,j)=>j?penalty*w:0);
  for(let i=0;i<n;i++){const e=sigmoid(z[i].reduce((s,x,j)=>s+x*weights[j],0))-ys[i];for(let j=0;j<=d;j++)grad[j]+=e*z[i][j]/n;}
  for(let j=0;j<=d;j++)weights[j]-=.1*grad[j];
 }
 return {means,scales,weights};
}
function logit(model,x){return model.weights[0]+x.reduce((s,v,j)=>s+(v-model.means[j])/model.scales[j]*model.weights[j+1],0);}
function propose(sample,history,settlements){
 const f=features(sample);if(!f)return {version:VERSION,status:'ineligible',reason:'Falta ventana fija, BRTI reciente o predicción comparable anterior.',trainingSamples:0,minimum:MINIMUM};
 const seen=new Set(),rows=[];
 for(const s of [...history].sort((a,b)=>a.requestedAt-b.requestedAt)){
  const h=features(s),r=settlements.get(s.ticker);
  if(!h||h.key!==f.key||seen.has(s.ticker)||s.ticker===sample.ticker||!r||!['yes','no'].includes(r.resultado)||!(r.at<sample.requestedAt&&r.at>=s.closesAt&&s.requestedAt<s.closesAt))continue;
  seen.add(s.ticker);rows.push({ticker:s.ticker,x:h.x,y:r.resultado==='yes'?1:0,resolvedAt:r.at,at:s.requestedAt});
 }
 const selected=rows.slice(-500);
 if(selected.length<MINIMUM)return {version:VERSION,status:'warming',trainingSamples:selected.length,minimum:MINIMUM,reason:'Se requieren 60 contratos para ajustar y 20 posteriores para calibrar; etiquetas oficiales disponibles antes de emitir.'};
 // Embargo: all fit labels must be known BEFORE the calibration period begins.
 const calibration=selected.slice(-20),training=selected.slice(0,-20).filter(r=>r.resolvedAt<calibration[0].at);
 const balanced=rs=>[0,1].every(y=>rs.filter(r=>r.y===y).length>=5);
 if(training.length<60||!balanced(training)||!balanced(calibration))return {version:VERSION,status:'warming',trainingSamples:training.length,calibrationSamples:calibration.length,minimum:MINIMUM,reason:'Separación temporal o diversidad de resultados insuficiente.'};
 const model=fit(training.map(r=>r.x),training.map(r=>r.y));
 const calibrator=fit(calibration.map(r=>[logit(model,r.x)]),calibration.map(r=>r.y),.2);
 // The calibration set is not a performance claim. Only future frozen predictions are scored.
 const pYes=sigmoid(logit(calibrator,[logit(model,f.x)]));
 const artifact={version:VERSION,key:f.key,model,calibrator,training,calibration,features:['BRTI relative to threshold (%)','TimesFM relative to threshold (%)'],label:'official Kalshi YES/NO'};
 const modelId=createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
 return {version:VERSION,status:'candidate',at:sample.at,pYes,marketP:(sample.quotes.yesBid+sample.quotes.yesAsk)/2,modelId,trainingSamples:training.length,calibrationSamples:20,prospectivelyValidated:false,active:false,artifact};
}
function netFilter(sample,forecast){
 const base={status:'blocked',liveEnabled:false,quantity:1,feesVerified:false,operatingCostsVerified:false,minimumMarginUSD:.03,slippageReserveUSD:.01,operatingReserveUSD:.01};
 if(forecast.status!=='candidate')return {...base,reason:forecast.reason};
 const book=sample.book;
 if(!sample.freshBook||!book||sample.at-book.at>10000)return {...base,reason:'Sin profundidad reciente.'};
 const candidates=['yes','no'].flatMap(side=>{
  const levels=side==='yes'?book.no:book.yes;
  const best=levels?.[0];if(!best||best.cantidad<1||!(best.precio>0&&best.precio<1))return [];
  const ask=Number((1-best.precio).toFixed(4)),probability=side==='yes'?forecast.pYes:1-forecast.pYes;
  const fee=Math.ceil((.07*ask*(1-ask)-1e-12)*100)/100;
  const net=probability-ask-fee-base.slippageReserveUSD-base.operatingReserveUSD;
  return [{side,ask,probability,estimatedFeeUSD:fee,estimatedNetUSD:net,passesIllustrativeMargin:net>=base.minimumMarginUSD}];
 });
 return {...base,candidates,reason:'Sólo sensibilidad económica: tarifa y costes no verificados, probabilidad aún sin validar prospectivamente. No constituye señal ejecutable.'};
}
module.exports={VERSION,MINIMUM,features,fit,logit,propose,netFilter};
