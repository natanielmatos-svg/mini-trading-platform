const {test}=require('node:test'),assert=require('node:assert/strict');const {createEncoder}=require('../src/learning-state-encoding');
test('encoding preserves all state fields and live mutations, caches immutable closed history',()=>{
 const encode=createEncoder();let reads=0;const past={actual:10,get observations(){reads++;return [{at:1,price:10}];}},live={actual:null,observations:[]};const state={version:1,blocks:[past,live],targets:[],lastRun:0,errors:[]};const first=JSON.parse(encode(state));assert.equal(first.blocks[0].actual,10);assert.equal(reads,1);
 live.observations.push({at:2,price:11});state.lastRun=2;let next=JSON.parse(encode(state));assert.equal(reads,1);assert.equal(next.lastRun,2);assert.equal(next.blocks[1].observations.length,1);
 live.actual=12;live.error=1;next=JSON.parse(encode(state));assert.equal(next.blocks[1].actual,12);assert.equal(next.blocks[1].error,1);
 state.blocks=[live];assert.equal(JSON.parse(encode(state)).blocks.length,1);
});
