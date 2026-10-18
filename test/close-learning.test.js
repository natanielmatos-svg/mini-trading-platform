'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create}=require('../src/close-learning');
test('comparison reports missing TimesFM separately and uses matched baseline cases',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'learning-pairs-')),version=require('../src/local-price-ai').VERSION;
 try{
  const predictions=[{absoluteError:4,baselineError:2,rawNeural:null,rawError:null},{absoluteError:6,baselineError:4,rawNeural:100,rawError:8},{absoluteError:99,rawNeural:null},{price:100}].map(p=>({...p,phase:0,version}));
  fs.writeFileSync(path.join(root,'state.json'),JSON.stringify({version:1,targets:[],blocks:[{group:'g',symbol:'BTCUSDT',interval:'15m',source:'consolidado',venues:[],observations:[],localPredictions:predictions}]}));
  const g=create({root}).snapshot().localAI.groups[0];
  assert.equal(g.samples,3);assert.equal(g.pendingSamples,1);assert.equal(g.missingNeuralSamples,2);assert.equal(g.baselineSamples,2);assert.equal(g.baselineLocalMae,5);assert.equal(g.baselineObservedMae,3);assert.equal(g.rawPairedSamples,1);assert.equal(g.localPairedMae,6);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('aprende sólo de cierres anteriores, congela candidato y conserva movimientos y diferencias',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'learning-'));let now=100;
 const learner=create({root,clock:()=>now}),target={symbol:'BTCUSDT',interval:'1m'};
 const candle=(i,closed=false)=>({openTime:i*60000,closeTime:(i+1)*60000-1,open:100,high:104,low:99,close:100,volume:50,closed});
 const data=cs=>({fuente:'consolidado',candles:cs});
 try{
  for(let i=0;i<32;i++){
   now=i*60000+100;
   const cs=i?[candle(i-1,true),candle(i)]:[candle(i)];
   learner.ingest(target,data(cs),{ok:true,price:99,at:now,index:'test'},{ok:true,generatedAt:now,closesAt:(i+1)*60000,estimatedClose:102,modelId:'test',baseline:{price:100}});
  }
  const state=JSON.parse(fs.readFileSync(path.join(root,'state.json')));
  const last=state.blocks.at(-1);assert.equal(last.prediction.trainingSamples,30);assert.equal(last.prediction.correctionPct,-1);assert.equal(last.prediction.candidate,100.98);
  assert.equal(last.observations[0].reference.price,99);assert.ok(last.observations[0].basisPct>0);
  assert.equal(state.blocks[0].realized.rangePct,5);assert.equal(state.blocks[0].error,2);
  learner.ingest(target,data([candle(31)]),null,{ok:true,generatedAt:now,closesAt:32*60000,estimatedClose:999,modelId:'test',baseline:{price:100}});
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).blocks.at(-1).prediction.raw,102);
  assert.equal(learner.snapshot().activeModelChanged,false);
  assert.equal(create({root,clock:()=>now}).snapshot().groups[0].scored,31);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('no mezcla fuentes ni admite demo o predicciones hechas después del cierre',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'learning-'));let now=10;const l=create({root,clock:()=>now}),t={symbol:'BTCUSDT',interval:'1m'};
 const c={openTime:0,closeTime:99,close:100,closed:false};
 try{
  l.ingest(t,{fuente:'demo',candles:[c]});assert.equal(l.snapshot().retainedBlocks,0);
  l.ingest(t,{fuente:'consolidado',candles:[c]},null,{ok:true,generatedAt:101,closesAt:100,estimatedClose:102,baseline:{price:100}});
  now=110;l.ingest(t,{fuente:'binance',candles:[{...c,closed:true}]});assert.equal(l.snapshot().groups[0].closed,0);
  l.ingest(t,{fuente:'consolidado',candles:[{...c,closed:true}]});assert.equal(l.snapshot().groups[0].closed,1);assert.equal(l.snapshot().groups[0].scored,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('cadence includes collection duration and prevents immediate retry loops',()=>{const {nextDelay}=require('../src/close-learning');assert.equal(nextDelay(0,15000),15000);assert.equal(nextDelay(0,0),30000);assert.equal(nextDelay(0,45000),5000);assert.equal(nextDelay(100,50),30000);});
test('unchanged ingest does not rewrite the historical state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'learning-idle-'));
 try{const l=create({root,clock:()=>10}),t={symbol:'ETHUSDT',interval:'1m'},data={fuente:'consolidado',candles:[{openTime:0,closeTime:59999,open:100,high:101,low:99,close:100,closed:false}]};l.ingest(t,data);const file=path.join(root,'state.json');fs.utimesSync(file,new Date(1000000),new Date(1000000));const before=fs.statSync(file).mtimeMs;l.ingest(t,data);assert.equal(fs.statSync(file).mtimeMs,before);assert.equal(JSON.parse(fs.readFileSync(file)).blocks.length,1);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
