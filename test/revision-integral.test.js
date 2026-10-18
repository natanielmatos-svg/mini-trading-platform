'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const F=require('../src/forecast');
const V=require('../src/vetos');
const P=require('../src/prediccion');
const { buildDemoCandles }=require('../src/klines');

test('EWMA: añadir datos futuros no cambia ninguna sigma anterior',()=>{
 const past=Array.from({length:100},(_,i)=>Math.sin(i)*.001);
 assert.deepEqual(F.ewmaSigma(past),F.ewmaSigma([...past, .5,-.8,.9]).slice(0,past.length+1));
});

test('la caché separa activos con las mismas fechas y recalibra el modelo publicado',async()=>{
 P.cacheConforme.clear();
 const a=buildDemoCandles({symbol:'BTCUSDT',interval:'1m',limit:300,now:1700000000000});
 const b=a.map((c,i)=>({...c,close:200+Math.sin(i*.31)*3+i*.025}));
 await P.predecirActivo({candles:a,interval:'1m',bloques:1});
 const cached=await P.predecirActivo({candles:b,interval:'1m',bloques:1});
 P.cacheConforme.clear();
 const fresh=await P.predecirActivo({candles:b,interval:'1m',bloques:1});
 assert.deepEqual(cached.bandas,fresh.bandas);
 assert.equal(fresh.calibracion.metodo,'conforme walk-forward');
 assert.ok(fresh.calibracion.predicciones>=30);
});

test('una fuente que nunca responde o devuelve un objeto inválido veta',async()=>{
 for(const source of [{timeoutMs:5,vetos:()=>new Promise(()=>{})},{vetos:async()=>({})}]) {
   const vetos=await V.recoger([source]);
   assert.equal(V.aplicar({operar:true},vetos).operar,false);
 }
});

test('el agente rechaza respuestas truncadas y argumentos inválidos, sin llamar a la red',async()=>{
 const sdk=require.resolve('@anthropic-ai/sdk');
 let response;
 require.cache[sdk]={id:sdk,filename:sdk,loaded:true,exports:{default:class{constructor(){this.messages={create:async()=>response};}}}};
 const A=require('../src/agente');
 response={stop_reason:'max_tokens',content:[{type:'text',text:'Parcial'}]};
 await assert.rejects(A.vigilarContexto({activo:'BTC'}),/incompleta/);
 response={stop_reason:'tool_use',content:[{type:'tool_use',name:'vetar',input:{motivo:'evento',alcance:'ticker',objetivo:'',minutos:0}}]};
 await assert.rejects(A.vigilarContexto({activo:'BTC'}),/inválido/);
 response={stop_reason:'end_turn',content:[{type:'text',text:'Sin objeciones en el contexto proporcionado.'}]};
 assert.deepEqual(await A.vigilarContexto({activo:'BTC'}),[]);
});
