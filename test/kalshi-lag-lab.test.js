'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,quote}=require('../src/kalshi-lag-lab');
function row(at,price=100,bid=.4,no=.5){return {completedAt:at,index:{receivedAt:at,value:{ok:true,index:'BRTI',currency:'USD',price,at}},market:{receivedAt:at,value:{ticker:'KXBTC15M-test',closesAt:at+600000,book:{at,yes:[{precio:bid,cantidad:1}],no:[{precio:no,cantidad:1}]},fees:{verified:true,checkedAt:at,upperBound:.03},sellFees:{verified:true,checkedAt:at,upperBound:.03}}}};}
test('frozen signal waits for delayed entry and later exit, includes spread and fees',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lag-')),lab=create({dir,now:()=>100000});
 lab.observe(row(100000));lab.observe(row(110000,100.03));assert.equal(lab.snapshot().signals,1);
 lab.observe(row(112000,100.03));assert.equal(lab.snapshot().closed,0);
 lab.observe(row(142000,100.03,.6,.3));const s=lab.snapshot();assert.equal(s.closed,1);assert.ok(Math.abs(s.netBoundUSD-.04)<1e-9);assert.equal(s.orders,0);
});
test('future or shallow quotes are rejected and missed windows are abstentions',()=>{
 const bad=row(100000);bad.market.value.book.at++;assert.equal(quote(bad),null);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lag-')),lab=create({dir,now:()=>100000});lab.observe(row(100000));lab.observe(row(110000,100.03));lab.observe(row(116000,100.03));assert.equal(lab.snapshot().missed,1);assert.equal(lab.snapshot().closed,0);
});
