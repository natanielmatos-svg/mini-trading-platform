'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../src/supervised-ticket');
const now=100000,id='a'.repeat(64),p={id,ticker:'TEST',side:'yes',quantity:1,price:.1,estimatedFees:.01,total:.11,expiresAt:now+60000,blockers:[]};
const m={ticker:'TEST',market_type:'binary',status:'active',close_time:new Date(now+300000).toISOString(),yes_ask_dollars:'0.1000',rules_primary:'Test rules'};
const a={requestedAt:now,balance:{available:50,checkedAt:now},sections:{positions:{complete:true},orders:{complete:true}},summary:{openPositions:0,restingOrders:0}};
function deps(extra={}){return {proposals:{snapshot:()=>({proposals:[p]})},market:async()=>m,account:async()=>a,settings:()=>({capital:20,maxDailyLossPct:1,maxPerTrade:1,paused:false}),clock:()=>now,...extra};}
test('prepara ficha de lectura con precio en dólares, límites y caducidad corta sin ejecutar',async()=>{const t=await create(deps())(id);assert.equal(t.execution,'not_sent');assert.equal(t.market.ask,.1);assert.equal(t.expiresAt,now+15000);assert.equal(t.limits.dailyBudget,.2);assert.equal(t.proposal.estimatedCost,.11);assert.deepEqual(t.blockers,[]);});
test('detecta mercado cerrado, precio peor, cuenta incompleta y límite excedido',async()=>{const t=await create(deps({market:async()=>({...m,status:'closed',yes_ask_dollars:'.20'}),account:async()=>({...a,balance:{available:0},sections:{}}),settings:()=>({capital:.1,maxDailyLossPct:1,maxPerTrade:.1,paused:true})}))(id);for(const phrase of ['Mercado cerrado','oferta actual','saldo, posiciones','Saldo insuficiente','límites configurados','pausa'])assert(t.blockers.some(b=>b.includes(phrase)),phrase);});
test('descarta propuesta sustituida durante la consulta y verifica caducidad al terminar',async()=>{let n=0;await assert.rejects(create(deps({proposals:{snapshot:()=>({proposals:++n===1?[p]:[]})}}))(id));const t=await create(deps({clock:()=>now+61000}))(id);assert(t.blockers.includes('Propuesta vencida'));});
test('fallos de proveedor no inventan saldo ni precio; ticker equivocado no se acepta',async()=>{const t=await create(deps({market:async()=>({...m,ticker:'OTHER'}),account:async()=>{throw Error('offline');}}))(id);assert.equal(t.market,null);assert.equal(t.account.available,null);assert(t.blockers.length>=2);});
test('bloquea costes ausentes, subestimados y comisiones inválidas',async()=>{
 for(const change of [{total:null},{total:NaN},{total:.1},{estimatedFees:null},{estimatedFees:-.01},{price:NaN}]){
  const t=await create(deps({proposals:{snapshot:()=>({proposals:[{...p,...change}]})}}))(id);
  assert(t.blockers.includes('Coste total o comisiones no verificables'));
  assert.equal(t.execution,'not_sent');
 }
});
