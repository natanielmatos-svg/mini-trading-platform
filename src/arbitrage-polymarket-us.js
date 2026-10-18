'use strict';
const {fetchJson}=require('./http');
const {fingerprint}=require('./arbitrage-engine');
const BASE='https://gateway.polymarket.us';
const options={timeoutMs:8000,retries:0};
function normalize(m){
  const sides=m.marketSides||[],long=sides.find(s=>s.long===true),short=sides.find(s=>s.long===false);
  if(m.active!==true||m.closed!==false||m.status!=='MARKET_STATUS_OPEN'||!m.slug||sides.length!==2||!long||!short||long.tradable!==true||short.tradable!==true||long.identifier!==short.identifier||m.marketType==='combo')return null;
  if(long.quote?.currency!=='USD'||short.quote?.currency!=='USD')return null;
  const rate=m.feeCoefficient,minimum=m.minimumTradeQty;
  const market={provider:'polymarket_us',id:String(m.id),slug:m.slug,conditionId:long.identifier,
    title:[m.question,m.title].filter(Boolean).join(' — '),outcomes:[long.description,short.description],tokens:[String(long.id),String(short.id)],
    rules:m.description||'',resolutionSource:'Reglas de Polymarket US',closeTime:Date.parse(m.endDate),currency:'USD',
    fee:typeof rate==='number'&&Number.isFinite(rate)&&rate>=0&&rate<=1?{rate,exponent:1,precision:2,rounding:'conservative-ceiling'}:null,
    minShares:typeof minimum==='number'&&Number.isFinite(minimum)&&minimum>=1?minimum:null,minNotional:0,
    url:'https://polymarket.us/event/'+encodeURIComponent(m.slug),delaySeconds:0};
  market.rulesHash=fingerprint(market);return market;
}
async function catalog(){
  const markets=[];let truncated=false;const from=Date.now(),until=from+7*86400000;
  for(let page=0;page<3;page++){
    const raw=await fetchJson(BASE+'/v1/markets',{...options,searchParams:{active:true,closed:false,archived:false,limit:100,offset:100*page,endDateMin:new Date(from).toISOString(),endDateMax:new Date(until).toISOString()}});
    if(!Array.isArray(raw.markets))throw Error('Catálogo Polymarket US no válido');
    markets.push(...raw.markets.map(normalize).filter(Boolean));truncated=raw.markets.length===100;if(!truncated)break;
  }
  return {provider:'polymarket_us',at:Date.now(),truncated,markets:markets.filter(m=>m.closeTime>Date.now()&&m.closeTime<=until),scope:'Hasta 300 mercados de Polymarket US con cierre en siete días'};
}
function parseBook(raw,m,side,at){
  const data=raw.marketData;
  if(!data||data.marketSlug!==m.slug||data.state!=='MARKET_STATE_OPEN')throw Error('Libro US cerrado o de otro contrato');
  const levels=rows=>{
    if(!Array.isArray(rows))throw Error('Sin profundidad US');
    return rows.map(r=>{const price=Number(r.px?.value),quantity=Number(r.qty);if(r.px?.currency!=='USD'||!Number.isFinite(price)||price<=0||price>=1||!Number.isFinite(quantity)||quantity<0)throw Error('Nivel US inválido');return {price,quantity};}).filter(r=>r.quantity>0);
  };
  const bids=levels(data.bids),asks=levels(data.offers),opposite=ls=>ls.map(r=>({price:Number((1-r.price).toFixed(6)),quantity:r.quantity}));
  // El endpoint no publica timestamp del snapshot. at mide la petición, no el último trade.
  return {market:m.id,side,at,timestampKind:'request-start',asks:side==='yes'?asks:opposite(bids),bids:side==='yes'?bids:opposite(asks)};
}
async function book(m,side){const at=Date.now();const raw=await fetchJson(BASE+'/v1/markets/'+encodeURIComponent(m.slug)+'/book',options);return parseBook(raw,m,side,at);}
function eligibility(){return Promise.resolve({checkedAt:Date.now(),service:'polymarket_us',accountVerified:false,
  note:'Datos públicos de Polymarket US. La restricción de Polymarket internacional no se aplica como diagnóstico de esta cuenta. Elegibilidad y permisos de cuenta pendientes de verificar.'});}
module.exports={normalize,catalog,book,parseBook,eligibility};
