'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseValue}=require('../src/kalshi-reference');
const now=1790211192000;
const response=payload=>({data:{payload}});
test('histórico acotado sin ids usa la muestra más reciente, aunque llegue desordenado',()=>{
  const result=parseValue(response([{value:'200',time:now-1000},{value:'100',time:now-3600000}]),'BRTI',now,{scoped:true});
  assert.equal(result.price,200);assert.equal(result.ageMs,1000);assert.equal(result.settlementPrice,null);
});
test('no atribuye filas anónimas ni de otro índice sin contexto correcto',()=>{
  assert.throws(()=>parseValue(response([{value:200,time:now}]),'BRTI',now));
  assert.throws(()=>parseValue(response([{id:'OTHER',value:200,time:now}]),'BRTI',now,{scoped:true}));
});
test('rechaza datos atrasados, futuros o un precio reciente inválido',()=>{
  for(const row of [{value:200,time:now-16000},{value:200,time:now+6000},{value:'invalid',time:now}])assert.throws(()=>parseValue(response([row]),'BRTI',now,{scoped:true}));
});
test('conserva soporte para muestras etiquetadas y fechas en segundos',()=>{
  assert.equal(parseValue(response([{id:'BRTI',value:'200',time:now/1000}]),'BRTI',now).price,200);
});
