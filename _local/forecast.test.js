'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepare,forecast,cache}=require('../src/forecast-neural');
const {parseValue,signedHeaders,indexFor}=require('../src/kalshi-reference');
const crypto=require('node:crypto');
const now=1700000000000;
function candles(){return Array.from({length:130},(_,i)=>({openTime:now-(129-i)*60000-30000,closeTime:now-(128-i)*60000-30001,close:100+i/10,closed:i<129}));}
const result={model:'fixture',quantiles:[110,111,112,113,114,115,116,117,118],estimatedClose:114,validation:{samples:24,mae:1,baselineMae:2,coverage80:.8}};

test('forecast excluye la vela en curso de la entrada y publica el bloque correcto',async()=>{
  cache.clear(); const data={symbol:'TEST',interval:'1m',source:'demo',fetchedAt:now,candles:candles()};
  let input;
  const output=await forecast(data,{now,predict:async values=>{input=values;return result;}});
  assert.equal(input.length,129);assert.equal(input.at(-1),112.8);
  assert.equal(output.demo,true);assert.equal(output.closesAt,now+30000);
  assert.equal(output.direction,'subida estimada');assert.equal(output.tradingEdgeValidated,false);assert.equal(output.historicalCheckPassed,false);assert.equal(output.referenceUnit,'USDT');
});
test('forecast se abstiene con huecos, datos viejos, pocos datos y bolsa cerrada',()=>{
  const values=candles();
  assert.equal(prepare(values,{now}).ok,true);
  assert.equal(prepare(values.slice(0,-1),{now}).ok,false);
  assert.equal(prepare(values.slice(-20),{now}).ok,false);
  values.splice(40,1);assert.equal(prepare(values,{now}).ok,false);
  assert.equal(prepare(candles(),{now,market:'stocks',clock:{isOpen:false}}).ok,false);
});
test('la caché distingue fuente y bloque y comparte la inferencia',async()=>{
  cache.clear();let calls=0;
  const data={symbol:'CACHE',interval:'1m',source:'demo',candles:candles()};
  const predict=async()=>{calls++;return result;};
  await Promise.all([forecast(data,{now,predict}),forecast(data,{now,predict})]);assert.equal(calls,1);
  await forecast({...data,source:'binance'},{now,predict});assert.equal(calls,2);
});
test('Kalshi conserva fecha y unidad y rechaza índices incorrectos o viejos',()=>{
  const raw={data:{payload:[{id:'BRTI',value:'69000.12',time:now}]}};
  assert.equal(parseValue(raw,'BRTI',now).price,69000.12);
  assert.equal(parseValue(raw,'BRTI',now).settlementPrice,null);
  assert.throws(()=>parseValue(raw,'ETHUSD_RTI',now));
  assert.throws(()=>parseValue(raw,'BRTI',now+16000));
  assert.throws(()=>parseValue({data:{payload:[{id:'BRTI',value:'123'}]}},'BRTI',now));
  assert.equal(indexFor('SOLUSDT'),'SOLUSD_RTI');assert.equal(indexFor('AAPL'),null);
});
test('la firma Kalshi usa RSA-PSS y excluye la consulta',()=>{
  const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const h=signedHeaders('id',privateKey,'https://external-api.kalshi.com/trade-api/v2/cfbenchmarks/values?id=BRTI',now);
  assert.equal(crypto.verify('sha256',Buffer.from(now+'GET/trade-api/v2/cfbenchmarks/values'),{key:publicKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST},Buffer.from(h['KALSHI-ACCESS-SIGNATURE'],'base64')),true);
});
