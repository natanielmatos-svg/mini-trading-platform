'use strict';
// Sólo resultados finales binarios. «closed» o «determined» aún no certifican liquidación.
function officialResult(m,ticker){
 if(!m||m.ticker!==ticker||!['finalized','settled'].includes(m.status)||m.is_provisional===true||!['yes','no'].includes(m.result))return null;
 return {resultado:m.result,status:m.status,settlementAt:m.settlement_ts||null};
}
async function fetchResult(ticker){
 const {fetchJson}=require('./http');
 const data=await fetchJson('https://external-api.kalshi.com/trade-api/v2/markets/'+encodeURIComponent(ticker),{timeoutMs:6000,retries:0});
 return officialResult(data.market,ticker);
}
module.exports={officialResult,fetchResult};
