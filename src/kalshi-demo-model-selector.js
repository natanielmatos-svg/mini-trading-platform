'use strict';
const {VERSION}=require('./kalshi-model-benchmark');
const MODELS=['timesfm','localAI','spot'];
const LABELS={timesfm:'TimesFM',localAI:'IA local',spot:'Mantener consolidado'};
// Select on resolved official contracts, all three frozen before the same close.
// Reserve the last 20 contracts for error calibration, separate from selection.
function select(events,{now=Date.now(),market=null}={}){
 const valid=e=>e.type==='sample'&&e.modelBenchmark?.version===VERSION&&e.modelBenchmark.at===e.at&&e.fixedWindowEligible&&e.unit==='USD'&&['>','>='].includes(e.operator)&&e.ticker?.startsWith('KXBTC15M-')&&Number.isFinite(e.threshold)&&e.threshold>0&&e.at<e.closesAt&&e.at<=now&&Math.abs(e.closesAt-e.requestedAt-600000)<=30000&&MODELS.every(n=>Number.isFinite(e.modelBenchmark.prices[n])&&e.modelBenchmark.prices[n]>0&&Number.isFinite(e.modelBenchmark.emittedAt[n])&&e.modelBenchmark.emittedAt[n]<=e.requestedAt);
 const samples=events.filter(valid).sort((a,b)=>a.at-b.at);
 const current=market?samples.filter(s=>s.ticker===market.ticker&&s.closesAt===Date.parse(market.close_time)&&s.threshold===market.floor_strike&&s.operator==='>='&&now-s.at<=90000).at(-1):null;
 const key=current?.modelBenchmark.key||samples.at(-1)?.modelBenchmark.key;
 const cutoff=current?.requestedAt??now;
 const settlements=new Map();for(const e of events)if(e.type==='settlement'&&e.at<cutoff&&['finalized','settled'].includes(e.status)&&['yes','no'].includes(e.resultado)&&!settlements.has(e.ticker))settlements.set(e.ticker,e);
 const seen=new Set(),rows=[];
 for(const s of samples){if(s.modelBenchmark.key!==key||s.ticker===current?.ticker||seen.has(s.ticker))continue;const r=settlements.get(s.ticker);if(!r||r.at<s.closesAt)continue;
  const actual=Number(r.expirationValue);if(!Number.isFinite(actual)||actual<=0||((s.operator==='>='?actual>=s.threshold:actual>s.threshold)!==(r.resultado==='yes')))continue;
  seen.add(s.ticker);rows.push({ticker:s.ticker,prices:s.modelBenchmark.prices,threshold:s.threshold,operator:s.operator,actual,yes:r.resultado==='yes',at:s.at});
 }
 const ready=rows.length>=50,training=ready?rows.slice(0,-20):rows;
 const ranking=MODELS.map(model=>{let correct=0,absolute=0;for(const r of training){correct+=Number((r.operator==='>='?r.prices[model]>=r.threshold:r.prices[model]>r.threshold)===r.yes);absolute+=Math.abs(r.prices[model]-r.actual);}return {model,label:LABELS[model],cases:training.length,correct,accuracy:training.length?correct/training.length:null,maeUSD:training.length?absolute/training.length:null};}).sort((a,b)=>b.correct-a.correct||(a.maeUSD??Infinity)-(b.maeUSD??Infinity)||a.model.localeCompare(b.model));
 const winner=training.length?ranking[0].model:null;
 const selection={economicEligible:false,usage:'Comparación predictiva; no autorización de entrada',criterion:'official Kalshi YES/NO accuracy; MAE tie-break',models:MODELS,key:key??null,winner,label:LABELS[winner]??null,ranking,totalCases:rows.length,selectionCases:training.length,calibrationCases:ready?20:0,minimumCases:50,provisional:!ready,productionValidated:false,currentMatched:!!current};
 if(!ready||!current){return {selection,forecast:null,reason:!ready?'Muestra insuficiente para separar selección y calibración (mínimo 50 contratos)':'Sin predicción congelada reciente del contrato y meta exactos'};}
 const errors=rows.slice(-20).map(r=>r.actual-r.prices[winner]).sort((a,b)=>a-b);
 const value=current.modelBenchmark.prices[winner],low=value+errors[Math.floor(.1*(errors.length-1))],high=value+errors[Math.ceil(.9*(errors.length-1))];
 return {selection,reason:null,forecast:{ok:true,demo:false,modelId:winner==='localAI'?current.modelBenchmark.localModelId:winner,selectedEngine:winner,estimatedClose:value,symbol:'BTCUSDT',interval:'15m',source:'consolidado',referenceUnit:'USD',generatedAt:current.at,issuedAt:current.modelBenchmark.emittedAt[winner],closesAt:current.closesAt,target:{kind:'candle-close',closesAt:current.closesAt,settlementEquivalent:false},predictionInterval:{lower:low,upper:high,nominalCoverage:.8,calibrationCases:20,target:'official Kalshi expiration_value',validated:false},selection}};
}
module.exports={select,MODELS};
