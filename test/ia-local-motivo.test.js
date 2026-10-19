'use strict';
const test=require('node:test'),assert=require('node:assert');
const fs=require('node:fs'),path=require('node:path');
const localAI=require('../src/local-price-ai');

const raiz=path.join(__dirname,'..');
const vivo=fs.readFileSync(path.join(raiz,'public/live-learning.js'),'utf8');
const cierre=fs.readFileSync(path.join(raiz,'src/close-learning.js'),'utf8');

test('el número que enseña la interfaz es el umbral que de verdad bloquea',()=>{
 // El navegador no recibe src/local-price-ai.js, así que la cifra está escrita
 // dos veces. Si alguien cambia el umbral y no la etiqueta, la interfaz miente
 // sobre cuánto falta.
 const etiqueta=vivo.match(/necesita (\d+) cierres de esta fase/);
 assert.ok(etiqueta,'la etiqueta de IA local ya no dice cuántos cierres faltan');
 assert.equal(Number(etiqueta[1]),localAI.MINIMO_ENTRENAMIENTO);
});

test('la interfaz nombra el mismo par que la condición del servidor',()=>{
 // close-learning sólo propone para BTCUSDT 15m; en cualquier otro activo o
 // bloque el nodo no se encenderá jamás y decir «Esperando evento» es falso.
 assert.match(cierre,/target\.symbol==='BTCUSDT'&&target\.interval==='15m'/);
 assert.match(vivo,/next\[0\]==='BTCUSDT'&&next\[1\]==='15m'/);
 assert.match(vivo,/Sólo para BTCUSDT · 15m/);
});

// --- El umbral, sobre el módulo real ---------------------------------------

const bloque=(closesAt,actual,precio)=>({
 group:'g',symbol:'BTCUSDT',interval:'15m',opensAt:closesAt-900000,closesAt,
 actual,resolvedAt:closesAt,
 observations:[{at:closesAt-900000+1000,price:precio,open:precio,high:precio*1.001,low:precio*0.999}]});

function historial(n,hasta){
 const bloques=[];
 for(let i=0;i<n;i++){const c=hasta-(n-i)*900000;bloques.push(bloque(c,80000+i*7,80000+i*5));}
 return bloques;
}

test('por debajo del umbral no propone, y en el umbral sí',()=>{
 const ahora=100*900000;
 const actual={group:'g',symbol:'BTCUSDT',interval:'15m',opensAt:ahora-900000,closesAt:ahora,actual:null,
  observations:[{at:ahora-900000+1000,price:80500,open:80500,high:80600,low:80400}]};
 const obs=actual.observations[0];
 const menos=localAI.propose(actual,obs,historial(localAI.MINIMO_ENTRENAMIENTO-1,ahora-900000));
 assert.equal(menos,null,'con un cierre menos del umbral no debería proponer');
 const justo=localAI.propose(actual,obs,historial(localAI.MINIMO_ENTRENAMIENTO,ahora-900000));
 assert.ok(justo,'en el umbral exacto debería proponer');
});
