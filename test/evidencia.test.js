'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const E=require('../src/evidencia'),R=require('../src/registro');
const B=require('../src/kalshi-book'),H=require('../src/reference-history');
const edge=require('../src/kalshi-edge');
test('evidencia prospectiva deduplica reinicios y espera liquidación oficial',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-'));
  try{
    const ruta=path.join(dir,'e.jsonl');let now=1000000;
    const args={mercado:{ticker:'BTC-1',vencimiento:now+600000,yesBid:.4,yesAsk:.42},prediccion:{horizontes:[]},precio:100,decision:{operar:false},cruda:{operar:false},ahora:now};
    let e=E.crear({ruta,reloj:()=>now});e.observar(args);e.observar(args);
    e=E.crear({ruta,reloj:()=>now});e.observar(args);
    assert.equal(R.leer({ruta}).entradas.length,1);
    let calls=0;await e.resolver(async()=>{calls++;return 'yes';});assert.equal(calls,0);
    now+=700000;await e.resolver(async()=>null);assert.equal(R.leer({ruta}).entradas.length,1);
    now+=300001;const batch=await e.resolver(async()=>({resultado:'yes',status:'finalized',settlementAt:'2026-09-25T01:02:48Z'}));await e.resolver(async()=>'yes');
    assert.deepEqual(batch,{consultados:1,recuperados:1,errores:0});
    const saved=R.leer({ruta}).entradas.find(r=>r.tipo==='resultado');assert.equal(saved.fuente,'Kalshi status=finalized');assert.equal(saved.settlementAt,'2026-09-25T01:02:48Z');
    const r=E.resumir(R.leer({ruta}).entradas);assert.equal(r.resueltas,1);assert.equal(r.comparaciones.length,0);assert.equal(r.beneficioNetoUSD,null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Brier compara pares de probabilidades del mismo contrato sin duplicados',()=>{
  const o={tipo:'observacion',id:'one',ticker:'A',version:'v1',tramo:'15m',observadoEn:1,vencimiento:2,p:.8,baseline:.5};
  const r=E.resumir([o,o,{tipo:'resultado',ticker:'A',resultado:'yes'}]);
  assert.equal(r.observaciones,1);assert.ok(Math.abs(r.comparaciones[0].brierModelo-.04)<1e-10);assert.equal(r.comparaciones[0].brierKalshi,.25);
});
test('libro usa la profundidad del lado opuesto para asks y ordena niveles',()=>{
  const b=B.normalizar({orderbook_fp:{yes_dollars:[['.2','3'],['.4','12']],no_dollars:[['.58','8']]}},123);
  const m=B.aplicar({ticker:'X'},b);assert.equal(m.yesAsk,.42);assert.equal(m.libro.yesAsk,8);assert.equal(m.libro.yesBid,12);
  assert.throws(()=>B.normalizar({}));
  for(const libro of [null,undefined,0,Infinity,-1])assert.equal(edge.tamano({p:.9,precio:.4,capital:50,libro,limites:edge.LIMITES}),0);
});
test('histórico del índice exige 60 segundos distintos y no rellena huecos',()=>{
  const rows=Array.from({length:60},(_,i)=>({time:1800000000000+i*1000,value:100+i}));
  const candles=H.velas({data:{payload:[...rows,rows[0]]}},1800000060001);
  assert.equal(candles.length,1);assert.equal(candles[0].mean60,129.5);assert.equal(candles[0].close,159);
  assert.equal(H.velas({data:{payload:rows.slice(1)}},1800000060001).length,0);
  assert.equal(H.continuas(candles,1800000260001).length,0);
});
