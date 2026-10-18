'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {changes,snapshot}=require('../public/learning-activity');
const a={key:'BTC|0',counts:[10,8,7],model:'one',at:100};
test('initial load, same data, lower counters and filter switches do not invent activity',()=>{assert.deepEqual(changes(null,a),[]);assert.deepEqual(changes(a,a),[]);assert.deepEqual(changes(a,{...a,key:'ETH|0',counts:[50,50,50]}),[]);assert.deepEqual(changes(a,{...a,counts:[9,7,6]}),[]);});
test('only confirmed count increments and a newer model emit changes',()=>{assert.deepEqual(changes(a,{...a,counts:[12,9,7],at:200,model:'two'}).map(e=>e.stage),[0,1,3]);assert.deepEqual(changes(a,{...a,model:'two',at:90}),[]);});
test('snapshot isolates symbol source venues and phase',()=>{const key=JSON.stringify(['BTC','15m','consolidado',['a']]);const d={groups:[{symbol:'BTC',interval:'15m',source:'consolidado',venues:['a'],closed:10}],localAI:{groups:[{group:key,phase:1,samples:8,latest:{modelId:'m',at:10,trainingSamples:9}}]}};assert.deepEqual(snapshot(d,key,1).counts,[10,8,9]);assert.deepEqual(snapshot(d,key,0).counts,[10,null,null]);});
