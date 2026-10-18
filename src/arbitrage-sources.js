'use strict';
const {fetchJson}=require('./http');
const kalshiBook=require('./kalshi-book');
const {fingerprint}=require('./arbitrage-engine');
const POLY='https://gamma-api.polymarket.com', CLOB='https://clob.polymarket.com';
const KALSHI='https://api.elections.kalshi.com/trade-api/v2';
const options={timeoutMs:8000,retries:0};
function array(value){try{return Array.isArray(value)?value:JSON.parse(value);}catch{return [];}}
function polyMarket(m){
  const outcomes=array(m.outcomes),tokens=array(m.clobTokenIds);
  if(m.active!==true||m.closed!==false||m.acceptingOrders!==true||m.enableOrderBook!==true||outcomes.length!==2||tokens.length!==2||tokens.some(t=>!/^\d+$/.test(t)))return null;
  let fee=null;
  if(m.feesEnabled===false)fee={rate:0,exponent:1,precision:5};
  else if(m.feesEnabled===true&&m.feeSchedule?.exponent===1&&Number.isFinite(Number(m.feeSchedule.rate)))fee={rate:Number(m.feeSchedule.rate),exponent:1,precision:5};
  const market={provider:'polymarket',id:String(m.id),conditionId:m.conditionId,title:m.question,outcomes,tokens,
    rules:m.description||'',resolutionSource:m.resolutionSource||'',closeTime:Date.parse(m.endDate),currency:'pUSD',
    fee,minNotional:Number.isFinite(Number(m.orderMinSize))&&m.orderMinSize!=null?Number(m.orderMinSize):null,
    // Se exige también el mínimo en acciones por compatibilidad con libros/versiones anteriores.
    minShares:Number.isFinite(Number(m.orderMinSize))&&m.orderMinSize!=null?Number(m.orderMinSize):null,
    volume:Number(m.volume24hr)||0,url:'https://polymarket.com/event/'+encodeURIComponent(m.events?.[0]?.slug||m.slug),
    restricted:m.restricted===true,delaySeconds:Number(m.secondsDelay)||0};
  market.rulesHash=fingerprint(market);return market;
}
function kalshiMarket(m){
  if(!['open','active'].includes(m.status)||m.market_type!=='binary'||m.mve_collection_ticker)return null;
  const market={provider:'kalshi',id:m.ticker,conditionId:m.ticker,title:[m.title,m.yes_sub_title].filter(Boolean).join(' — '),outcomes:['Yes','No'],tokens:[m.ticker+':yes',m.ticker+':no'],
    rules:[m.rules_primary,m.rules_secondary].filter(Boolean).join('\n'),resolutionSource:'ver reglamento de la serie',
    closeTime:Date.parse(m.close_time),currency:'USD',fee:null,minNotional:0,minShares:1,volume:Number(m.volume_24h_fp)||0,
    url:'https://kalshi.com/markets/'+encodeURIComponent(m.ticker.split('-')[0].toLowerCase())};
  market.rulesHash=fingerprint(market);return market;
}
async function catalog(provider){
  if(provider==='polymarket_us')return require('./arbitrage-polymarket-us').catalog();
  const now=Date.now(),markets=[],pages=2;let cursor='',truncated=false;
  for(let page=0;page<pages;page++){
    if(provider==='polymarket'){
      const raw=await fetchJson(POLY+'/markets',{...options,searchParams:{active:true,closed:false,limit:150,offset:page*150,order:'volume24hr',ascending:false}});
      if(!Array.isArray(raw))throw Error('Catálogo Polymarket no válido');
      markets.push(...raw.map(polyMarket).filter(Boolean));truncated=raw.length===150;if(!truncated)break;
    }else{
      const raw=await fetchJson(KALSHI+'/markets',{...options,searchParams:{status:'open',limit:500,mve_filter:'exclude',min_close_ts:Math.floor(now/1000),max_close_ts:Math.floor(now/1000)+7*86400,cursor}});
      if(!Array.isArray(raw.markets))throw Error('Catálogo Kalshi no válido');
      markets.push(...raw.markets.map(kalshiMarket).filter(Boolean));cursor=raw.cursor||'';truncated=!!cursor;if(!cursor)break;
    }
  }
  return {provider,at:Date.now(),truncated,markets:markets.filter(m=>m.closeTime>now),scope:provider==='polymarket'?'Hasta 300 mercados activos por volumen':'Hasta 1000 contratos con cierre en siete días'};
}
function levels(rows){
  if(!Array.isArray(rows))throw Error('Profundidad no disponible');
  return rows.map(r=>{const price=Number(r.price),quantity=Number(r.size);if(!Number.isFinite(price)||price<=0||price>=1||!Number.isFinite(quantity)||quantity<0)throw Error('Nivel inválido');return {price,quantity};}).filter(r=>r.quantity>0);
}
function polyBook(raw,market,side,startedAt,now=Date.now()){
  const token=market.tokens[side==='yes'?0:1];
  if(raw.asset_id!==token||raw.market!==market.conditionId)throw Error('Libro de otro token o condición');
  const sourceAt=Number(raw.timestamp);
  if(!Number.isFinite(sourceAt)||sourceAt>now+1000||now-sourceAt>10000)throw Error('Fecha de libro ausente o atrasada');
  return {market:market.id,side,at:Math.min(startedAt,sourceAt),asks:levels(raw.asks),bids:levels(raw.bids)};
}
async function book(m,side){
  if(m.provider==='polymarket_us')return require('./arbitrage-polymarket-us').book(m,side);
  if(m.provider==='polymarket'){
    const at=Date.now(),raw=await fetchJson(CLOB+'/book',{...options,searchParams:{token_id:m.tokens[side==='yes'?0:1]}});
    return polyBook(raw,m,side,at);
  }
  const raw=await kalshiBook.obtener(m.id),own=side==='yes'?raw.yes:raw.no,opposite=side==='yes'?raw.no:raw.yes;
  return {market:m.id,side,at:raw.at,bids:own.map(r=>({price:r.precio,quantity:r.cantidad})),asks:opposite.map(r=>({price:Number((1-r.precio).toFixed(4)),quantity:r.cantidad}))};
}
async function eligibility(provider){
  if(provider==='polymarket_us')return require('./arbitrage-polymarket-us').eligibility();
  try{
    const raw=await fetchJson('https://polymarket.com/api/geoblock',options);
    return {checkedAt:Date.now(),internationalBlocked:typeof raw.blocked==='boolean'?raw.blocked:null,
      accountVerified:false,note:'La comprobación de red no valida residencia ni elegibilidad de la cuenta. Polymarket US es un servicio separado.'};
  }catch{return {checkedAt:Date.now(),internationalBlocked:null,accountVerified:false,note:'Acceso no verificado; lectura pública solamente.'};}
}
module.exports={catalog,book,eligibility,polyMarket,kalshiMarket,polyBook,levels};
