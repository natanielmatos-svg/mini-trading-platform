'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {feeBound,reconcile,flatBaseline,pages,create,ruleHash}=require('../src/kalshi-execution-preflight');
const {credentials,create:demo}=require('../src/kalshi-demo-pilot');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const now=100000,accountId='test-account';
const intent={ticker:'T',side:'yes',action:'buy',quantity:1,price:.1,maxFees:.02,expiresAt:now+15000,eventTicker:'E'};
function fixture(){
 const r={orderId:'1',clientId:'c',environment:'demo',intent,filled:1,cost:100000,fees:6300,reserved:120000};
 const o={order_id:'1',client_order_id:'c',ticker:'T',created_time:new Date(now).toISOString(),status:'executed',fill_count_fp:'1.00',remaining_count_fp:'0.00',taker_fill_cost_dollars:'.100000',maker_fill_cost_dollars:'0.000000',taker_fees_dollars:'0.006300',maker_fees_dollars:'0.000000'};
 o.taker_fill_cost_dollars='0.100000';
 return {accountId,baseline:{version:1,accountId,environment:'demo',startedAt:now-1000,balance:50000000},ledger:{orders:[r]},snapshot:{environment:'demo',checkedAt:now,balance:49893700,orders:[o],positions:[{ticker:'T',position_fp:'1.00'}],settlements:[]}};
}
test('precise cash reconciliation covers local losses without counting reserves twice',()=>{
 const r=reconcile(fixture());assert.equal(r.balance,49.8937);assert.equal(r.fees,.0063);assert.equal(r.externalLiability,0);assert.equal(r.realizedLoss,0);assert.equal(r.lossAccounting,'covered_by_gross_reservations');
});
test('expired campaign audit preserves original cash and reservations but cannot authorize execution',()=>{
 const f=fixture(),{auditCampaign}=require('../src/kalshi-execution-preflight');f.snapshot.checkedAt+=86400001;
 const original=JSON.stringify(f),r=auditCampaign(f);assert.equal(r.executable,false);assert.equal(r.baselineExpired,true);assert.equal(r.cashChange,-.1063);assert.equal(JSON.stringify(f),original);assert.throws(()=>reconcile(f),/vencido/);
 f.snapshot.orders=[];assert.throws(()=>auditCampaign(f),/Faltan órdenes/);
});
test('missing, duplicate or external activity never produces a verified account',()=>{
 const changes=[f=>f.snapshot.balance++,f=>f.snapshot.balance+=10000,f=>f.snapshot.orders=[],f=>f.snapshot.orders.push({...f.snapshot.orders[0]}),f=>f.snapshot.orders[0].client_order_id='other',f=>f.snapshot.positions[0].position_fp='2.00',f=>f.snapshot.orders[0].taker_fees_dollars=null,f=>f.baseline.accountId='other',f=>f.snapshot.checkedAt+=86400001];
 // One micro-dollar rounding tolerance is deliberate; a whole cent is not.
 changes.shift();for(const change of changes){const f=fixture();change(f);assert.throws(()=>reconcile(f));}
});
test('settlement credits reconcile once and clear exact holdings; arbitrary transfers fail',()=>{
 const f=fixture();f.snapshot.settlements=[{ticker:'T',settled_time:new Date(now).toISOString(),yes_count_fp:'1.00',no_count_fp:'0.00',revenue_dollars:'1.000000',fee_cost:'0.000000'}];f.snapshot.positions[0].position_fp='0.00';f.snapshot.balance+=1000000;
 assert.equal(reconcile(f).received,1);f.snapshot.settlements.push({...f.snapshot.settlements[0]});assert.throws(()=>reconcile(f),/duplicada/);
});
test('flat baseline rejects open positions or resting orders',()=>{
 const f=fixture();assert.throws(()=>flatBaseline(f.snapshot,accountId));f.snapshot.positions=[];f.snapshot.orders[0].status='resting';assert.throws(()=>flatBaseline(f.snapshot,accountId));
});
test('series fee, event override, scheduled change, unknown type and improved price bounds',()=>{
 const base={intent,series:{ticker:'S',fee_type:'quadratic',fee_multiplier:1},eventChanges:[],seriesChanges:[],now};
 assert.equal(feeBound(base).upperBound,.02);
 assert.equal(feeBound({...base,intent:{...intent,price:.9}}).upperBound,.03);
 assert.equal(feeBound({...base,eventChanges:[{event_ticker:'E',scheduled_ts:new Date(now-1).toISOString(),fee_type_override:'quadratic',fee_multiplier_override:10}]}).upperBound,.08);
 assert.throws(()=>feeBound({...base,series:{...base.series,fee_type:'flat'}}));
 assert.throws(()=>feeBound({...base,seriesChanges:[{series_ticker:'S',scheduled_ts:new Date(now+1000).toISOString()}]}),/Cambio/);
 assert.throws(()=>feeBound({...base,eventChanges:null}));
});
test('paging follows cursors and rejects incomplete or repeated pages',async()=>{
 let calls=0;assert.deepEqual(await pages(async()=>++calls===1?{rows:[1],cursor:'next'}:{rows:[2],cursor:''},'/route','rows'),[1,2]);
 await assert.rejects(pages(async()=>({rows:[],cursor:'same'}),'/route','rows'),/repetido/);
 await assert.rejects(pages(async()=>({}),'/route','rows'),/incompleta/);
});
test('demo never falls back to production credentials or accepts production transport',()=>{
 assert.throws(()=>credentials({KALSHI_API_KEY_ID:'real',KALSHI_PRIVATE_KEY_PATH:'real.pem'}),/Faltan/);
 assert.throws(()=>credentials({KALSHI_API_KEY_ID:'same',KALSHI_DEMO_API_KEY_ID:'same',KALSHI_DEMO_PRIVATE_KEY_PATH:'demo.pem'}),/separadas/);
 assert.throws(()=>demo({transport:{environment:'production'}}),/solo/);
});
test('integrated preflight loads provider account and fee schedules, binds reviewed rules',async()=>{
 const m={ticker:'T',market_type:'binary',exchange_index:0,event_ticker:'E',rules_primary:'Official test rules',status:'active',close_time:new Date(now+60000).toISOString()};
 const routes={'/markets/T':{market:m},'/events/E':{event:{event_ticker:'E',series_ticker:'S'}},'/series/S':{series:{ticker:'S',fee_type:'quadratic',fee_multiplier:1}},'/series/fee_changes?series_ticker=S':{series_fee_change_arr:[]},'/events/fee_changes?event_ticker=E&limit=100':{event_fee_changes:[]},'/exchange/status':{exchange_active:true,trading_active:true},'/portfolio/balance':{balance_dollars:'50.0000'},'/portfolio/positions?exchange_index=0&limit=100':{market_positions:[]},'/portfolio/orders?exchange_index=0&limit=100':{orders:[]},'/portfolio/settlements?exchange_index=0&limit=100':{settlements:[]}};
 routes['/historical/orders?limit=100']={orders:[]};
 const f=create({transport:{environment:'demo',read:async p=>{assert(Object.hasOwn(routes,p),p);return routes[p];}},clock:()=>now,accountId,baseline:()=>({version:1,environment:'demo',accountId,startedAt:now-1000,balance:50000000}),ledger:()=>({orders:[]}),approvedRules:()=>({T:ruleHash(m)})});
 const result=await f(intent);assert(result.complete&&result.rulesVerified&&result.feesVerified);assert.equal(result.feeUpperBound,.02);
 m.exchange_index=2;routes['/portfolio/balance'].balance_breakdown=[{exchange_index:0,balance:'50.0000'},{exchange_index:2,balance:'0.0000'}];
 for(const [r,k] of [['positions','market_positions'],['orders','orders'],['settlements','settlements']])routes['/portfolio/'+r+'?exchange_index=2&limit=100']={[k]:[]};
 const split=await f(intent);assert.equal(split.balance,0);assert.equal(split.accountBalance,50);assert.equal(split.exchangeIndex,2);
 m.exchange_index=0;
 routes['/portfolio/balance']={balance_dollars:'49.0000'};await assert.rejects(f(intent),/Saldo/);
});
test('full demo pilot initializes, reviews, submits through mocks and reconciles cash and fees',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'demo-accounting-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const m={ticker:'T',market_type:'binary',exchange_index:0,event_ticker:'E',rules_primary:'Test rules',status:'active',close_time:new Date(now+60000).toISOString()};
 let order=null,balance='50.0000',writes=0;
 const transport={environment:'demo',read:async route=>{
  if(route==='/markets/T')return {market:m};
  if(route==='/events/E')return {event:{event_ticker:'E',series_ticker:'S'}};
  if(route==='/series/S')return {series:{ticker:'S',fee_type:'quadratic',fee_multiplier:1}};
  if(route.startsWith('/series/fee_changes'))return {series_fee_change_arr:[]};
  if(route.startsWith('/events/fee_changes'))return {event_fee_changes:[]};
  if(route==='/exchange/status')return {exchange_active:true,trading_active:true};
  if(route==='/portfolio/balance')return {balance_dollars:balance};
  if(route.startsWith('/portfolio/orders'))return {orders:order?[order]:[]};
  if(route.startsWith('/historical/orders'))return {orders:[]};
  if(route.startsWith('/portfolio/positions'))return {market_positions:order?[{ticker:'T',position_fp:'1.00'}]:[]};
  if(route.startsWith('/portfolio/settlements'))return {settlements:[]};
  throw Error('Unexpected route');
 },submit:async p=>{
  writes++;order={...fixture().snapshot.orders[0],client_order_id:p.client_order_id,book_side:'bid',yes_price_dollars:'0.1000',initial_count_fp:'1.00'};balance='49.8937';return {order_id:'1',client_order_id:p.client_order_id};
 },get:async()=>order};
 const config={capital:20,maxDailyLossPct:1,maxPerTrade:.2,paused:false};
 const pilot=demo({directory,transport,accountId,config,clock:()=>now});
 await pilot.initialize();await assert.rejects(pilot.initialize());
 assert.equal((await pilot.verify(intent)).rulesVerified,false);
 await assert.rejects(pilot.submit(intent),/verificar/);assert.equal(writes,0);
 await pilot.approveRules('T',(await pilot.inspect('T')).hash);
 assert.equal((await pilot.submit(intent)).state,'executed');assert.equal(writes,1);
 const result=await pilot.verify(intent);assert.equal(result.feesVerified,true);assert.equal(result.balance,49.8937);assert.equal(result.grossSpent,.1063);
 await assert.rejects(pilot.submit(intent),/Presupuesto/);assert.equal(writes,1);
});



