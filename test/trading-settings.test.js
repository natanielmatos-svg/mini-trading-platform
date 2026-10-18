'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validate,validateForSave}=require('../src/trading-settings');
test('capital y pérdida porcentual conservan el tamaño automático',()=>{
  const c=validate({capital:50,maxDailyLossPct:5,maxPerTrade:null,paused:false});
  assert.equal(c.capital*c.maxDailyLossPct/100,2.5);assert.equal(c.maxPerTrade,null);
});
test('rechaza importes inválidos y activación real mediante configuración',()=>{
  for(const c of [{capital:0},{capital:NaN},{capital:1.001},{maxDailyLossPct:101},{maxPerTrade:51},{paused:'false'},{live:true},{capital:'50'}])assert.throws(()=>validate(c));
});
test('impide guardar un límite por operación mayor que la pérdida diaria sin elevar el riesgo',()=>{
  const config={capital:20,maxDailyLossPct:1,maxPerTrade:10,paused:false};
  assert.throws(()=>validateForSave(config),/0\.20 USD/);
  assert.equal(config.maxDailyLossPct,1);
  assert.equal(validateForSave({...config,maxPerTrade:.2}).maxPerTrade,.2);
  assert.equal(validateForSave({...config,maxPerTrade:null}).maxPerTrade,null);
  assert.throws(()=>validateForSave({...config,capital:19.99,maxPerTrade:.2}),/0\.19 USD/);
  assert.equal(validate(config).maxPerTrade,10); // Legacy state remains readable for correction.
});
