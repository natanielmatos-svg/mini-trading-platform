'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fetchJson}=require('./http'),{signedHeaders}=require('./kalshi-reference'),{TtlCache}=require('./cache');
const cache=new TtlCache({ttlMs:1000,maxEntries:1}),marketCache=new TtlCache({ttlMs:300000,maxEntries:200});
const number=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const money=(r,dollars,cents)=>number(r[dollars])??(number(r[cents])===null?null:number(r[cents])/100);
const sum=(rows,key)=>rows.some(r=>r[key]===null)?null:rows.reduce((s,r)=>s+r[key],0);
function normalize(kind,r){
 const ticker=r.ticker||r.market_ticker||r.event_ticker||'';
 if(kind==='positions')return {ticker,contracts:number(r.position_fp??r.position),cost:money(r,'market_exposure_dollars','market_exposure'),traded:money(r,'total_traded_dollars','total_traded'),pnl:money(r,'realized_pnl_dollars','realized_pnl'),fees:money(r,'fees_paid_dollars','fees_paid'),at:r.last_updated_ts||null};
 if(kind==='settlements'){
  const yesCost=money(r,'yes_total_cost_dollars','yes_total_cost'),noCost=money(r,'no_total_cost_dollars','no_total_cost'),revenue=money(r,'revenue_dollars','revenue'),fees=number(r.fee_cost);
  return {ticker,result:r.market_result,yesCount:number(r.yes_count_fp??r.yes_count),noCount:number(r.no_count_fp??r.no_count),yesCost,noCost,revenue,fees,at:r.settled_time};
 }
 const base={ticker,id:r.order_id||r.fill_id,side:r.outcome_side||r.side||null,action:r.action||null,bookSide:r.book_side||null,yesPrice:money(r,'yes_price_dollars','yes_price'),noPrice:money(r,'no_price_dollars','no_price'),at:r.created_time||null};
 if(kind==='fills')return {...base,id:r.fill_id||r.trade_id,count:number(r.count_fp??r.count),fees:number(r.fee_cost),taker:r.is_taker};
 return {...base,status:r.status,type:r.type,initial:number(r.initial_count_fp??r.initial_count),filled:number(r.fill_count_fp??r.fill_count),remaining:number(r.remaining_count_fp??r.remaining_count),makerCost:money(r,'maker_fill_cost_dollars','maker_fill_cost'),takerCost:money(r,'taker_fill_cost_dollars','taker_fill_cost'),makerFees:money(r,'maker_fees_dollars','maker_fees'),takerFees:money(r,'taker_fees_dollars','taker_fees')};
}
async function pages(get,route,key,maxPages=10){
 const rows=[],seen=new Set();let cursor='';
 for(let i=0;i<maxPages;i++){
  try{const d=await get(route+'?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(!Array.isArray(d[key]))throw Error('schema');rows.push(...d[key]);
   if(!d.cursor)return {rows,complete:true};if(seen.has(d.cursor))return {rows,complete:false,error:'Cursor repetido'};seen.add(d.cursor);cursor=d.cursor;
  }catch{return {rows,complete:false,error:'No se pudo completar esta consulta'};}
 }
 return {rows,complete:false,error:'Se alcanzó el límite de 1.000 registros por consulta'};
}
async function snapshot(){return cache.wrap('portfolio',async()=>{
 const keyId=process.env.KALSHI_API_KEY_ID,keyPath=process.env.KALSHI_PRIVATE_KEY_PATH;
 if(!keyId||!keyPath)throw Error('Credenciales no configuradas');
 const key=fs.readFileSync(path.resolve(__dirname,'..',keyPath));
 const get=route=>{const url='https://external-api.kalshi.com/trade-api/v2'+route;return fetchJson(url,{headers:signedHeaders(keyId,key,url),timeoutMs:6000,retries:0});};
 const requestedAt=Date.now(),sections={};let balance,balanceCheckedAt=null;
 await Promise.all([
  (async()=>{try{balance=await get('/portfolio/balance');balanceCheckedAt=Date.now();}catch{balance=null;}})(),
  ...[['positions','market_positions'],['orders','orders'],['fills','fills'],['settlements','settlements']].map(async([kind,field])=>{
   const startedAt=Date.now();const data=await pages(get,'/portfolio/'+kind,field);sections[kind]={requestedAt:startedAt,checkedAt:Date.now(),complete:data.complete,error:data.error||null,rows:data.rows.map(r=>normalize(kind,r))};
  })
 ]);
 const tickers=[...new Set(Object.values(sections).flatMap(s=>s.rows.map(r=>r.ticker)))].filter(Boolean).slice(0,50),titles={};
 for(let i=0;i<tickers.length;i+=4)await Promise.all(tickers.slice(i,i+4).map(async ticker=>{try{const m=await marketCache.wrap(ticker,()=>get('/markets/'+encodeURIComponent(ticker)).then(d=>d.market));if(m?.title)titles[ticker]=m.title;}catch{}}));
 for(const s of Object.values(sections))for(const r of s.rows)r.title=titles[r.ticker]||r.ticker;
 const positions=sections.positions.rows.filter(p=>p.contracts!==0&&p.contracts!==null);
 return {requestedAt,checkedAt:Date.now(),pollIntervalMs:5000,readOnly:true,currency:'USD',balance:{checkedAt:balanceCheckedAt,available:balance?money(balance,'balance_dollars','balance'):null,portfolio:balance?money(balance,'portfolio_value_dollars','portfolio_value'):null,updatedAt:balance?.updated_ts??null},
 summary:{openPositions:sections.positions.complete?positions.length:null,positionCost:sections.positions.complete?sum(positions,'cost'):null,realizedReported:sections.positions.complete&&sections.positions.rows.length?sum(sections.positions.rows,'pnl'):null,positionFees:sections.positions.complete?sum(sections.positions.rows,'fees'):null,restingOrders:sections.orders.complete?sections.orders.rows.filter(r=>r.status==='resting').length:null,fillFees:sections.fills.rows.length||sections.fills.complete?sum(sections.fills.rows,'fees'):null,settlementRevenue:sections.settlements.rows.length||sections.settlements.complete?sum(sections.settlements.rows,'revenue'):null},sections,
 note:'Cuenta principal real de Kalshi; no incluye el saldo simulado del bot. Órdenes y ejecuciones del endpoint reciente: puede excluir registros archivados. Liquidaciones y resultados corresponden únicamente a los registros cargados; no sumar P&L de posiciones y liquidaciones. Los datos ausentes se muestran como no disponibles.'};
 });}
module.exports={snapshot,normalize,pages,money};
