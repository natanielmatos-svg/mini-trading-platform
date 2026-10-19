'use strict';
const test=require('node:test'),assert=require('node:assert');
const {evaluar,comisionIlustrativa}=require('../src/pronosticos');

const VENUES=['binance','coinbase','gemini','kraken'];
// raw/candidate: precio estimado. observation.price: último precio visto.
const captura=({ticker,threshold=80000,operator='>',raw,candidate,price,yesAsk=0.5,noAsk=0.5,yesBid=0.48,elegible=true,version='v1',at=1000})=>
 ({type:'sample',ticker,threshold,operator,requestedAt:at,fixedWindowEligible:elegible,
   quotes:{yesAsk,noAsk,yesBid},
   predictions:[{source:'consolidado',unit:'USD',venues:VENUES,prediction:{raw,candidate,version},observation:{price}}]});
const liquidacion=(ticker,resultado)=>({type:'settlement',ticker,resultado});

test('sólo cuentan los contratos liquidados',()=>{
 const r=evaluar([captura({ticker:'A',raw:81000,candidate:81000,price:81000}),
                  captura({ticker:'B',raw:81000,candidate:81000,price:81000}),
                  liquidacion('A','yes')]);
 assert.equal(r.rows.length,1);
 assert.equal(r.rows[0].ticker,'A');
 // B existe en la cobertura aunque no se pueda puntuar: no es lo mismo
 // «todavía no ha liquidado» que «no hay datos».
 assert.equal(r.coverage.contracts,2);
 assert.equal(r.coverage.evaluated,1);
});

test('de varias capturas del mismo contrato se usa la primera, no la que más conviene',()=>{
 // La segunda acierta y la primera falla. Quedarse con la segunda sería
 // elegir después de ver el resultado.
 const r=evaluar([captura({ticker:'A',raw:79000,candidate:79000,price:79000,at:1000}),
                  captura({ticker:'A',raw:81000,candidate:81000,price:81000,at:2000}),
                  liquidacion('A','yes')]);
 assert.equal(r.rows.length,1);
 assert.equal(r.rows[0].at,1000);
 assert.equal(r.rows[0].raw.win,false);
});

test('una captura fuera de la ventana fija no entra',()=>{
 const r=evaluar([captura({ticker:'A',raw:81000,candidate:81000,price:81000,elegible:false}),liquidacion('A','yes')]);
 assert.equal(r.rows.length,0);
 assert.equal(r.coverage.fixedWindowSamples,0);
});

test('el operador decide el lado en el umbral exacto',()=>{
 const estricto=evaluar([captura({ticker:'A',operator:'>',raw:80000,candidate:80000,price:80000}),liquidacion('A','no')]);
 assert.equal(estricto.rows[0].raw.side,'no');
 const inclusivo=evaluar([captura({ticker:'A',operator:'>=',raw:80000,candidate:80000,price:80000}),liquidacion('A','yes')]);
 assert.equal(inclusivo.rows[0].raw.side,'yes');
});

test('el lado del mercado sale de que yesBid+yesAsk llegue a 1',()=>{
 const caro=evaluar([captura({ticker:'A',raw:81000,candidate:81000,price:81000,yesBid:0.55,yesAsk:0.6}),liquidacion('A','yes')]);
 assert.equal(caro.rows[0].market.side,'yes');
 const barato=evaluar([captura({ticker:'A',raw:81000,candidate:81000,price:81000,yesBid:0.3,yesAsk:0.35}),liquidacion('A','yes')]);
 assert.equal(barato.rows[0].market.side,'no');
});

test('el bruto descuenta lo que costó entrar, no sólo si acertó',()=>{
 const r=evaluar([captura({ticker:'A',raw:81000,candidate:81000,price:81000,yesAsk:0.7}),liquidacion('A','yes')]);
 const f=r.rows[0].raw;
 assert.equal(f.win,true);
 assert.equal(Number(f.gross.toFixed(10)),0.3);      // 1 − 0,70
 assert.equal(f.illustrativeFee,0.02);               // 0,07·0,7·0,3 = 0,0147 → 0,02
});

test('las versiones del modelo no se suman entre sí',()=>{
 const r=evaluar([captura({ticker:'A',raw:81000,candidate:81000,price:81000,version:'v1'}),
                  captura({ticker:'B',raw:79000,candidate:79000,price:79000,version:'v2'}),
                  liquidacion('A','yes'),liquidacion('B','yes')]);
 assert.equal(r.groups.length,2);
 assert.equal(r.groups.find(g=>g.version==='v1').strategies.raw.wins,1);
 assert.equal(r.groups.find(g=>g.version==='v2').strategies.raw.wins,0);
});

test('la comisión ilustrativa es máxima a mitad de precio y se redondea al alza',()=>{
 assert.equal(comisionIlustrativa(0.5),0.02);   // 0,0175
 assert.equal(comisionIlustrativa(0.05),0.01);  // 0,0033
 assert.equal(comisionIlustrativa(0.95),0.01);
 // En los extremos no desaparece: redondear al alza nunca da cero salvo en 0 o 1.
 assert.equal(comisionIlustrativa(0),0);
 assert.equal(comisionIlustrativa(1),0);
});

test('una captura sin precio observado no se puntúa en vez de contar como fallo',()=>{
 const sin=captura({ticker:'A',raw:81000,candidate:81000,price:81000});
 sin.predictions[0].observation.price=null;
 assert.equal(evaluar([sin,liquidacion('A','yes')]).rows.length,0);
});

test('una captura de otras fuentes o monedas no se mezcla',()=>{
 const otra=captura({ticker:'A',raw:81000,candidate:81000,price:81000});
 otra.predictions[0].venues=['binance'];
 assert.equal(evaluar([otra,liquidacion('A','yes')]).rows.length,0);
});
