'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {create,payload,fingerprint}=require('../src/kalshi-executor');
const {create:createTransport}=require('../src/kalshi-order-transport');
const now=100000,id='12345678-1234-1234-1234-123456789abc';
const intent={ticker:'TEST',side:'yes',action:'buy',quantity:1,price:.1,maxFees:.01,expiresAt:now+10000};
function fixture(t,options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kalshi-executor-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let sends=0;
 const order={order_id:'order-1',client_order_id:id,ticker:'TEST',book_side:'bid',yes_price_dollars:'0.1000',status:'executed',fill_count_fp:'1.00',remaining_count_fp:'0.00',initial_count_fp:'1.00',taker_fill_cost_dollars:'0.1000',maker_fill_cost_dollars:'0.0000',taker_fees_dollars:'0.0100',maker_fees_dollars:'0.0000'};
 const transport={environment:'demo',submit:async()=>{sends++;return {order_id:'order-1',client_order_id:id};},get:async()=>order,find:async()=>order,cancel:async()=>({})};
 const deps={directory,transport,enabled:true,clock:()=>now,settings:()=>({capital:20,maxDailyLossPct:1,maxPerTrade:.2,paused:false}),preflight:async()=>({complete:true,checkedAt:now,ticker:'TEST',marketActive:true,closeTime:now+90000,feesVerified:true,rulesVerified:true,feeUpperBound:.01,externalLiability:0,realizedLoss:0,balance:50,heldQuantity:1}),...options};
 const send=(e,p=intent,key=id)=>e.submit(p,{clientId:key,confirmedFingerprint:fingerprint(p)});
 return {executor:create(deps),deps,order,transport,send,sends:()=>sends};
}
test('V2 maps YES/NO purchases and reduce-only exits without reversing price',()=>{
 for(const [side,action,book,price] of [['yes','buy','bid','0.1000'],['no','buy','ask','0.9000'],['yes','sell','ask','0.1000'],['no','sell','bid','0.9000']]){
  const p=payload({...intent,side,action},id);assert.equal(p.side,book);assert.equal(p.price,price);assert.equal(p.reduce_only,action==='sell');assert.equal(p.time_in_force,'immediate_or_cancel');
 }
});
test('defaults disabled and exact confirmation required',async t=>{
 const f=fixture(t,{enabled:false});await assert.rejects(f.send(f.executor),/desactivado/);assert.equal(f.sends(),0);
 await assert.rejects(create({...f.deps,enabled:true}).submit(intent,{clientId:id,confirmedFingerprint:'changed'}),/confirmación/);
});
test('persists before send and prevents duplicate submission after restart',async t=>{
 const f=fixture(t);const original=f.transport.submit;f.transport.submit=async body=>{assert.equal(f.executor.snapshot().orders[0].state,'pending');return original(body);};
 assert.equal((await f.send(f.executor)).state,'executed');
 assert.equal((await f.send(create(f.deps))).state,'executed');assert.equal(f.sends(),1);
 await assert.rejects(f.send(f.executor,{...intent,price:.11}),/reutilizado/);
});
test('timeout never retries; unresolved order blocks another ID and retains reserve',async t=>{
 const f=fixture(t);let calls=0;f.transport.submit=async()=>{calls++;throw Error('timeout');};
 const r=await f.send(f.executor);assert.equal(r.state,'unknown');assert.equal(r.reserved,110000);
 await f.send(create(f.deps));assert.equal(calls,1);
 await assert.rejects(f.send(f.executor,intent,crypto.randomUUID()),/Reconciliación/);
 f.transport.find=async()=>null;assert.equal((await f.executor.reconcile(id)).state,'unknown');
 f.transport.find=async()=>f.order;assert.equal((await f.executor.reconcile(id)).state,'executed');assert.equal(calls,1);
});
test('submission diagnostics retain status and safe code without secrets or automatic retry',async t=>{
 const f=fixture(t);f.transport.submit=async()=>{throw Object.assign(Error('secret provider body'),{httpStatus:403,providerCode:'insufficient_permissions',body:'secret'});};
 const r=await f.send(f.executor);assert.equal(r.submissionFailure.httpStatus,403);assert.equal(r.submissionFailure.providerCode,'insufficient_permissions');assert(!JSON.stringify(r).includes('secret'));assert.equal(r.state,'unknown');
 await assert.rejects(f.send(f.executor,intent,crypto.randomUUID()),/Reconciliación/);
});
test('demo audit only resolves absence after close across every shard, retaining full reserve',async t=>{
 const f=fixture(t,{clock:()=>now+100000});
 // Create an unresolved attempt using the original clock.
 f.transport.submit=async()=>{throw Error('timeout');};await f.send(create({...f.deps,clock:()=>now}));
 f.transport.read=async route=>{
  if(route.startsWith('/markets/'))return {market:{ticker:'TEST',status:'closed',close_time:new Date(now).toISOString()}};
  if(route==='/portfolio/balance')return {balance_dollars:'50.0000',balance_breakdown:[{exchange_index:0,balance:'50.0000'},{exchange_index:2,balance:'0.0000'}]};
  if(route.includes('/orders'))return {orders:[]};if(route.includes('/positions'))return {market_positions:[]};if(route.includes('/settlements'))return {settlements:[]};if(route.includes('/fills'))return {fills:[]};throw Error('route');
 };
 await assert.rejects(create({...f.deps,clock:()=>now}).auditUnconfirmedDemo(id,50000000),/Esperar/);
 const r=await f.executor.auditUnconfirmedDemo(id,50000000);assert.equal(r.state,'absent_after_close');assert.equal(r.reserved,110000);
 assert.equal((await f.send(f.executor)).state,'absent_after_close');
});
test('aggregate exposure survives restart and midnight; no budget reuse after fills',async t=>{
 const f=fixture(t);await f.send(f.executor);
 await assert.rejects(f.send(create(f.deps),intent,crypto.randomUUID()),/Presupuesto/);
 const later=create({...f.deps,clock:()=>now+86400000,preflight:async()=>({...await f.deps.preflight(),checkedAt:now+86400000,closeTime:now+86490000})});
 await assert.rejects(f.send(later,{...intent,expiresAt:now+86410000},crypto.randomUUID()),/Presupuesto/);
});
test('preflight rejects stale, incomplete, fee mismatch, external risk, pause and expired intent',async t=>{
 const f=fixture(t);
 for(const change of [{complete:false},{checkedAt:now+1},{checkedAt:now-6000},{feeUpperBound:.02},{feesVerified:false},{rulesVerified:false},{externalLiability:.1},{realizedLoss:.1},{balance:0},{balance:null},{marketActive:false},{closeTime:now}]){
  const e=create({...f.deps,preflight:async()=>({...await f.deps.preflight(),...change})});await assert.rejects(f.send(e));
 }
 await assert.rejects(f.send(create({...f.deps,settings:()=>({...f.deps.settings(),paused:true})})),/pausa/);
 await assert.rejects(f.send(f.executor,{...intent,expiresAt:now}),/vencida/);assert.equal(f.sends(),0);
});
test('cancel with partial fill retains exposure; cancel without fill releases reservation',async t=>{
 const f=fixture(t);Object.assign(f.order,{status:'resting',fill_count_fp:'0.50',remaining_count_fp:'0.50',taker_fill_cost_dollars:'0.0500'});
 const r=await f.send(f.executor);assert.equal(r.filled,.5);assert.equal(r.state,'resting');
 f.transport.cancel=async()=>{Object.assign(f.order,{status:'canceled',remaining_count_fp:'0.00'});};
 const canceled=await f.executor.cancel(id);assert.equal(canceled.state,'canceled');assert.equal(canceled.reserved,110000);
 const g=fixture(t);Object.assign(g.order,{status:'canceled',fill_count_fp:'0.00',taker_fill_cost_dollars:'0.0000',taker_fees_dollars:'0.0000'});
 assert.equal((await g.send(g.executor)).reserved,0);
});
test('wrong order identity, absent costs or excessive fees keep state unknown',async t=>{
 for(const change of [{ticker:'OTHER'},{book_side:'ask'},{yes_price_dollars:'.9000'},{client_order_id:'wrong'},{taker_fees_dollars:undefined},{taker_fees_dollars:'0.0200'},{fill_count_fp:'2.00'},{status:'executed',fill_count_fp:'0.00'}]){
  const f=fixture(t);Object.assign(f.order,change);const r=await f.send(f.executor);assert.equal(r.state,'unknown');assert.equal(r.reserved,110000);
 }
});
test('lock prevents simultaneous instances; leftover lock and corrupt ledger fail closed',async t=>{
 const f=fixture(t);let release;f.transport.submit=()=>new Promise(resolve=>{release=()=>resolve({order_id:'order-1',client_order_id:id});});
 const pending=f.send(f.executor);await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.send(create(f.deps)),/ocupado/);release();await pending;
 fs.writeFileSync(path.join(f.deps.directory,'executor.lock'),'');await assert.rejects(f.send(create(f.deps)),/ocupado/);
 fs.unlinkSync(path.join(f.deps.directory,'executor.lock'));fs.writeFileSync(path.join(f.deps.directory,'orders.json'),'{broken');await assert.rejects(f.send(f.executor),/ilegible/);
});
test('exit requires verified holdings and uses reduce_only; pause permits a reduction',async t=>{
 const f=fixture(t);const e=create({...f.deps,preflight:async()=>({...await f.deps.preflight(),heldQuantity:0})});
 await assert.rejects(f.send(e,{...intent,action:'sell'}),/posición/);
 Object.assign(f.order,{book_side:'ask'});
 assert.equal((await f.send(create({...f.deps,settings:()=>({...f.deps.settings(),paused:true})}),{...intent,action:'sell'})).state,'executed');
});
test('pause during preflight and using a demo ledger in production fail closed',async t=>{
 const f=fixture(t);let paused=false;
 const e=create({...f.deps,settings:()=>({...f.deps.settings(),paused}),preflight:async()=>{paused=true;return f.deps.preflight();}});
 await assert.rejects(f.send(e),/pausa/);assert.equal(f.sends(),0);
 await f.send(f.executor);
 assert.throws(()=>create({...f.deps,transport:{...f.transport,environment:'production'}}).snapshot(),/Registro/);
});
test('signed HTTP adapter signs actual verb and path, disables redirects and never retries',async()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});let calls=0;
 const transport=createTransport({keyId:'test-only',privateKey,allowWrites:true,role:'bot',clock:()=>now,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url.origin,'https://demo-api.kalshi.co');assert.equal(options.redirect,'error');
  assert(crypto.verify('sha256',Buffer.from(String(now)+options.method+url.pathname),{key:publicKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST},Buffer.from(options.headers['KALSHI-ACCESS-SIGNATURE'],'base64')));
  return {ok:false,status:503};
 }});
 await assert.rejects(transport.submit(payload(intent,id)),/503/);assert.equal(calls,1);
 await assert.rejects(transport.cancel('order-1','TEST'),/503/);assert.equal(calls,2);
 await assert.rejects(createTransport({fetchImpl:()=>{throw Error('must not fetch');}}).submit({}),/desactivado/);
});
test('demo funding is bounded, uses centicents and cannot target production',async()=>{
 assert.throws(()=>createTransport({environment:'production'}).fundDemoShard({destination:2,amountUSD:1}),/demo/);
 const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});let sent;
 const t=createTransport({environment:'demo',keyId:'test',privateKey,allowWrites:true,role:'bot',fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);assert.equal(url.hostname,'demo-api.kalshi.co');return {ok:true,json:async()=>({transfer_id:'test'})};}});
 assert.throws(()=>t.fundDemoShard({destination:2,amountUSD:2}),/demo/);
 await t.fundDemoShard({destination:2,amountUSD:1});assert.equal(sent.amount,10000);assert.equal(sent.destination_exchange_shard,2);
});
test('single-order reconciliation explicitly selects the market shard',async()=>{
 const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const urls=[];
 const t=createTransport({environment:'demo',keyId:'test',privateKey,fetchImpl:async url=>{urls.push(url.pathname+url.search);return {ok:true,json:async()=>url.pathname.includes('/markets/')?{market:{exchange_index:2}}:{order:{order_id:'1'}}};}});
 assert.equal((await t.get('1','TEST')).order_id,'1');assert.equal(urls[1],'/trade-api/v2/portfolio/orders/1?exchange_index=2');
});
