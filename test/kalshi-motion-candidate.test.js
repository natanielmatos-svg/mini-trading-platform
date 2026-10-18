'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../src/kalshi-motion-candidate');
function sample(i){const at=1000000+i*900000;return {type:'sample',ticker:'KXBTC15M-'+i,at,closesAt:at+600000,unit:'USD',operator:'>=',rulesHash:'rules',freshBook:true,book:{at,yes:[{precio:.4,cantidad:10}],no:[{precio:.5,cantidad:12}]},marketFeatures:{version:'kalshi-market-features-v1',frozenAt:at,usableReference:true,observedAt:at,referenceAt:at,thresholdDistancePct:i%2?.2:-.2,secondsRemaining:600,movement:{cutoff:at,windows:Object.fromEntries([5,15,60].map(n=>[n,{complete:true,returnPct:i%2?.1:-.1,rangePct:.3}]))}}};}
test('requires genuine complete observations and rejects future or stale inputs',()=>{
 assert.ok(m.features(sample(1)));
 for(const mutate of [s=>s.marketFeatures.movement.windows[5].complete=false,s=>s.marketFeatures.observedAt++,s=>s.book.at++,s=>s.marketFeatures.referenceAt-=16000,s=>s.rulesHash=null]){const s=sample(1);mutate(s);assert.equal(m.features(s),null);}
});
test('fits chronologically with embargo; evaluation only uses frozen future candidate',()=>{
 const history=Array.from({length:81},(_,i)=>sample(i)),settlements=new Map(history.map(s=>[s.ticker,{at:s.closesAt+1000,resultado:Number(s.ticker.split('-')[1])%2?'yes':'no'}]));
 const current=sample(82),p=m.propose(current,history,settlements);
 assert.equal(p.status,'candidate');assert.equal(p.active,false);assert.equal(p.artifact.training.length,61);
 assert.ok(p.artifact.training.every(r=>r.resolvedAt<p.artifact.calibration[0].at));
 assert.equal(m.summarize(history,settlements).groups.length,0);
 delete p.artifact;current.motionProbability=p;settlements.set(current.ticker,{at:current.closesAt+1000,resultado:'no'});
 assert.equal(m.summarize([current],settlements).groups[0].evaluated,1);
 const future=new Map([...settlements].map(([k,r])=>[k,{...r,at:current.at+1}]));assert.equal(m.propose(current,history,future).status,'warming');
});
