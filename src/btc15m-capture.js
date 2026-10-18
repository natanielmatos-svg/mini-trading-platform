'use strict';
// Observational evidence only. No orders, inferred fills or model promotion.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {officialResult}=require('./kalshi-settlement');
const {select}=require('./kalshi-threshold');
const {fetchJson}=require('./http');
const BASE='https://external-api.kalshi.com/trade-api/v2';
const probability=require('./settlement-probability');
const benchmark=require('./kalshi-model-benchmark');
const hybrid=require('./kalshi-hybrid');
const motion=require('./kalshi-motion-candidate');
const midpoint=require('./kalshi-midpoint');
const calibrationTrial=require('./midpoint-calibration-trial');
const priceTrial=require('./midpoint-price-trial');
const residualTrial=require('./market-residual-trial');
function create({root=path.join(__dirname,'..','datos','piloto-btc15m'),clock=Date.now,
  list=()=>fetchJson(BASE+'/markets?series_ticker=KXBTC15M&status=open&limit=1000',{timeoutMs:6000,retries:0}),
  market=ticker=>fetchJson(BASE+'/markets/'+encodeURIComponent(ticker),{timeoutMs:6000,retries:0}).then(r=>r.market),
  book=ticker=>require('./kalshi-book').obtener(ticker),brti=null,backgroundReplay=false}={}){
 const file=path.join(root,'events.jsonl'),ids=new Set(),pending=new Map(),resolved=new Set();
 const history=[],motionHistory=[],midpointHistory=[],settlements=new Map(),brtiDecisions=new Map();let latestProbability=null,latestFilter=null;
 let busy=false,lastRun=null,errors=[],samples=0,joined=0,eligible=0,motionSamples=0,completeMotionSamples=0,latestMotion=null;
 function remember(e){
  if(ids.has(e.id))return;ids.add(e.id);
  if(e.type==='sample'){samples++;if(e.predictions.length)joined++;if(e.fixedWindowEligible)eligible++;if(!resolved.has(e.ticker)&&!pending.has(e.ticker))pending.set(e.ticker,{closesAt:e.closesAt,next:0});}
  if(e.type==='settlement'){resolved.add(e.ticker);pending.delete(e.ticker);}
  if(e.type==='sample'&&e.fixedWindowEligible){history.push(e);if(e.settlementProbability){latestProbability=e.settlementProbability;latestFilter=e.netFilter;}}
  if(e.type==='settlement')settlements.set(e.ticker,e);
  if(e.type==='sample'&&midpoint.inWindow(e))midpointHistory.push(e);
  if(e.marketFeatures){motionHistory.push(e);motionSamples++;latestMotion=e.marketFeatures;if(e.marketFeatures.movement?.windows?.[60]?.complete)completeMotionSamples++;}
  if(e.brtiProspective&&!brtiDecisions.has(e.ticker))brtiDecisions.set(e.ticker,e.brtiProspective);
 }
 let historyReady=!backgroundReplay,historyError=null;
 async function replay(){
  await new Promise(resolve=>setImmediate(resolve));
  try{let count=0;for(const event of require('./read-jsonl').readJsonl(file)){remember(event);if(++count%64===0)await new Promise(resolve=>setImmediate(resolve));}historyReady=true;}
  catch(e){if(e.code==='ENOENT')historyReady=true;else historyError='Registro del piloto BTC15m inválido; captura detenida';}
 }
 if(backgroundReplay)void replay();
 else try{for(const event of require('./read-jsonl').readJsonl(file))remember(event);}catch(e){if(e.code!=='ENOENT')throw Error('Registro del piloto BTC15m inválido');}
 function append(e){if(ids.has(e.id))return;fs.mkdirSync(root,{recursive:true});fs.appendFileSync(file,JSON.stringify(e)+'\n');remember(e);}
 async function tick(blocks){
  if(busy||!historyReady)return;busy=true;errors=[];
  try{
   // Bounded reconciliation; retry timestamps prevent a stuck contract starving others.
   for(const [ticker,p] of [...pending].filter(([,p])=>p.closesAt<=clock()&&p.next<=clock()).slice(0,4)){
    p.next=clock()+300000;
    try{const m=await market(ticker),result=officialResult(m,ticker);if(result)append({id:'settlement|'+ticker,type:'settlement',ticker,at:clock(),...result,expirationValue:m.expiration_value??null,source:'Kalshi market API'});}catch{errors.push('No se pudo reconciliar '+ticker);}
   }
   try{
    const requestedAt=clock(),response=await list(),receivedAt=clock();
    if(!Array.isArray(response.markets)||response.cursor)throw Error('Listado incompleto');
    const chosen=select(response.markets,{symbol:'BTCUSDT',interval:'15m',now:receivedAt});
    if(chosen.contracts.length!==1){errors.push('No hay un único umbral BTC15m válido para este bloque');return;}
    const c=chosen.contracts[0],m=response.markets.find(m=>m.ticker===c.ticker);
    const observeBRTI=brti&&!brtiDecisions.has(c.ticker)&&Math.abs(c.closesAt-requestedAt-600000)<=30000;
    const observeMidpoint=brti&&Math.abs(c.closesAt-requestedAt-450000)<=30000&&!midpointHistory.some(s=>s.ticker===c.ticker&&s.midpointProbability);
    let reference=null,feeMetadata=null;
    if(observeBRTI||observeMidpoint){try{[reference,feeMetadata]=await Promise.all([brti.reference(),brti.fees(m)]);}catch{reference=null;}}
    let depth=null,depthError=null;
    try{depth=await book(c.ticker,{notBefore:reference?.at??0});}catch{depthError='Libro no disponible';}
    const at=clock();
    if(at>=c.closesAt||at-requestedAt>15000){errors.push('Captura descartada: cerró el bloque o la consulta tardó más de 15 segundos');return;}
    const rows=blocks.filter(b=>b.symbol==='BTCUSDT'&&b.interval==='15m'&&b.closesAt===c.closesAt);
    const predictions=rows.flatMap(b=>{
     const p=b.prediction;
     if(!p||!(p.at>=b.opensAt&&p.at<=requestedAt&&p.at<c.closesAt)||![p.raw,p.candidate,p.baseline].every(x=>Number.isFinite(x)&&x>0))return [];
     const observation=[...b.observations].reverse().find(o=>o.at<=requestedAt);
     return [{group:b.group,unit:b.unit,source:b.source,venues:b.venues,prediction:{...p},observation:observation?{at:observation.at,price:observation.price,reference:observation.reference,snapshotAt:observation.snapshotAt}:null,
      intrablock:hybrid.movement(b.observations,b.opensAt,requestedAt),
      localPredictions:(b.localPredictions||[]).filter(p=>p.at<=requestedAt).map(p=>({...p}))}];
    });
    function price(name){const value=m[name+'_dollars'];if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=1?n:null;}
    const quotes={yesBid:price('yes_bid'),yesAsk:price('yes_ask'),noBid:price('no_bid'),noAsk:price('no_ask')};
    const quoteValid=Object.values(quotes).every(Number.isFinite)&&quotes.yesBid<=quotes.yesAsk&&quotes.noBid<=quotes.noAsk;
    const freshBook=!!depth&&depth.at<=at&&at-depth.at<=10000&&Array.isArray(depth.yes)&&Array.isArray(depth.no)&&depth.yes.length>0&&depth.no.length>0;
    const rules={primary:m.rules_primary||'',secondary:m.rules_secondary||''};
    const sample={id:'capture30|'+c.ticker+'|'+Math.floor(requestedAt/30000),type:'sample',version:'btc15m-capture-v2',ticker:c.ticker,at,requestedAt,receivedAt,
     opensAt:Date.parse(m.open_time),closesAt:c.closesAt,threshold:c.threshold,operator:c.operator,unit:'USD',rules,settlementBoundsType:m.settlement_bounds_type??'default',settlementFloorUSD:m.settlement_floor_dollars??null,
     rulesHash:crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex'),quotes,quoteValid,quoteSourceAt:null,
     book:depth,bookError:depthError,freshBook,predictions,
     fixedWindowEligible:Math.abs(c.closesAt-requestedAt-600000)<=30000&&predictions.length>0&&quoteValid&&freshBook,
     settlementEquivalent:false,feesVerified:false,executionSimulated:false,
     note:'Captura observacional; cotizaciones no son fills. Predicciones de vela, no probabilidad de liquidación. Ventana 10 minutos ±30s sólo clasifica captura.'};
    if(observeBRTI){
     sample.brtiProspective=require('./brti-prospective').freeze({sample,reference,fees:feeMetadata,at});
     const usable=reference?.ok&&reference.index==='BRTI'&&reference.currency==='USD'&&reference.at<=at&&at-reference.at<=15000&&reference.observedAt<=at;
     sample.marketFeatures={version:'kalshi-market-features-v1',frozenAt:at,referenceAt:usable?reference.at:null,observedAt:usable?reference.observedAt:null,
      movement:usable?reference.movement:null,thresholdDistancePct:usable?100*(reference.price/c.threshold-1):null,secondsRemaining:(c.closesAt-at)/1000,
      rulesHash:sample.rulesHash,bookAt:freshBook?depth.at:null,fees:feeMetadata??null,usableReference:!!usable,
      note:'Variables observadas antes del resultado; libro original conservado en la captura. Sin reconstrucción histórica ni órdenes.'};
    }
    if(sample.fixedWindowEligible&&!history.some(s=>s.ticker===sample.ticker&&s.settlementProbability)){
     const forecast=probability.propose(sample,history,settlements);
     if(forecast.artifact){const dir=path.join(root,'models');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,forecast.modelId+'.json'),JSON.stringify(forecast.artifact));delete forecast.artifact;}
     sample.settlementProbability=forecast;sample.netFilter=probability.netFilter(sample,forecast);
    }
    sample.modelBenchmark=benchmark.freeze(sample);
    if(sample.fixedWindowEligible&&!history.some(s=>s.ticker===sample.ticker&&s.hybridProbability?.status==='candidate')){
     const forecast=hybrid.propose(sample,history,settlements);
     if(forecast.artifact){const dir=path.join(root,'models');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,forecast.modelId+'.json'),JSON.stringify(forecast.artifact));delete forecast.artifact;}
     sample.hybridProbability=forecast;
    }
    if(sample.fixedWindowEligible&&!history.some(s=>s.ticker===sample.ticker&&s.ablation?.forecasts?.full?.status==='candidate')){
     const comparison=require('./kalshi-ablation').propose(sample,history,settlements);
     for(const forecast of Object.values(comparison.forecasts))if(forecast.artifact){const dir=path.join(root,'models');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,forecast.modelId+'.json'),JSON.stringify(forecast.artifact));delete forecast.artifact;}
     sample.ablation=comparison;
    }
    if(sample.marketFeatures&&!motionHistory.some(s=>s.ticker===sample.ticker&&s.motionProbability?.status==='candidate')){
     const forecast=motion.propose(sample,motionHistory,settlements);
     if(forecast.artifact){const dir=path.join(root,'models');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,forecast.modelId+'.json'),JSON.stringify(forecast.artifact));delete forecast.artifact;}
     sample.motionProbability=forecast;
    }
    if(observeMidpoint&&midpoint.inWindow(sample)){
     const forecast=midpoint.propose(sample,midpointHistory,settlements);
     sample.midpointCalibrationTrial=calibrationTrial.freeze(sample,forecast,feeMetadata);
     sample.midpointPriceTrial=priceTrial.freeze(sample,forecast,feeMetadata,sample.midpointCalibrationTrial);
     const residual=residualTrial.propose(sample,midpointHistory,settlements,feeMetadata);
     if(residual.artifact){const dir=path.join(root,'models');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,residual.modelId+'.json'),JSON.stringify(residual.artifact));delete residual.artifact;}
     sample.marketResidualTrial=residual;
     if(forecast.artifact){const dir=path.join(root,'models');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,forecast.modelId+'.json'),JSON.stringify(forecast.artifact));delete forecast.artifact;}
     sample.midpointProbability=forecast;sample.midpointEconomy=midpoint.economy(sample,forecast,feeMetadata);
    }
    append(sample);
   }catch{errors.push('No se pudo capturar el mercado BTC15m');}
  }finally{lastRun=clock();busy=false;}
 }
 function snapshot(){
  const availableContracts=new Set(history.filter(s=>probability.features(s)&&settlements.has(s.ticker)).map(s=>s.ticker)).size;
  const scored=history.filter(s=>s.settlementProbability?.status==='candidate'&&settlements.has(s.ticker));
  const mean=fn=>scored.length?scored.reduce((sum,s)=>sum+fn(s),0)/scored.length:null;
  const y=s=>settlements.get(s.ticker).resultado==='yes'?1:0;
  return {probability:{version:probability.VERSION,availableContracts,minimum:probability.MINIMUM,latest:latestProbability,filter:latestFilter,evaluatedContracts:scored.length,brier:mean(s=>(s.settlementProbability.pYes-y(s))**2),marketBrier:mean(s=>(s.settlementProbability.marketP-y(s))**2),validated:false},mode:'observation',series:'KXBTC15M',lastRun,samples,joinedSamples:joined,fixedWindowSamples:eligible,pendingContracts:pending.size,resolvedContracts:resolved.size,errors,netProfitUSD:null,liveEnabled:false,settlementEquivalent:false};}
 const baseSnapshot=()=>({...snapshot(),midpoint:midpoint.summarize(midpointHistory,settlements),midpointCalibrationTrial:calibrationTrial.summarize(midpointHistory,settlements),midpointPriceTrial:priceTrial.summarize(midpointHistory,settlements),marketResidualTrial:residualTrial.summarize(midpointHistory,settlements),motionCandidate:motion.summarize(motionHistory,settlements),featureCollection:{version:'kalshi-market-features-v1',samples:motionSamples,complete60sSamples:completeMotionSamples,latest:latestMotion,modelChanged:false}});
 return {tick,snapshot:()=>!historyReady?{loadingHistory:true,mode:'observation',samples:null,joinedSamples:null,resolvedContracts:null,fixedWindowSamples:null,liveEnabled:false,errors:historyError?[historyError]:[],historyError}:{...baseSnapshot(),loadingHistory:false,brtiProspective:require('./brti-prospective').summarize(brtiDecisions,settlements),modelBenchmark:benchmark.summarize(history,settlements),hybrid:hybrid.summarize(history,settlements),ablation:require('./kalshi-ablation').summarize(history,settlements)}};
}
module.exports={create};
