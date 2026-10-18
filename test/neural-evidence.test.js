'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {record}=require('../src/neural-evidence');
test('evaluación neuronal conserva primera predicción y sólo resuelve cierre exacto de misma fuente',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neural-'));const file=path.join(dir,'evidence.json');
 const data={symbol:'BTCUSDT',interval:'1m',fuente:'consolidado',candles:[]};
 const forecast={ok:true,generatedAt:100,closesAt:1000,estimatedClose:110,baseline:{price:100}};
 try{
  record(forecast,data,{file,now:100});record({...forecast,estimatedClose:105},data,{file,now:200});
  const candles=[{closeTime:999,close:108,closed:true}];
  assert.equal(record({ok:false},{...data,fuente:'binance',candles},{file,now:1100}).samples,0);
  assert.equal(record({ok:false},{...data,candles:[{...candles[0],closed:false}]},{file,now:1100}).samples,0);
  const result=record({ok:false},{...data,candles},{file,now:1100});assert.equal(result.samples,1);assert.equal(result.mae,2);assert.equal(result.baselineMae,8);
  assert.equal(JSON.parse(fs.readFileSync(file))[0].predicted,110);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
