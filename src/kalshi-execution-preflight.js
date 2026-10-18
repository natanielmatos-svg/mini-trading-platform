'use strict';
const {fillValue}=require('./kalshi-fill-value');
const crypto=require('node:crypto');
const decimal=v=>{
 if(!((typeof v==='string'&&/^-?\d+(\.\d{1,6})?$/.test(v))||(typeof v==='number'&&Number.isFinite(v))))throw Error('Dato monetario ausente o inválido');
 const n=Number(v),u=Math.round(n*1e6);if(!Number.isSafeInteger(u)||Math.abs(n*1e6-u)>1e-5)throw Error('Precisión monetaria inválida');return u;
};
const positive=v=>{const u=decimal(v);if(u<0)throw Error('Importe negativo');return u;};
const money=(r,d,c)=>r[d]!==undefined?decimal(r[d]):decimal(r[c])/100;
async function pages(read,route,key){
 const rows=[],seen=new Set();let cursor='';
 for(let i=0;i<100;i++){
  const r=await read(route+(route.includes('?')?'&':'?')+'limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(!Array.isArray(r[key]))throw Error('Consulta incompleta: '+key);rows.push(...r[key]);
  if(!r.cursor)return rows;if(seen.has(r.cursor))throw Error('Cursor repetido');seen.add(r.cursor);cursor=r.cursor;
 }throw Error('Límite de paginación');
}
function ruleHash(m){return crypto.createHash('sha256').update(JSON.stringify([m.ticker,m.rules_primary,m.rules_secondary||'',m.close_time,m.strike_type,m.floor_strike,m.cap_strike])).digest('hex');}
// IOC taker upper bound across every possible improved execution price. It is not an exact fee quote.
function feeBound({intent,series,eventChanges,seriesChanges,now}){
 const feePolicy=require('./kalshi-fee-policy').assertCurrent(now);
 if(!Array.isArray(eventChanges)||!Array.isArray(seriesChanges))throw Error('Calendario de tarifas incompleto');
 let type=series.fee_type,multiplier=series.fee_multiplier;
 const relevant=eventChanges.filter(c=>c.event_ticker===intent.eventTicker);
 for(const c of [...relevant,...seriesChanges.filter(c=>c.series_ticker===series.ticker)]){
  const t=Date.parse(c.scheduled_ts);if(!Number.isFinite(t))throw Error('Fecha de tarifa inválida');
  if(t>now&&t<=intent.expiresAt+8000)throw Error('Cambio de tarifa durante la orden');
 }
 const historical=relevant.filter(c=>Date.parse(c.scheduled_ts)<=now).sort((a,b)=>Date.parse(b.scheduled_ts)-Date.parse(a.scheduled_ts));
 if(historical.length){const c=historical[0];if(c.fee_type_override!==null)type=c.fee_type_override;if(c.fee_multiplier_override!==null)multiplier=c.fee_multiplier_override;}
 if(!['quadratic','quadratic_with_maker_fees'].includes(type)||typeof multiplier!=='number'||!Number.isFinite(multiplier)||multiplier<0||multiplier>100)throw Error('Tarifa no soportada');
 // Include micro-dollar rounding per possible 0.01-contract fill plus a full cent buffer.
 const worstP=intent.action==='buy'?Math.min(.5,intent.price):Math.max(.5,intent.price);
 const raw=feePolicy.takerCoefficient*multiplier*intent.quantity*worstP*(1-worstP);
 return {upperBound:Math.ceil((raw+intent.quantity*.0001+.01)*100-1e-9)/100,type,multiplier,source:'series + events/fee_changes',checkedAt:now,policyVersion:feePolicy.version,reviewBy:feePolicy.reviewBy};
}
async function snapshot(transport,clock=Date.now){
 const start=clock(),read=transport.read;
 const before=await read('/portfolio/balance');
 const breakdown=before.balance_breakdown;
 const shards=Array.isArray(breakdown)?breakdown.map(b=>b.exchange_index):[0];
 if(!shards.length||new Set(shards).size!==shards.length||shards.some(s=>!Number.isInteger(s)||s<0))throw Error('Secciones de saldo no verificables');
 const [positions,liveOrders,settlements]=await Promise.all([
  ...[['positions','market_positions'],['orders','orders'],['settlements','settlements']].map(async([route,key])=>(await Promise.all(shards.map(shard=>pages(read,'/portfolio/'+route+'?exchange_index='+shard,key)))).flat())
 ]);
 // Live first, archive second: a finalized order can move between reads.
 const archivedOrders=await pages(read,'/historical/orders','orders');
 const orders=mergeOrders(liveOrders,archivedOrders);
 const after=await read('/portfolio/balance');
 const balance=money(after,'balance_dollars','balance');
 if(balance<0||balance!==money(before,'balance_dollars','balance')||clock()-start>5000)throw Error('Cuenta cambió o consulta demasiado lenta');
 if(JSON.stringify(before.balance_breakdown)!==JSON.stringify(after.balance_breakdown))throw Error('Saldo de sección cambió durante consulta');
 return {environment:transport.environment,checkedAt:start,balance,positions,orders,settlements,orderHistory:{live:liveOrders.length,archived:archivedOrders.length,complete:true},shardBalances:Array.isArray(breakdown)?Object.fromEntries(breakdown.map(b=>[b.exchange_index,positive(b.balance)/1e6])):{0:balance/1e6}};
}
function mergeOrders(live,archived){
 const rows=new Map();const fields=['client_order_id','ticker','status','fill_count_fp','remaining_count_fp','taker_fill_cost_dollars','maker_fill_cost_dollars','taker_fees_dollars','maker_fees_dollars','created_time','side','action','outcome_side','book_side','exchange_index','subaccount_number'];
 for(const batch of [live,archived]){const seen=new Set();for(const row of batch){if(!row.order_id||seen.has(row.order_id))throw Error('Órdenes duplicadas o sin ID');seen.add(row.order_id);const old=rows.get(row.order_id);if(old&&fields.some(k=>old[k]!==row[k]))throw Error('Histórico y órdenes recientes discrepan; volver a consultar');if(!old)rows.set(row.order_id,row);}}
 return [...rows.values()];
}
function flatBaseline(s,accountId){
 if(s.positions.some(p=>decimal(p.position_fp)!==0)||s.orders.some(o=>o.status==='resting'))throw Error('El piloto requiere cuenta sin posiciones ni órdenes abiertas');
 return {environment:s.environment,accountId,startedAt:s.checkedAt,balance:s.balance,version:1};
}
// Isolated pilot accounting. Reject external activity rather than guess its cost basis.
function reconcileCore({snapshot:s,baseline,ledger,accountId},auditOnly=false){
 if(!baseline||baseline.version!==1||baseline.environment!==s.environment||baseline.accountId!==accountId||!Number.isSafeInteger(baseline.balance)||!Number.isFinite(baseline.startedAt)||baseline.startedAt>s.checkedAt)throw Error('Falta inicio contable válido para esta cuenta');
 if(!auditOnly&&s.checkedAt-baseline.startedAt>86400000)throw Error('Piloto contable vencido; reconciliar antes de ampliar');
 const known=new Map(ledger.orders.map(r=>[r.orderId,r])),positions=new Map();let cash=baseline.balance,fees=0,spent=0,received=0;
 const seen=new Set(),found=new Set();
 for(const o of s.orders){
  if(!o.order_id||seen.has(o.order_id))throw Error('Órdenes duplicadas o sin ID');seen.add(o.order_id);
  const r=known.get(o.order_id),created=Date.parse(o.created_time);
  if(!Number.isFinite(created))throw Error('Orden sin fecha');
  if(!r){if(created>=baseline.startedAt||o.status==='resting')throw Error('Actividad ajena al piloto: reconciliación manual requerida');continue;}
  if(created<baseline.startedAt||r.environment!==s.environment||o.client_order_id!==r.clientId||o.ticker!==r.intent.ticker||!['executed','canceled'].includes(o.status))throw Error('Orden local sin reconciliar');
  const fill=decimal(o.fill_count_fp)/1e6,remaining=decimal(o.remaining_count_fp)/1e6;
  if(fill<0||fill>r.intent.quantity||remaining!==0||fill!==r.filled)throw Error('Ejecuciones no coinciden con registro');
  const cost=fillValue(positive(o.taker_fill_cost_dollars)+positive(o.maker_fill_cost_dollars),fill,r.intent,o),fee=positive(o.taker_fees_dollars)+positive(o.maker_fees_dollars);
  if(cost!==r.cost||fee!==r.fees||(r.intent.action==='buy'?cost+fee:fee)>r.reserved)throw Error('Costes no coinciden con reserva');
  found.add(o.order_id);fees+=fee;
  if(r.intent.action==='buy'){cash-=cost+fee;spent+=cost+fee;}else{cash+=cost-fee;received+=cost;spent+=fee;}
  const signed=(r.intent.side==='yes'?1:-1)*(r.intent.action==='buy'?1:-1)*fill;
  positions.set(o.ticker,(positions.get(o.ticker)||0)+signed);
 }
 if(ledger.orders.some(r=>!found.has(r.orderId)&&!(s.environment==='demo'&&r.state==='absent_after_close'&&r.audit?.reservationRetained===true&&r.audit?.allShardsChecked===true)))throw Error('Faltan órdenes locales en el histórico reciente');
 const settled=new Set();
 for(const r of s.settlements){
  const time=Date.parse(r.settled_time);if(!Number.isFinite(time))throw Error('Liquidación sin fecha');if(time<baseline.startedAt)continue;
  if(!positions.has(r.ticker)||settled.has(r.ticker))throw Error('Liquidación externa o duplicada');
  const q=positions.get(r.ticker),yes=decimal(r.yes_count_fp)/1e6,no=decimal(r.no_count_fp)/1e6;
  if(yes!==Math.max(q,0)||no!==Math.max(-q,0))throw Error('Cantidad liquidada no coincide');
  const revenue=money(r,'revenue_dollars','revenue'),fee=positive(r.fee_cost);
  if(revenue<0||fee!==0)throw Error('Liquidación requiere revisión de costes');
  cash+=revenue;received+=revenue;positions.set(r.ticker,0);settled.add(r.ticker);
 }
 const seenPositions=new Set();
 for(const p of s.positions){
  if(seenPositions.has(p.ticker))throw Error('Posición duplicada');seenPositions.add(p.ticker);
  if(Math.abs(decimal(p.position_fp)/1e6-(positions.get(p.ticker)||0))>1e-8)throw Error('Posición externa o faltan ejecuciones');
 }
 if([...positions].some(([t,q])=>q!==0&&!seenPositions.has(t)))throw Error('Posición local ausente');
 if(Math.abs(cash-s.balance)>1)throw Error('Saldo no concuerda: depósito, retiro, actividad externa o datos incompletos');
 // All pilot losses remain covered by gross local reservations; never count them twice.
 return {complete:true,balance:s.balance/1e6,fees:fees/1e6,grossSpent:spent/1e6,received:received/1e6,cashChange:(s.balance-baseline.balance)/1e6,externalLiability:0,realizedLoss:0,lossAccounting:'covered_by_gross_reservations',positions:Object.fromEntries(positions)};
}
function reconcile(input){return reconcileCore(input);}
// Diagnostic replay across the ORIGINAL campaign, never an execution authorization.
function auditCampaign(input){return {...reconcileCore(input,true),executable:false,baselineExpired:input.snapshot.checkedAt-input.baseline.startedAt>86400000};}
function create({transport,baseline,ledger,accountId,approvedRules=()=>({}),clock=Date.now}){
 return async intent=>{
  const read=transport.read,m=(await read('/markets/'+encodeURIComponent(intent.ticker))).market;
  if(m?.ticker!==intent.ticker||m.market_type!=='binary'||!m.event_ticker||!m.rules_primary)throw Error('Mercado no verificable');
  if(m.settlement_bounds_type&&m.settlement_bounds_type!=='default')throw Error('Liquidación no binaria estándar; mercado no soportado');
  const event=(await read('/events/'+encodeURIComponent(m.event_ticker))).event;
  if(event?.event_ticker!==m.event_ticker||!event.series_ticker)throw Error('Evento no verificable');
  const [seriesData,changes,eventChanges,status]=await Promise.all([
   read('/series/'+encodeURIComponent(event.series_ticker)),read('/series/fee_changes?series_ticker='+encodeURIComponent(event.series_ticker)),pages(read,'/events/fee_changes?event_ticker='+encodeURIComponent(m.event_ticker),'event_fee_changes'),read('/exchange/status')
  ]);
  if(seriesData.series?.ticker!==event.series_ticker||status.trading_active!==true||status.exchange_active!==true)throw Error('Serie o exchange no disponible');
  const fees=feeBound({intent:{...intent,eventTicker:m.event_ticker},series:seriesData.series,eventChanges,seriesChanges:changes.series_fee_change_arr,now:clock()});
  const state=await snapshot(transport,clock),account=reconcile({snapshot:state,baseline:baseline(),ledger:ledger(),accountId});
  if(!Number.isInteger(m.exchange_index)||!Object.hasOwn(state.shardBalances,m.exchange_index))throw Error('Saldo del mercado no verificado');
  const marketBalance=state.shardBalances[m.exchange_index];
  if(clock()-fees.checkedAt>5000)throw Error('Tarifas caducadas durante consulta');
  const approved=approvedRules()[m.ticker],hash=ruleHash(m),net=account.positions[m.ticker]||0;
  if(intent.action==='buy'&&((intent.side==='yes'&&net<0)||(intent.side==='no'&&net>0)))throw Error('Reducir explícitamente la posición opuesta antes de comprar');
  return {...account,accountBalance:account.balance,balance:marketBalance,exchangeIndex:m.exchange_index,ticker:m.ticker,checkedAt:state.checkedAt,marketActive:m.status==='active',closeTime:Date.parse(m.close_time),feeUpperBound:fees.upperBound,feesVerified:true,fees,rulesVerified:approved===hash,ruleHash:hash,heldQuantity:intent.side==='yes'?Math.max(net,0):Math.max(-net,0)};
 };
}
module.exports={create,snapshot,flatBaseline,reconcile,auditCampaign,feeBound,ruleHash,pages,mergeOrders};
