'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../src/kalshi-order-transport');
test('supervisor cannot submit, cancel or transfer even if writes requested',async()=>{
 let calls=0;const t=create({role:'supervisor',allowWrites:true,fetchImpl:async()=>{calls++;throw Error('network forbidden');}});
 await assert.rejects(t.submit({}),/desactivado/);await assert.rejects(t.cancel('x','y'),/desactivado/);await assert.rejects(t.fundDemoShard({destination:2,amountUSD:1}),/desactivado/);assert.equal(calls,0);
});
test('observer is default and cannot submit with allowWrites alone',async()=>{await assert.rejects(create({allowWrites:true}).submit({}),/desactivado/);});
