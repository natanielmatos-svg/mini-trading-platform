const fs=require('node:fs'),s=fs.readFileSync('test/kalshi-midpoint.test.js','utf8');const fixture=s.slice(s.indexOf('function sample('),s.indexOf("test('midpoint uses"));fs.writeFileSync('test/midpoint-calibration-trial.test.js',`const test=require('node:test'),assert=require('node:assert/strict'),m=require('../src/kalshi-midpoint'),trial=require('../src/midpoint-calibration-trial');\n`+fixture+`
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
`);
