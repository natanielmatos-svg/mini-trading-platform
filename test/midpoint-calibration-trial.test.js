const test=require('node:test'),assert=require('node:assert/strict'),m=require('../src/kalshi-midpoint'),trial=require('../src/midpoint-calibration-trial');
function sample(i){const opensAt=i*900000,at=opensAt+450000,d=i%2?1:-1;return {ticker:'KXBTC15M-'+i,rulesHash:'rules',unit:'USD',threshold:100,operator:'>=',opensAt,closesAt:opensAt+900000,at,requestedAt:at,fixedWindowEligible:false,freshBook:true,book:{at,yes:[{precio:.4,cantidad:1}],no:[{precio:.5,cantidad:1}]},predictions:[{source:'consolidado',unit:'USD',group:'g',venues:['a'],prediction:{at:opensAt,raw:100+d,version:'v1'},observation:{at:at-1000,snapshotAt:at-1000,price:100+d,reference:{at:at-1000,index:'BRTI',price:100+d}},intrablock:{version:1,count:3,firstAt:opensAt+1000,lastAt:at-1000,first:100,last:100+d,low:99,high:101}}]};}

test('freezes raw and calibrated forecasts; scores only new paired official cases',()=>{
 const history=Array.from({length:80},(_,i)=>sample(i)),results=new Map(history.map((s,i)=>[s.ticker,{status:'finalized',at:s.closesAt+1,resultado:i%2?'yes':'no'}]));
 const s=sample(81),p=m.propose(s,history,results),fees={verified:true,upperBound:.03,checkedAt:s.at};
 assert.equal(trial.summarize(history,results).groups.length,0);
 s.midpointCalibrationTrial=trial.freeze(s,p,fees);assert.ok(s.midpointCalibrationTrial.raw>0);assert.equal(s.midpointCalibrationTrial.market,.45);assert.equal(trial.summarize([s],results).pending,1);
 results.set(s.ticker,{status:'finalized',at:s.closesAt+1,resultado:'yes'});
 const g=trial.summarize([s,s],results).groups[0];assert.equal(g.contracts,1);assert.ok(Math.abs(g.models.market.brier-.3025)<1e-10);
 s.midpointCalibrationTrial.market=null;assert.equal(trial.summarize([s],results).excluded,1);
 assert.equal(trial.freeze(s,{status:'warming'},fees),null);
});
