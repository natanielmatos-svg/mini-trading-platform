'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assess}=require('../src/production-readiness');
const now=1000000;
const input={now,config:{capital:20,maxDailyLossPct:1,maxPerTrade:.5},bot:{running:true},learning:{lastRun:now,errors:[]},account:{ok:true,complete:true,checkedAt:now,balanceUSD:20}};
test('20 USD no activa órdenes y detecta exposición superior al presupuesto diario',()=>{
 const r=assess(input);assert.equal(r.dailyBudgetUSD,.2);assert.equal(r.ready,false);assert.equal(r.liveEnabled,false);assert.equal(r.checks.find(c=>c.id==='risk').ok,false);
});
test('cuenta incompleta o vieja no se considera verificada',()=>{
 for(const account of [{ok:false},{...input.account,complete:false},{...input.account,checkedAt:now-100000}])assert.equal(assess({...input,account}).checks.find(c=>c.id==='account').ok,false);
});
test('salud operativa nunca sustituye validación de ejecución y ventaja',()=>{
 const r=assess({...input,config:{...input.config,maxPerTrade:.1}});assert.equal(r.checks.find(c=>c.id==='risk').ok,true);assert.equal(r.ready,false);
 for(const id of ['settlement','execution','advantage'])assert.equal(r.checks.find(c=>c.id===id).ok,false);
});
test('datos demo o aprendizaje vencido se marcan como pendientes',()=>{
 const r=assess({...input,demo:true,learning:{lastRun:now-200000,errors:[]}});for(const id of ['mode','learning'])assert.equal(r.checks.find(c=>c.id===id).ok,false);
});
