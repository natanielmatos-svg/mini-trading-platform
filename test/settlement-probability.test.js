'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {propose,netFilter}=require('../src/settlement-probability');
function sample(i){const open=i*900000,at=open+300000,delta=i%2?1:-1;return {id:'s'+i,type:'sample',ticker:'KXBTC15M-'+i,requestedAt:at,at,opensAt:open,closesAt:open+900000,threshold:100,operator:'>=',fixedWindowEligible:true,quotes:{yesBid:.49,yesAsk:.51},predictions:[{source:'consolidado',unit:'USD',venues:['binance','coinbase','gemini','kraken'],group:'g',prediction:{at:at-100,raw:100+delta,version:'v1'},observation:{reference:{index:'BRTI',at:at-1000,price:100+delta}}}]};}
function fixture(){const history=Array.from({length:80},(_,i)=>sample(i));const results=new Map(history.map((s,i)=>[s.ticker,{at:s.closesAt+1000,resultado:i%2?'yes':'no'}]));return {history,results,current:sample(81)};}
test('uses official prior contracts, separate temporal calibration, reproducible artifact',()=>{
 const {history,results,current}=fixture(),p=propose(current,history,results);
 assert.equal(p.status,'candidate');assert.equal(p.trainingSamples,60);assert.equal(p.calibrationSamples,20);assert.ok(p.pYes>.5&&p.pYes<1);assert.equal(p.active,false);
 assert.equal(propose(current,history,results).modelId,p.modelId);
 assert.ok(p.artifact.training.every(r=>r.resolvedAt<p.artifact.calibration[0].at));
});
test('future labels, duplicate contracts and changed versions cannot inflate sample size',()=>{
 const {history,results,current}=fixture();results.set(history[0].ticker,{at:current.at+1,resultado:'yes'});
 const p=propose(current,[...history,...history],results);assert.equal(p.status,'warming');assert.equal(p.trainingSamples,79);
 current.predictions[0].prediction.version='v2';assert.equal(propose(current,history,results).trainingSamples,0);
});
test('stale or future references and non-window samples abstain',()=>{
 const {history,results,current}=fixture();current.predictions[0].observation.reference.at=current.requestedAt-90001;
 assert.equal(propose(current,history,results).status,'ineligible');current.predictions[0].observation.reference.at=current.at+1;
 assert.equal(propose(current,history,results).status,'ineligible');
});
test('economic filter uses opposite bid depth, costs and never enables execution',()=>{
 const s=sample(81);s.freshBook=true;s.book={at:s.at,yes:[{precio:.48,cantidad:10}],no:[{precio:.5,cantidad:10}]};
 const r=netFilter(s,{status:'candidate',pYes:.8});const yes=r.candidates.find(x=>x.side==='yes');
 assert.equal(yes.ask,.5);assert.equal(yes.estimatedFeeUSD,.02);assert.ok(Math.abs(yes.estimatedNetUSD-.26)<1e-10);assert.equal(r.status,'blocked');assert.equal(r.liveEnabled,false);
 s.book.no[0].cantidad=.5;assert.equal(netFilter(s,{status:'candidate',pYes:.8}).candidates.length,1);
});
