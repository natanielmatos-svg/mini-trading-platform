'use strict';
// Experimental transfer of a candle forecast to a demo contract, never a calibrated EV.
const VERSION='selected-model-demo-transfer-v2';
function decide({environment,forecast:f,market:m,held=0,entryPrice=null,now=Date.now()}){
 if(environment!=='demo')throw Error('Estrategia exclusiva de demo');
 const wait=reason=>({version:VERSION,action:'wait',reason,experimental:true,productionEnabled:false});
 if(!m||!/^KXBTC15M-/.test(m.ticker)||m.status!=='active'||!Number.isFinite(m.floor_strike)||m.floor_strike<=0||m.strike_type!=='greater_or_equal'||!/BRTI/.test(m.rules_primary||''))return wait('Contrato BTC 15m no verificable');
 const close=Date.parse(m.close_time),left=close-now;
 if(!(left>15000))return wait('Contrato cerrado o sin tiempo suficiente');
 const side=held<0?'no':'yes',bid=Number(m[side+'_bid_dollars']);
 const validPrice=p=>Number.isFinite(p)&&p>0&&p<1;
 const sell=reason=>validPrice(bid)&&bid>=.01?{version:VERSION,action:'sell',side,price:Math.floor(bid*100+1e-8)/100,quantity:Math.abs(held),reason,experimental:true}:wait('Sin comprador para salir');
 // Exits at the last minute do not depend on the neural service being available.
 if(held&&left<=60000)return sell('Salida antes del cierre');
 if(!f?.ok||f.demo||f.symbol!=='BTCUSDT'||f.interval!=='15m'||f.source!=='consolidado'||f.referenceUnit!=='USD'||f.closesAt!==close||f.target?.kind!=='candle-close'||f.target?.closesAt!==close||!Number.isFinite(f.generatedAt)||f.generatedAt>now||now-f.generatedAt>90000||!Number.isFinite(f.estimatedClose))return held?sell('Predicción ausente, caducada o incompatible'):wait('Predicción ausente, caducada o incompatible');
 const q=f.quantiles,band=f.predictionInterval;
 const validQuantiles=Array.isArray(q)&&q.length===9&&!q.some((v,i)=>!Number.isFinite(v)||v<=0||(i>0&&v<q[i-1]));
 const validBand=band&&Number.isFinite(band.lower)&&Number.isFinite(band.upper)&&band.lower>0&&band.upper>=band.lower&&band.calibrationCases>=20&&band.target==='official Kalshi expiration_value';
 if(!validQuantiles&&!validBand)return held?sell('Intervalo del motor inválido'):wait('Intervalo del motor inválido');
 const lower=validBand?band.lower:q[0],upper=validBand?band.upper:q[8];
 const signal=lower>m.floor_strike?'yes':upper<m.floor_strike?'no':null;
 if(held){
  if(signal!==side)return sell('La banda neuronal dejó de apoyar la posición');
  if(Number.isFinite(entryPrice)&&bid>=entryPrice+.05)return sell('Beneficio bruto de 5 centavos');
  return wait('Mantener mientras la banda apoye la posición');
 }
 if(left<120000)return wait('Menos de dos minutos para abrir');
 if(!signal)return wait('La banda central cruza la meta de Kalshi');
 const ask=Number(m[signal+'_ask_dollars']);
 if(!validPrice(ask))return wait('No hay precio de compra válido');
 return {version:VERSION,action:'buy',side:signal,quantity:1,price:Math.ceil(ask*100-1e-8)/100,reason:'Banda central completamente del mismo lado de la meta; experimento de transferencia',experimental:true};
}
module.exports={VERSION,decide};
