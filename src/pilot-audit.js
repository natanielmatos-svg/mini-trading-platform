'use strict';
// Read-only diagnostics. Candle errors are never converted to contract profit.
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const validP = x => Number.isFinite(x) && x >= 0 && x <= 1;
function audit({blocks=[], evidence=[], ledger=[], cutoff=Date.now()}) {
  const seen=new Set(), groups=new Map();
  const excluded={duplicateBlocks:0, invalidOrOpen:0, invalidPrediction:0};
  const group=(key,row)=>{if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);};
  for(const b of blocks){
    if(b.symbol!=='BTCUSDT'||b.interval!=='15m')continue;
    if(!(Number.isFinite(b.actual)&&b.actual>0&&Number.isFinite(b.resolvedAt)&&b.resolvedAt>=b.closesAt&&b.resolvedAt<=cutoff)){excluded.invalidOrOpen++;continue;}
    const id=JSON.stringify([b.group,b.unit,b.closesAt]);
    if(seen.has(id)){excluded.duplicateBlocks++;continue;}seen.add(id);
    const p=b.prediction;
    if(!p||!(p.at>=b.opensAt&&p.at<b.closesAt)||![p.raw,p.baseline,p.candidate].every(x=>Number.isFinite(x)&&x>0)){excluded.invalidPrediction++;continue;}
    const phase=Math.min(3,Math.floor(4*(p.at-b.opensAt)/(b.closesAt-b.opensAt)));
    const key=JSON.stringify([b.group,b.unit,p.version,phase,p.trainingSamples>=30?'trained':'warmup']);
    group(key,{at:b.closesAt,raw:Math.abs(p.raw-b.actual),candidate:Math.abs(p.candidate-b.actual),baseline:Math.abs(p.baseline-b.actual)});
  }
  const candleComparisons=[...groups].map(([key,rows])=>({key,n:rows.length,firstClose:Math.min(...rows.map(r=>r.at)),lastClose:Math.max(...rows.map(r=>r.at)),rawMae:mean(rows.map(r=>r.raw)),candidateMae:mean(rows.map(r=>r.candidate)),baselineMae:mean(rows.map(r=>r.baseline))}));
  const results=new Map(), conflicts=new Set(), observations=new Map(), series={};
  let invalidObservations=0,duplicateObservations=0;
  for(const e of evidence){
    if(e.tipo==='resultado'&&['yes','no'].includes(e.resultado)&&Date.parse(e.t)<=cutoff){
      if(results.has(e.ticker)&&results.get(e.ticker)!==e.resultado)conflicts.add(e.ticker);
      results.set(e.ticker,e.resultado);
    }
    if(e.tipo!=='observacion')continue;
    if(!(Number.isFinite(e.observadoEn)&&e.observadoEn<e.vencimiento&&e.observadoEn<=cutoff)||!e.id||!e.ticker){invalidObservations++;continue;}
    if(observations.has(e.id)){duplicateObservations++;continue;}
    observations.set(e.id,e);
    const s=e.ticker.split('-')[0];series[s]=(series[s]||0)+1;
  }
  const target=[...observations.values()].filter(e=>e.ticker.startsWith('KXBTC15M-'));
  const contractGroups=new Map();
  for(const e of target){
    if(conflicts.has(e.ticker)||!results.has(e.ticker)||![e.p,e.baseline].every(validP))continue;
    const key=JSON.stringify([e.version,e.fuente,e.objetivo,e.tramo]);
    if(!contractGroups.has(key))contractGroups.set(key,[]);
    const y=results.get(e.ticker)==='yes'?1:0;
    contractGroups.get(key).push({e,model:(e.p-y)**2,market:(e.baseline-y)**2});
  }
  const contractComparisons=[...contractGroups].map(([key,rs])=>({key,n:rs.length,contracts:new Set(rs.map(r=>r.e.ticker)).size,brierModel:mean(rs.map(r=>r.model)),brierKalshi:mean(rs.map(r=>r.market))}));
  const closed=ledger.filter(e=>['salida','liquidacion'].includes(e.tipo)&&Number.isFinite(e.pnl)&&Date.parse(e.t)<=cutoff);
  const targetClosed=closed.filter(e=>String(e.ticker||'').startsWith('KXBTC15M-'));
  const decisions=ledger.filter(e=>e.tipo==='decision'&&Date.parse(e.t)<=cutoff);
  const recent=decisions.filter(e=>Date.parse(e.t)>cutoff-86400000);
  const agent429=recent.filter(e=>(e.vetos||[]).some(v=>v.fuente==='agente'&&String(v.motivo).includes('429')));
  return {cutoff:new Date(cutoff).toISOString(),scope:{symbol:'BTCUSDT',interval:'15m',series:'KXBTC15M'},ready:false,netProfitUSD:null,
    candleComparisons,contractComparisons,quality:{...excluded,invalidObservations,duplicateObservations,conflictingResults:conflicts.size},
    coverage:{series,btc15mObservations:target.length,btc15mContracts:new Set(target.map(e=>e.ticker)).size,btc15mResolvedContracts:new Set(target.filter(e=>results.has(e.ticker)&&!conflicts.has(e.ticker)).map(e=>e.ticker)).size,neuralKalshiPairedCases:0,allPaperCloses:closed.length,btc15mPaperCloses:targetClosed.length,lastDecision:decisions.at(-1)?.t||null,decisionsWithAgent429Last24h:agent429.length},
    blockers:[
      ...(target.length?[]:['No hay observaciones prospectivas de contratos KXBTC15M; KXBTCD no sustituye esta muestra.']),
      'No hay unión validada de pronóstico neuronal, umbral, reglas, libro y liquidación del mismo contrato e instante.',
      'MAE del cierre consolidado no mide beneficio ni la liquidación oficial de Kalshi. Conversión histórica USD y composición pendientes.',
      'No hay evidencia suficiente de rentabilidad neta con tarifas verificadas, spread, latencia, profundidad y costes operativos.',
      'El ejecutor real, reconciliación y recuperación ante ejecuciones parciales no están implementados y validados.',
      ...(agent429.length?['Se registraron vetos del agente por HTTP 429 en las últimas 24 horas; revisar cuota o límites antes de depender de él.']:[])
    ]};
}
module.exports={audit};
