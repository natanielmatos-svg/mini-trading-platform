'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{EventEmitter}=require('node:events');
function setup(t,{fail=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-control-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let spawns=0;let risk={capital:50,maxDailyLossPct:1,maxPerTrade:.5,paused:false};const live=new Set();
 const proc={pid:123,execPath:process.execPath,env:{},once(){},kill(pid){if(!live.has(pid)){const e=Error();e.code='ESRCH';throw e;}}};
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bot-control.js'),'utf8'),{__dirname:path.join(root,'src'),module:mod,process:proc,require(n){if(n==='node:child_process')return {spawn(){spawns++;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit(fail?'error':'spawn',Error('failed')));return child;}};if(n==='./trading-settings')return {read:()=>risk,save:v=>{risk=v}};if(n==='./bot-runtime')return {read:()=>({})};if(n==='./agente')return {PROVEEDOR:'openai'};return require(n);}});
 return {api:mod.exports,root,live,proc,spawns:()=>spawns,risk:()=>risk};
}
test('controls validate actions, preserve agent state on stop and require credential',async t=>{
 const {api,proc}=setup(t);await assert.rejects(api.command('anything'));await assert.rejects(api.command('agent-on'));
 proc.env.OPENAI_API_KEY='test';await api.command('agent-on');await api.command('stop');assert.equal(api.read().agentEnabled,true);assert.equal(api.read().botEnabled,false);await api.command('agent-off');assert.equal(api.read().agentEnabled,false);
});
test('start is serialized and a live process lock prevents duplicate processes',async t=>{
 const {api,live,spawns}=setup(t);const first=api.command('start');await assert.rejects(api.command('start'));await first;assert.equal(spawns(),1);
 api.acquire();live.add(123);await api.command('start');assert.equal(spawns(),1);assert.throws(()=>api.acquire());await api.command('stop');await assert.rejects(api.command('start'));
});
test('spawn failure leaves requested bot state off',async t=>{const {api}=setup(t,{fail:true});await assert.rejects(api.command('start'));assert.equal(api.read().botEnabled,false);});
test('corrupt control blocks changes instead of resetting silently',async t=>{const {api,root}=setup(t);api.save({botEnabled:true,agentEnabled:false});fs.writeFileSync(path.join(root,'datos/bot-control.json'),'broken');assert.throws(()=>api.read());await assert.rejects(api.command('start'));});

test('pause and resume preserve capital limits, agent and process',async t=>{const {api,risk,spawns}=setup(t);api.save({botEnabled:true,agentEnabled:true});await api.command('pause');assert.equal(risk().paused,true);assert.equal(risk().capital,50);assert.equal(risk().maxDailyLossPct,1);assert.equal(risk().maxPerTrade,.5);assert.equal(api.read().agentEnabled,true);assert.equal(api.read().botEnabled,true);await api.command('resume');assert.equal(risk().paused,false);assert.equal(spawns(),0);});
