'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarize}=require('../src/brti-movement');
test('uses dated observations, ignores future values and deduplicates',()=>{
 const rows=Array.from({length:61},(_,i)=>({at:100000-i*1000,price:200-i}));
 const s=summarize([...rows,rows[0],{at:101000,price:900}],100000);
 assert.equal(s.windows[60].samples,61);assert.equal(s.windows[60].complete,true);
 assert.equal(s.windows[5].returnPct,100*(200/195-1));assert.equal(s.settlementAverage,false);
});
test('missing and conflicting origin observations cannot invent dense motion',()=>{
 const s=summarize([{at:100000,price:200},{at:95000,price:195}],100000);
 assert.equal(s.windows[5].returnPct,null);
 const c=summarize([{at:100000,price:200},{at:100000,price:201},{at:99000,price:199}],100000);
 assert.equal(c.conflictingTimestamps,1);assert.equal(c.windows[5].complete,false);
});
