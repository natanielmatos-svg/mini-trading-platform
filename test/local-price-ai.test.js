'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {propose}=require('../src/local-price-ai');
function block(i){const opensAt=i*1000;return {group:'btc15',opensAt,closesAt:opensAt+1000,resolvedAt:opensAt+1001,actual:102,observations:[{at:opensAt+100,price:100,open:100,high:101,low:99,basisPct:.1}]};}
test('modelo local aprende retorno con bloques previos y no consume cierres futuros ni otras fuentes',()=>{
 const history=Array.from({length:35},(_,i)=>block(i));const current=block(40),o=current.observations[0];current.actual=null;
 const p=propose(current,o,history);assert.ok(p);assert.equal(p.trainingSamples,35);assert.ok(Math.abs(p.price-102)<.001);assert.equal(p.active,false);
 const polluted=[...history,{...block(50),actual:10000},{...block(2),group:'other',actual:10000},{...block(3),resolvedAt:o.at,actual:10000}];
 assert.deepEqual(propose(current,o,polluted),p);
 assert.equal(propose(current,o,history.slice(0,29)),null);
});
test('fases y variables no usan observaciones posteriores y comparador neuronal debe existir a tiempo',()=>{
 const history=Array.from({length:35},(_,i)=>block(i)),current=block(40),o=current.observations[0];
 const p=propose(current,o,history);current.observations.push({...o,at:o.at+50,price:99999});current.prediction={at:o.at+1,raw:999};
 assert.deepEqual(propose(current,o,history),p);
 assert.equal(propose(current,{...o,at:current.closesAt},history),null);
 assert.equal(propose(current,{...o,at:current.opensAt+600},history),null);
});
