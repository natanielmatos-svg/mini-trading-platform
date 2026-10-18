'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {select}=require('../src/kalshi-demo-model-selector');
const {VERSION}=require('../src/kalshi-model-benchmark');
function pair(i,{prices={timesfm:90,localAI:105,spot:99},actual=110,key='same'}={}){
 const close=1000000+i*900000,at=close-600000,ticker='KXBTC15M-'+i;
 return [{type:'sample',ticker,at,requestedAt:at-10,closesAt:close,fixedWindowEligible:true,threshold:100,operator:'>=',unit:'USD',modelBenchmark:{version:VERSION,at,key,prices,emittedAt:{timesfm:at-100,localAI:at-100,spot:at-100},localModelId:'local-'+i}}, {type:'settlement',ticker,at:close+100,status:'finalized',resultado:actual>=100?'yes':'no',expirationValue:String(actual)}];
}
test('same settled contracts rank by correct side, not small numeric error',()=>{const events=Array.from({length:15},(_,i)=>pair(i)).flat();const r=select(events,{now:20000000});assert.equal(r.selection.winner,'localAI');assert.equal(r.selection.ranking[0].correct,15);assert.equal(r.forecast,null);assert.equal(r.selection.provisional,true);});
test('MAE breaks equal accuracy without claiming stable superiority',()=>{const r=select(pair(0,{prices:{timesfm:105,localAI:106,spot:109}}),{now:2000000});assert.equal(r.selection.winner,'spot');assert.equal(r.selection.totalCases,1);});
test('future settlements, duplicated contracts, wrong group and future prediction excluded',()=>{const a=pair(0),b=pair(1),c=pair(2);b[1].at=99999999;c[0].modelBenchmark.emittedAt.localAI=99999999;const r=select([...pair(-1,{key:'other'}),...a,...a,...b,...c],{now:4000000});assert.equal(r.selection.totalCases,1);});
test('50 resolved contracts split selection from 20 calibration cases with current matching',()=>{
 const events=Array.from({length:50},(_,i)=>pair(i)).flat();const current=pair(51)[0],market={ticker:current.ticker,close_time:new Date(current.closesAt).toISOString(),floor_strike:100};
 const r=select([...events,current],{now:current.at+500,market});assert.equal(r.selection.selectionCases,30);assert.equal(r.selection.calibrationCases,20);assert.equal(r.forecast.selectedEngine,'localAI');assert.equal(r.forecast.predictionInterval.lower,110);assert.equal(r.forecast.quantiles,undefined);
 market.floor_strike=101;assert.equal(select([...events,current],{now:current.at+500,market}).forecast,null);
 assert.equal(select([...events,current],{now:current.at+90001,market:{...market,floor_strike:100}}).forecast,null);
});
test('calibration outcomes cannot pick winner',()=>{const events=Array.from({length:50},(_,i)=>pair(i,{actual:i<30?110:90})).flat(),current=pair(51)[0];const r=select([...events,current],{now:current.at+500,market:{ticker:current.ticker,close_time:new Date(current.closesAt).toISOString(),floor_strike:100}});assert.equal(r.selection.winner,'localAI');});
