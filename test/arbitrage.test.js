'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const E=require('../src/arbitrage-engine'),S=require('../src/arbitrage-sources'),{create}=require('../src/arbitrage-scanner');
const now=1800000000000;
const market=(extra={})=>({provider:'polymarket',id:'1',conditionId:'c',outcomes:['Yes','No'],tokens:['10','11'],title:'Will X happen?',rules:'Only official X before date',closeTime:now+600000,currency:'pUSD',fee:{rate:.07,exponent:1,precision:5},minNotional:0,minShares:1,...extra});
const book=(side,price,extra={})=>({market:'1',side,at:now,asks:[{price,quantity:100}],bids:[{price:price-.03,quantity:100}],...extra});
const fixture=()=>({a:market(),b:market(),bookA:book('yes',.4),bookB:book('no',.5),capital:50,now});
test('Polymarket US exige USD, lados negociables y tarifa conocida',()=>{
  const US=require('../src/arbitrage-polymarket-us');
  const raw={id:12,slug:'contract',active:true,closed:false,status:'MARKET_STATUS_OPEN',endDate:new Date(now+1000).toISOString(),feeCoefficient:.0695,minimumTradeQty:1,marketSides:[{id:1,long:true,identifier:'c',tradable:true,quote:{currency:'USD'}},{id:2,long:false,identifier:'c',tradable:true,quote:{currency:'USD'}}]};
  const m=US.normalize(raw);assert.equal(m.provider,'polymarket_us');assert.equal(m.fee.rate,.0695);assert.equal(m.minShares,1);
  assert.equal(US.normalize({...raw,feeCoefficient:undefined}).fee,null);
  assert.equal(US.normalize({...raw,marketType:'combo'}),null);
  assert.equal(US.normalize({...raw,marketSides:raw.marketSides.map(s=>({...s,quote:{currency:'pUSD'}}))}),null);
  const data={marketData:{marketSlug:'contract',state:'MARKET_STATE_OPEN',bids:[{px:{value:'.4',currency:'USD'},qty:7}],offers:[{px:{value:'.6',currency:'USD'},qty:3}]}};
  const no=US.parseBook(data,m,'no',now);assert.deepEqual(no.asks,[{price:.6,quantity:7}]);assert.deepEqual(no.bids,[{price:.4,quantity:3}]);assert.equal(no.timestampKind,'request-start');
  assert.throws(()=>US.parseBook({...data,marketData:{...data.marketData,marketSlug:'other'}},m,'yes',now));
  assert.throws(()=>US.parseBook({...data,marketData:{...data.marketData,state:'MARKET_STATE_CLOSED'}},m,'yes',now));
});
test('mismo título no certifica equivalencia entre plataformas',()=>{
  const a=market({provider:'kalshi'}),b=market();assert.equal(E.equivalence(a,b).ok,false);
  const r=E.evaluate({...fixture(),a});assert.equal(r.net,null);assert.equal(r.qualified,false);
});
test('certificado exige reglas inmutables, semántica, vencimiento y moneda',()=>{
  const a=market({provider:'kalshi'}),b=market();
  const semantics=Object.fromEntries(['event','observationTime','referenceSource','predicate','cancellation','disputeTreatment','payout'].map(k=>[k,'verified '+k]));
  const c={a:'kalshi:1',b:'polymarket:1',hashA:E.fingerprint(a),hashB:E.fingerprint(b),expiresAt:now+1000,reviewedBy:'test',semanticsA:semantics,semanticsB:semantics};
  assert.equal(E.equivalence(a,b,[c],now).ok,true);
  assert.equal(E.equivalence({...a,rules:'changed'},b,[c],now).ok,false);
  assert.equal(E.equivalence(a,b,[c],now+1000).ok,false);
  assert.equal(E.equivalence(a,{...b,currency:'USD'},[c],now).ok,false);
});
test('margen usa profundidad, comisiones y presupuesto, no último precio',()=>{
  const input=fixture(),r=E.evaluate(input);assert.ok(r.qualified);assert.equal(r.quantity,25);assert.ok(r.net<r.gross);assert.ok(r.cost<=50);assert.equal(r.liveEnabled,false);
  assert.equal(E.evaluate({...input,capital:0}).qualified,false);
  assert.equal(E.evaluate({...input,bookB:book('no',.61)}).qualified,false);
  assert.equal(E.evaluate({...input,bookA:book('yes',.4,{asks:[]})}).qualified,false);
  assert.equal(E.evaluate({...input,a:market({fee:null})}).net,null);
});
test('libro ajeno, viejo o desincronizado jamás califica',()=>{
  const x=fixture();for(const bookA of [book('yes',.4,{market:'other'}),book('no',.4),book('yes',.4,{at:now-11000}),book('yes',.4,{at:now-4000}),book('yes',.4,{at:now+1})])assert.equal(E.evaluate({...x,bookA}).qualified,false);
});
test('cambiar condición o tokens invalida la supuesta cobertura del mismo contrato',()=>{
  const x=fixture();assert.equal(E.evaluate({...x,b:market({conditionId:'other'})}).qualified,false);
  assert.equal(E.evaluate({...x,b:market({tokens:['12','13']})}).qualified,false);
  const plan=E.evaluate(x);assert.equal(E.simulate(plan,x.a,x.b,{...x.bookA,market:'other'},x.bookB,now).state,'cancelled');
});
test('barrido ordena niveles y respeta precio límite',()=>{
  const r=E.sweep([{price:.5,quantity:2},{price:.4,quantity:3}],5,'buy',.45);assert.equal(r.quantity,3);assert.ok(Math.abs(r.cash-1.2)<1e-10);
});
test('fallo de segunda compra puede producir pérdidas y exposición residual',()=>{
  const x=fixture(),plan=E.evaluate(x);
  const r=E.simulate(plan,x.a,x.b,x.bookA,{...x.bookB,asks:[]},now);
  assert.ok(r.worstNet<0);assert.equal(r.realizedProfit,null);assert.equal(r.residual,0);
  const missing=E.simulate(plan,x.a,x.b,{...x.bookA,bids:[]},{...x.bookB,asks:[]},now);
  assert.equal(missing.state,'unhedged');assert.equal(missing.residual,plan.quantity);assert.ok(missing.worstNet<r.worstNet);
});
test('ejecución parcial conserva sólo cantidad cubierta y liquida excedente',()=>{
  const x=fixture(),p=E.evaluate(x),r=E.simulate(p,x.a,x.b,x.bookA,book('no',.5,{asks:[{price:.5,quantity:3}]}),now);
  assert.equal(r.state,'partial');assert.equal(r.covered,3);assert.equal(r.filledA,p.quantity);assert.equal(r.filledB,3);assert.equal(r.residual,0);
});
test('normalización no asume tarifa gratuita ni acepta otro token',()=>{
  const raw={active:true,closed:false,acceptingOrders:true,enableOrderBook:true,id:1,conditionId:'c',outcomes:'["Yes","No"]',clobTokenIds:'["10","11"]',endDate:new Date(now+1000).toISOString(),orderMinSize:5};
  assert.equal(S.polyMarket(raw).fee,null);
  assert.equal(S.polyMarket({...raw,feesEnabled:false}).fee.rate,0);
  assert.equal(S.polyMarket({...raw,feesEnabled:true,feeSchedule:{rate:.1,exponent:2}}).fee,null);
  assert.throws(()=>S.polyBook({asset_id:'bad',market:'c',timestamp:now,asks:[],bids:[]},market(),'yes',now,now));
});
test('escáner persiste simulaciones y fallos sin órdenes ni presupuesto real',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arb-'));let reads=0;
  const m=market();
  const adapters={catalog:async p=>({markets:p==='polymarket'?[m]:[],at:now,scope:'fixture'}),eligibility:async()=>({internationalBlocked:true}),book:async(m,side)=>{reads++;return book(side,side==='yes'?.4:.5);}};
  try{
    const scanner=create({root,provider:'polymarket',clock:()=>now,delay:async()=>{},capital:()=>50,adapters});
    const r=await scanner.scan();assert.equal(r.projectedOpportunities,1);assert.equal(reads,4);assert.equal(r.results[0].simulation.state,'covered');assert.ok(r.results[0].singleLegStress.worstNet<0);
    assert.equal(r.realRiskBudgetUSD,0);assert.equal(r.liveEnabled,false);assert.equal(r.realizedProfit,null);assert.equal(r.eligibility.internationalBlocked,true);
    const restored=create({root,provider:'polymarket',clock:()=>now+180000});assert.equal(restored.snapshot().stale,true);
    assert.ok(fs.existsSync(path.join(root,'latest.json')));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
