'use strict';
const {fetchJson}=require('./http'),{TtlCache}=require('./cache');
const cache=new TtlCache({ttlMs:5000,maxEntries:8});
const SERIES={BTCUSDT:{'15m':'KXBTC15M','1h':'KXBTCD'},ETHUSDT:{'15m':'KXETH15M'}};
const STEPS={'15m':900000,'1h':3600000};
function select(markets,{symbol,interval,now=Date.now()}){
 const series=SERIES[symbol]?.[interval],step=STEPS[interval];
 if(!series)return {ok:false,contracts:[],reason:'No hay un contrato Kalshi verificado para este activo y bloque. Usa un nivel manual.'};
 const closesAt=(Math.floor(now/step)+1)*step;
 const contracts=markets.filter(m=>m.ticker?.startsWith(series+'-')&&m.market_type==='binary'&&['active','open'].includes(m.status)&&!m.is_provisional&&Date.parse(m.open_time)<=now&&Date.parse(m.close_time)===closesAt&&['greater','greater_or_equal'].includes(m.strike_type)&&typeof m.floor_strike==='number'&&Number.isFinite(m.floor_strike)&&m.floor_strike>0)
 .map(m=>({ticker:m.ticker,title:m.title,threshold:m.floor_strike,operator:m.strike_type==='greater_or_equal'?'>=':'>',closesAt,rules:m.rules_primary||'',unit:'USD'})).sort((a,b)=>a.threshold-b.threshold);
 return {ok:contracts.length>0,symbol,interval,closesAt,checkedAt:now,contracts,reason:contracts.length?'':'Kalshi aún no publica un umbral válido para el bloque actual. Se volverá a consultar.'};
}
async function get({symbol,interval}){
 const series=SERIES[symbol]?.[interval];if(!series)return select([],{symbol,interval});
 const data=await cache.wrap(series,()=>fetchJson('https://external-api.kalshi.com/trade-api/v2/markets?series_ticker='+series+'&status=open&limit=1000',{timeoutMs:6000,retries:0}));
 if(!Array.isArray(data.markets)||data.cursor)throw Error('Listado de contratos incompleto');
 return select(data.markets,{symbol,interval});
}
module.exports={get,select};
