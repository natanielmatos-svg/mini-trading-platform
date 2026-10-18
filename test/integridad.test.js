'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEvent } = require('../src/providers/base');
const { analyzeCluster, analyzeEvents, findArbitrage } = require('../src/analyze');
const { loadDemoEvents } = require('../src/api');
const { consolidate } = require('../src/consolidated');

test('una opción sin precio no crea arbitraje ni redistribuye su probabilidad', () => {
  const event = buildEvent({ platform: 'test', id: 'partial', mutuallyExclusive: true,
    options: [{label:'Alpha', bid:.19, ask:.21}, {label:'Beta', bid:.29, ask:.31}, {label:'Gamma'}] });
  assert.equal(event.optionsComplete, false);
  assert.equal(event.missingOptionCount, 1);
  assert.equal(event.options[0].impliedProb, .2);
  const result = analyzeCluster({anchor:event, events:[event], matchScore:1});
  assert.equal(result.arbitrage, null);
  assert.equal(result.consensusOverround, null);
  assert.equal(result.verdict.decisive, false);
  assert.ok(result.flags.some(f => f.code === 'incomplete_options'));
  assert.ok(result.options.every(o => o.bestPrice.edge === null));
});

test('el margen usa exactamente la probabilidad final publicada', () => {
  for (const event of analyzeEvents(loadDemoEvents().events)) {
    for (const option of event.options) {
      if (option.bestPrice) assert.equal(option.bestPrice.edge, option.probability - option.bestPrice.ask);
    }
  }
});

test('el arbitraje requiere cobertura explícita y precios válidos', () => {
  const options = [.2,.3].map(ask => ({bestPrice:{ask}}));
  assert.equal(findArbitrage(options, true), null);
  assert.ok(findArbitrage(options, true, true));
  for (const ask of [0,-1,1,Infinity,NaN]) {
    assert.equal(findArbitrage([{bestPrice:{ask}}, options[1]], true, true), null);
  }
});

test('USDT sin cambio queda fuera de la mediana y de las diferencias en dólares', () => {
  const quotes = [{id:'a',quote:'USDT',price:90,converted:false}, {id:'b',quote:'USD',price:100}];
  const result = consolidate(quotes);
  assert.equal(result.price,100);
  assert.equal(result.used,1);
  assert.equal(result.venues[0].diff,null);
  assert.equal(result.venues[0].excludedReason,'sin conversión a USD');
  assert.equal(consolidate([quotes[0]]).price,null);
  assert.equal(consolidate([{...quotes[0],converted:true},quotes[1]]).price,95);
});
