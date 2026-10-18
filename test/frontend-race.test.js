'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(file) {
  const pending = [];
  const elements = new Map();
  const noop = () => {};
  const context = vm.createContext({
    Format: {}, Chart: {}, Ruptura: {}, TablaMtf: {},
    PrecioVivo: {crear: () => ({reiniciar:noop})},
    Avisos: {crearAvisos: () => ({evaluar:noop, olvidarPrimera:noop, renderHint:noop})},
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id,{value:'',getContext:()=>({})});
      return elements.get(id);
    }},
    request: url => new Promise((resolve,reject) => pending.push({url,resolve,reject})),
  });
  const stocks = file === 'acciones.js';
  const source = fs.readFileSync(path.join(__dirname,'../public',file),'utf8').replace(
    "document.addEventListener('DOMContentLoaded', init);",
    `getJson = request; render = () => {}; setStatus = () => {}; recuperarNivel = () => {}; loadForecast = () => {};
     ${stocks ? 'programarVelas = () => {}; renderAviso = () => {}; loadPrecio = () => {};' : 'scheduleRefresh = () => {}; connectStream = () => {}; loadConsolidado = () => {};'}
     globalThis.api = {state, loadAll, loadBreakout, select(symbol, interval) {
       el.symbolSelect.value = symbol; el.interval.value = interval; applyControls();
     }};`
  );
  vm.runInContext(source,context);
  return {api:context.api,pending};
}

for (const file of ['app.js','acciones.js']) {
  test(`${file}: la respuesta antigua no contamina la nueva selección`, async () => {
    const {api,pending} = harness(file);
    const old = api.loadAll();
    const oldRequests = pending.splice(0);
    api.select('NEW','5m');
    const newRequests = pending.splice(0);
    assert.equal(newRequests.length,5);
    for (const req of oldRequests) req.resolve({candles:[{close:1}],source:'old'});
    await old;
    assert.equal(api.state.candles.length,0);
    assert.equal(api.state.loading,true,'la carga antigua no libera la nueva');
    for (const req of newRequests) req.resolve({candles:[{close:2}],source:'new'});
    await flush();
    assert.equal(pending.length,1);
    pending.shift().resolve({symbol:'NEW',interval:'5m',price:2});
    await flush();
    assert.equal(api.state.candles[0].close,2);
    assert.equal(api.state.breakout.price,2);
    assert.equal(api.state.loading,false);
  });

  test(`${file}: una ruptura antigua se descarta incluso al volver al mismo par`, async () => {
    const {api,pending} = harness(file);
    const original = api.state.symbol;
    const old = api.loadBreakout();
    const request = pending.shift();
    api.select('OTHER','5m');
    api.select(original,'1h');
    request.resolve({symbol:original,interval:'1h',price:999});
    await old;
    assert.equal(api.state.breakout,null);
  });
}

test('consolidado: consulta lenta no se invalida por el siguiente tick y se recupera tras error', async () => {
  const pending=[];
  const noop=()=>{};
  const context=vm.createContext({Format:{},Chart:{},Ruptura:{},TablaMtf:{},PrecioVivo:{crear:()=>({reiniciar:noop})},Avisos:{crearAvisos:()=>({})},document:{getElementById:()=>({getContext:()=>({})})},request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').replace("document.addEventListener('DOMContentLoaded', init);",`getJson=request; renderClock=()=>{}; renderBreakout=()=>{}; renderProbabilidad=()=>{}; globalThis.api={state,loadConsolidado};`);
  vm.runInContext(source,context);
  const {api}=context;const first=api.loadConsolidado();await api.loadConsolidado();assert.equal(pending.length,1);
  pending.shift().resolve({symbol:api.state.symbol,price:100,venues:[{id:'binance',usable:true,price:100}]});await first;
  assert.equal(api.state.consolidado.price,100);assert.equal(api.state.cargandoPrecio,false);
  const failed=api.loadConsolidado();pending.shift().reject(Error('timeout'));await failed;assert.equal(api.state.cargandoPrecio,false);
  const retry=api.loadConsolidado();pending.shift().resolve({symbol:api.state.symbol,price:101,venues:[{id:'binance',usable:true,price:101}]});await retry;assert.equal(api.state.consolidado.price,101);
});
