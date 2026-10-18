'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {audit}=require('../src/pilot-audit');
const block=()=>({symbol:'BTCUSDT',interval:'15m',group:'source-A',unit:'USD',opensAt:0,closesAt:900000,resolvedAt:900100,actual:100,prediction:{at:1000,raw:105,candidate:102,baseline:99,version:'v1',trainingSamples:30}});
test('MAE uses identical cases; duplicate and late predictions excluded',()=>{
 const b=block(),late={...block(),closesAt:1800000,resolvedAt:1800100,prediction:{...b.prediction,at:1800000}};
 const r=audit({blocks:[b,b,late],cutoff:2000000});
 assert.equal(r.candleComparisons.length,1);assert.equal(r.candleComparisons[0].n,1);
 assert.equal(r.candleComparisons[0].rawMae,5);assert.equal(r.candleComparisons[0].candidateMae,2);assert.equal(r.candleComparisons[0].baselineMae,1);
 assert.equal(r.quality.duplicateBlocks,1);assert.equal(r.quality.invalidPrediction,1);
 assert.equal(r.netProfitUSD,null);assert.equal(r.ready,false);
});
test('hourly contracts do not count as BTC15m evidence',()=>{
 const e={tipo:'observacion',id:'a',ticker:'KXBTCD-A',observadoEn:1,vencimiento:100,p:.7,baseline:.6};
 const r=audit({evidence:[e],cutoff:1000});assert.equal(r.coverage.btc15mObservations,0);assert.equal(r.coverage.series.KXBTCD,1);
});
test('Brier pairs valid probabilities and excludes contradictory or future results',()=>{
 const e={tipo:'observacion',id:'a',ticker:'KXBTC15M-A',observadoEn:1,vencimiento:100,p:.8,baseline:.6};
 const res={tipo:'resultado',ticker:e.ticker,resultado:'yes',t:new Date(200).toISOString()};
 const r=audit({evidence:[e,res],cutoff:1000});assert.ok(Math.abs(r.contractComparisons[0].brierModel-.04)<1e-10);
 assert.equal(audit({evidence:[e,res,{...res,resultado:'no'}],cutoff:1000}).contractComparisons.length,0);
 assert.equal(audit({evidence:[e,{...res,t:new Date(2000).toISOString()}],cutoff:1000}).contractComparisons.length,0);
});
test('separates providers, versions and emission phase; rejects unresolved labels',()=>{
 const a=block(),b={...block(),group:'source-B'},c={...block(),prediction:{...a.prediction,version:'v2'}},d={...block(),closesAt:1800000,opensAt:900000,resolvedAt:1800100,prediction:{...a.prediction,at:1600000}};
 // Same-source same-close versions are duplicates: one block cannot be counted twice.
 const r=audit({blocks:[a,b,c,d,{...block(),group:'future',resolvedAt:3000000}],cutoff:2000000});
 assert.equal(r.candleComparisons.length,3);assert.equal(r.quality.invalidOrOpen,1);
});