test('demo observed YES round trip reconciles complementary sale cost and both fees',()=>{
 const f=fixture(),buy=f.ledger.orders[0],bo=f.snapshot.orders[0];
 buy.cost=50000;buy.fees=3400;buy.intent={...intent,price:.05};
 Object.assign(bo,{taker_fill_cost_dollars:'0.050000',taker_fees_dollars:'0.003400',outcome_side:'yes'});
 f.ledger.orders.push({...buy,orderId:'2',clientId:'s',intent:{...intent,action:'sell',price:.04},cost:40000,fees:2700,reserved:30000});
 f.snapshot.orders.push({...bo,order_id:'2',client_order_id:'s',taker_fill_cost_dollars:'0.960000',taker_fees_dollars:'0.002700',outcome_side:'no'});
 f.snapshot.positions[0].position_fp='0.00';f.snapshot.balance=49983900;
 const r=reconcile(f);assert.equal(r.cashChange,-.0161);assert.equal(r.fees,.0061);assert.equal(r.received,.04);assert.equal(r.positions.T,0);
 f.ledger.orders[1].cost=960000;assert.throws(()=>reconcile(f),/Costes/);
});
test('V2 outcome values normalize YES and NO exits including partial fills',()=>{
 const {fillValue}=require('../src/kalshi-fill-value');
 for(const side of ['yes','no']){
  assert.equal(fillValue(480000,.5,{side,action:'sell'},{outcome_side:side==='yes'?'no':'yes'}),20000);
  assert.equal(fillValue(20000,.5,{side,action:'buy'},{outcome_side:side}),20000);
  assert.throws(()=>fillValue(480000,.5,{side,action:'sell'},{outcome_side:side}));
 }
 assert.throws(()=>fillValue(500001,.5,{side:'yes',action:'sell'},{}));
});
