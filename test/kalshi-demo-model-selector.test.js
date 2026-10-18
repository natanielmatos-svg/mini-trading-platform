'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {select}=require('../src/kalshi-demo-model-selector');
const {VERSION}=require('../src/kalshi-model-benchmark');
// `brti` va en el fixture porque va en el congelado de verdad: `freeze()` en
// kalshi-model-benchmark.js devuelve null si no hay precio del índice, así que
// toda muestra válida lo tiene. Se mezcla con los que pase quien llame, para
// que las pruebas que fijan precios a mano no se queden sin él.
const PRECIOS={timesfm:90,localAI:105,spot:99,brti:98};
function pair(i,{prices,actual=110,key='same',emittedAt=null}={}){
 const close=1000000+i*900000,at=close-600000,ticker='KXBTC15M-'+i;
 const p={...PRECIOS,...(prices||{})};
 const emitido=emittedAt||Object.fromEntries(Object.keys(p).map(n=>[n,at-100]));
 return [{type:'sample',ticker,at,requestedAt:at-10,closesAt:close,fixedWindowEligible:true,threshold:100,operator:'>=',unit:'USD',modelBenchmark:{version:VERSION,at,key,prices:p,emittedAt:emitido,localModelId:'local-'+i}}, {type:'settlement',ticker,at:close+100,status:'finalized',resultado:actual>=100?'yes':'no',expirationValue:String(actual)}];
}
test('same settled contracts rank by correct side, not small numeric error',()=>{const events=Array.from({length:15},(_,i)=>pair(i)).flat();const r=select(events,{now:20000000});assert.equal(r.selection.winner,'localAI');assert.equal(r.selection.ranking[0].correct,15);assert.equal(r.forecast,null);assert.equal(r.selection.provisional,true);});
test('MAE breaks equal accuracy without claiming stable superiority',()=>{const r=select(pair(0,{prices:{timesfm:105,localAI:106,spot:109}}),{now:2000000});assert.equal(r.selection.winner,'spot');assert.equal(r.selection.totalCases,1);});
test('future settlements, duplicated contracts, wrong group and future prediction excluded',()=>{const a=pair(0),b=pair(1),c=pair(2);b[1].at=99999999;c[0].modelBenchmark.emittedAt.localAI=99999999;const r=select([...pair(-1,{key:'other'}),...a,...a,...b,...c],{now:4000000});assert.equal(r.selection.totalCases,1);});
test('50 resolved contracts split selection from 20 calibration cases with current matching',()=>{
 const events=Array.from({length:50},(_,i)=>pair(i)).flat();const current=pair(51)[0],market={ticker:current.ticker,close_time:new Date(current.closesAt).toISOString(),floor_strike:100};
 const r=select([...events,current],{now:current.at+500,market});assert.equal(r.selection.selectionCases,30);assert.equal(r.selection.calibrationCases,20);assert.equal(r.forecast.selectedEngine,'localAI');assert.equal(r.forecast.predictionInterval.lower,110);assert.equal(r.forecast.quantiles,undefined);
 market.floor_strike=101;assert.equal(select([...events,current],{now:current.at+500,market}).forecast,null);
 assert.equal(select([...events,current],{now:current.at+90001,market:{...market,floor_strike:100}}).forecast,null);
});
test('calibration outcomes cannot pick winner',()=>{const events=Array.from({length:50},(_,i)=>pair(i,{actual:i<30?110:90})).flat(),current=pair(51)[0];const r=select([...events,current],{now:current.at+500,market:{ticker:current.ticker,close_time:new Date(current.closesAt).toISOString(),floor_strike:100}});assert.equal(r.selection.winner,'localAI');});


// --- Mantener BRTI como competidor -----------------------------------------

test('BRTI se puntúa como un modelo más, con su acierto y su MAE',()=>{
 // El dato ya se congelaba con cada muestra; sólo faltaba rankearlo.
 const r=select(Array.from({length:15},(_,i)=>pair(i)).flat(),{now:20000000});
 const brti=r.selection.ranking.find(m=>m.model==='brti');
 assert.ok(brti,'BRTI tiene que aparecer en el ranking');
 assert.equal(brti.label,'Mantener BRTI');
 assert.equal(brti.cases,15);
 assert.equal(brti.correct,0,'a 98 con umbral 100 falla el lado las quince veces');
 assert.equal(brti.maeUSD,12,'y su error medio es |98 − 110|');
 assert.deepEqual(r.selection.models,['timesfm','localAI','spot','brti']);
});

test('si mantener BRTI gana, gana: el selector puede decir «ninguno de tus modelos sirve»',()=>{
 // Lo que el ranking de tres no podía concluir. Si la referencia trivial bate
 // a TimesFM y a la IA local, enterarse es justo el resultado valioso.
 const eventos=Array.from({length:50},(_,i)=>pair(i,{prices:{timesfm:90,localAI:91,spot:92,brti:109}})).flat();
 const actual=pair(51,{prices:{timesfm:90,localAI:91,spot:92,brti:109}})[0];
 const r=select([...eventos,actual],{now:actual.at+500,market:{ticker:actual.ticker,close_time:new Date(actual.closesAt).toISOString(),floor_strike:100}});

 assert.equal(r.selection.winner,'brti');
 assert.equal(r.selection.label,'Mantener BRTI');
 assert.equal(r.forecast.selectedEngine,'brti');
 assert.equal(r.forecast.modelId,'brti','y no el identificador del modelo local');
 assert.equal(r.forecast.estimatedClose,109);
 assert.equal(r.forecast.predictionInterval.lower,110,'el intervalo sale de SUS errores');
});

test('una muestra sin precio de BRTI queda fuera, no se puntúa a medias',()=>{
 // Es la propiedad que hizo fallar a las cinco pruebas de arriba al añadir el
 // modelo, y es la correcta: rankear un modelo con el dato ausente compararía
 // cuatro modelos sobre muestras distintas.
 const sinBrti=pair(0);
 delete sinBrti[0].modelBenchmark.prices.brti;
 assert.equal(select(sinBrti,{now:4000000}).selection.totalCases,0);

 const sinFecha=pair(1);
 delete sinFecha[0].modelBenchmark.emittedAt.brti;
 assert.equal(select(sinFecha,{now:4000000}).selection.totalCases,0);
});

test('BRTI tampoco puede ganar con los contratos reservados a calibración',()=>{
 // La misma separación que protege a los otros tres.
 const bueno={timesfm:90,localAI:105,spot:99,brti:98},malo={timesfm:90,localAI:91,spot:92,brti:109};
 const eventos=Array.from({length:50},(_,i)=>pair(i,{prices:i<30?bueno:malo})).flat();
 const actual=pair(51)[0];
 const r=select([...eventos,actual],{now:actual.at+500,market:{ticker:actual.ticker,close_time:new Date(actual.closesAt).toISOString(),floor_strike:100}});
 assert.equal(r.selection.winner,'localAI','los últimos veinte no eligen');
});
