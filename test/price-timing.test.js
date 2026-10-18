'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createSampler}=require('../src/price-timing');
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'price-timing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('parallel capture, single flight and origin timestamp preserved',async t=>{
 const dir=directory(t);let release,reads=0,refs=0;
 const blocked=new Promise(r=>release=r);
 const sampler=createSampler({dir,prices:async()=>{reads++;await blocked;return [{id:'coinbase',price:100,quote:'USD',at:Date.now()}];},reference:async()=>{refs++;return {ok:true,price:101,at:123,index:'BRTI'};}});
 const a=sampler.capture(),b=sampler.capture();assert.equal(reads,1);assert.equal(refs,1);release();await Promise.all([a,b]);
 const lines=fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8').trim().split('\n');assert.equal(lines.length,1);
 const row=JSON.parse(lines[0]);assert.equal(row.index.value.at,123);assert.equal(row.spot.value.price,100);assert.ok(row.spot.receivedAt>=row.spot.sentAt);assert.equal(sampler.status().count,1);
});
test('source failure is recorded without exception contents or invented prices',async t=>{
 const sampler=createSampler({dir:directory(t),prices:async()=>{throw Error('secret');},reference:async()=>({ok:false})});
 const row=await sampler.capture();assert.equal(row.spot.value,undefined);assert.equal(row.spot.error,'Fuente no disponible');assert.ok(!JSON.stringify(row).includes('secret'));
});
test('bounded disk usage stops collection',async t=>{
 const dir=directory(t);const sampler=createSampler({dir,maxBytes:1,prices:async()=>[],reference:async()=>({ok:false})});await sampler.capture();assert.equal(sampler.status().running,false);assert.match(sampler.status().error,/almacenamiento/);assert.equal(fs.readdirSync(dir).length,0);
});
