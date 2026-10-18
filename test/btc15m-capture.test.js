'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create}=require('../src/btc15m-capture');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'btc15m-'));let now=300000;
 const m={ticker:'KXBTC15M-TEST',market_type:'binary',status:'active',open_time:new Date(0).toISOString(),close_time:new Date(900000).toISOString(),floor_strike:80000,strike_type:'greater_or_equal',rules_primary:'test rules',yes_bid_dollars:'.45',yes_ask_dollars:'.47',no_bid_dollars:'.53',no_ask_dollars:'.55'};
 const block={symbol:'BTCUSDT',interval:'15m',opensAt:0,closesAt:900000,group:'test',unit:'USD',source:'consolidado',venues:[],observations:[],prediction:{at:100,raw:80001,candidate:80002,baseline:80000,version:'test'}};
 const opts={root,clock:()=>now,list:async()=>({markets:[m]}),book:async()=>({at:now,yes:[{precio:.45,cantidad:10}],no:[{precio:.53,cantidad:10}]}),market:async()=>({...m,status:'finalized',result:'yes'})};
 return {root,m,block,opts,setNow:n=>now=n,events:()=>fs.readFileSync(path.join(root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('freezes pre-request predictions, deduplicates restarts and reconciles official settlement',async()=>{
 const f=fixture();try{let service=create(f.opts);await service.tick([f.block]);await service.tick([f.block]);assert.equal(f.events().length,1);assert.equal(f.events()[0].fixedWindowEligible,true);
 f.block.prediction.raw=999;assert.equal(f.events()[0].predictions[0].prediction.raw,80001);
 service=create(f.opts);await service.tick([f.block]);assert.equal(service.snapshot().samples,1);
 f.setNow(900001);await service.tick([]);assert.equal(service.snapshot().resolvedContracts,1);assert.equal(f.events()[1].resultado,'yes');
 assert.equal(service.snapshot().netProfitUSD,null);assert.equal(service.snapshot().liveEnabled,false);
 }finally{f.cleanup();}
});
test('does not join future predictions or invent fills when depth is missing',async()=>{
 const f=fixture();try{f.block.prediction.at=300001;const s=create({...f.opts,book:async()=>{throw Error();}});await s.tick([f.block]);const e=f.events()[0];assert.equal(e.predictions.length,0);assert.equal(e.fixedWindowEligible,false);assert.equal(e.executionSimulated,false);assert.equal(e.book,null);}finally{f.cleanup();}
});
test('discards captures crossing close; rejects ambiguous list and provisional settlement',async()=>{
 const f=fixture();try{const s=create({...f.opts,book:async()=>{f.setNow(900001);return null;}});await s.tick([f.block]);assert.equal(s.snapshot().samples,0);
 f.setNow(300000);const ambiguous=create({...f.opts,list:async()=>({markets:[f.m,{...f.m,ticker:'KXBTC15M-SECOND'}]})});await ambiguous.tick([f.block]);assert.equal(ambiguous.snapshot().samples,0);
 const p=create({...f.opts,market:async()=>({...f.m,status:'finalized',result:'yes',is_provisional:true})});await p.tick([f.block]);f.setNow(900001);await p.tick([]);assert.equal(p.snapshot().resolvedContracts,0);
 }finally{f.cleanup();}
});

test('preserves eligible second capture in same minute and deduplicates its restart',async()=>{const f=fixture();try{const s=create(f.opts);f.setNow(250000);await s.tick([f.block]);assert.equal(f.events()[0].fixedWindowEligible,false);f.setNow(280000);await s.tick([f.block]);assert.equal(f.events().length,2);assert.equal(f.events()[1].fixedWindowEligible,true);await create(f.opts).tick([f.block]);assert.equal(f.events().length,2);}finally{f.cleanup();}});
test('prospective BRTI captures without neuronal predictions and freezes first decision across restart',async()=>{const f=fixture();try{let calls=0;const opts={...f.opts,brti:{reference:async()=>{calls++;return {ok:true,index:'BRTI',currency:'USD',price:80001,at:299000};},fees:async()=>({verified:true,upperBound:.03,checkedAt:300000})}};let s=create(opts);await s.tick([]);assert.equal(s.snapshot().brtiProspective.pending,1);assert.equal(f.events()[0].fixedWindowEligible,false);s=create(opts);await s.tick([]);assert.equal(calls,1);f.setNow(900001);await s.tick([]);assert.equal(s.snapshot().brtiProspective.evaluated,1);}finally{f.cleanup();}});


// --- Elegir umbral dentro de la escalera de Kalshi --------------------------
//
// Kalshi publica varios strikes por cierre. Exigir exactamente uno abortaba la
// captura en casi todas las rondas: diecisiete contratos en tres semanas,
// cuando los de quince minutos dan noventa y seis al día.

const {elegirUmbral}=require('../src/btc15m-capture');
const escalera=ts=>({closesAt:900000,contracts:ts.map(t=>({ticker:'KXBTC15M-'+t,threshold:t,closesAt:900000})).sort((a,b)=>a.threshold-b.threshold)});
const conPrecio=precio=>[{symbol:'BTCUSDT',interval:'15m',closesAt:900000,observations:[{at:1000,price:precio}]}];

test('de una escalera se elige el umbral más cercano al precio observado',()=>{
 // El de mayor contenido informativo: su probabilidad está cerca del 50%, que
 // es donde los modelos llegan a distinguirse entre sí.
 const c=elegirUmbral(escalera([79000,79500,80000,80500,81000]),conPrecio(80200),300000);
 assert.equal(c.threshold,80000);
});

test('NO se coge el primero de la lista, que es el más profundo dentro del dinero',()=>{
 // `contracts` viene ordenado por umbral ascendente. Quedarse con [0] habría
 // capturado siempre el contrato cuya respuesta se sabe de antemano y que
 // todos los modelos aciertan: muestra inútil para comparar nada.
 const ladera=escalera([70000,80000,90000]);
 assert.equal(ladera.contracts[0].threshold,70000);
 assert.equal(elegirUmbral(ladera,conPrecio(89000),300000).threshold,90000);
});

test('sin precio observado no se elige, aunque haya escalera',()=>{
 // Coger uno arbitrario mezclaría strikes triviales y difíciles en la misma
 // muestra, y después nadie podría separarlos.
 const l=escalera([79000,80000,81000]);
 assert.equal(elegirUmbral(l,[],300000),null);
 assert.equal(elegirUmbral(l,[{symbol:'BTCUSDT',interval:'15m',closesAt:900000,observations:[]}],300000),null);
 assert.equal(elegirUmbral(l,conPrecio(0),300000),null);
});

test('una observación posterior a la petición no sirve para elegir',()=>{
 // Elegir el umbral con un precio que todavía no se conocía sería mirar el
 // futuro, igual que lo sería en cualquier otra parte de la captura.
 const futura=[{symbol:'BTCUSDT',interval:'15m',closesAt:900000,observations:[{at:400000,price:80200}]}];
 assert.equal(elegirUmbral(escalera([79000,80000,81000]),futura,300000),null);
});

test('dos umbrales a la misma distancia siguen abortando',()=>{
 // Ambigüedad de verdad: el mismo contrato listado dos veces, o una escalera
 // simétrica. Elegir ahí sería inventarse un criterio.
 assert.equal(elegirUmbral(escalera([80000,80000]),conPrecio(80000),300000),null);
 assert.equal(elegirUmbral(escalera([79000,81000]),conPrecio(80000),300000),null,'simétrica alrededor del precio');
});

test('con un solo umbral se elige sin necesitar precio',()=>{
 assert.equal(elegirUmbral(escalera([80000]),[],300000).threshold,80000);
 assert.equal(elegirUmbral(escalera([]),conPrecio(80000),300000),null);
});

test('una escalera entera se captura, en vez de abortar la ronda',async()=>{
 // La prueba que cierra el fallo: antes esto daba cero muestras.
 const f=fixture();
 try{
  const ladera=[70000,80000,90000].map(t=>({...f.m,ticker:'KXBTC15M-'+t,floor_strike:t}));
  f.block.observations=[{at:1000,price:80200}];
  const s=create({...f.opts,list:async()=>({markets:ladera})});
  await s.tick([f.block]);

  assert.equal(s.snapshot().samples,1,'antes del arreglo: 0');
  assert.equal(f.events()[0].ticker,'KXBTC15M-80000','el más cercano a 80.200');
  assert.equal(f.events()[0].threshold,80000);
  assert.equal(f.events()[0].fixedWindowEligible,true);
 }finally{f.cleanup();}
});
