'use strict';
const {fetchJson}=require('./http');
const {money}=require('./kalshi-account');
const getMarket=ticker=>fetchJson('https://external-api.kalshi.com/trade-api/v2/markets/'+encodeURIComponent(ticker),{timeoutMs:6000,retries:0}).then(d=>d.market);
function create({proposals,settings=()=>require('./trading-settings').read(),account=()=>require('./kalshi-account').snapshot(),market=getMarket,clock=Date.now}){
 return async function prepare(id){
  if(!/^[a-f0-9]{64}$/.test(id||''))throw Error('Identificador de propuesta no válido');
  const original=proposals.snapshot().proposals.find(p=>p.id===id);
  if(!original)throw Error('La propuesta ha cambiado. Actualiza la lista.');
  const startedAt=clock();
  const [m,a]=await Promise.all([market(original.ticker).catch(()=>null),account().catch(()=>null)]);
  // Releer después de las consultas: la decisión puede caducar o sustituirse mientras esperamos.
  const p=proposals.snapshot().proposals.find(p=>p.id===id);
  if(!p)throw Error('La propuesta ha cambiado durante la consulta.');
  const config=settings(),now=clock(),blockers=[...p.blockers];
  if(p.review?.action==='reject')blockers.push('Propuesta rechazada');
  if(!Number.isFinite(p.expiresAt)||p.expiresAt<=now)blockers.push('Propuesta vencida');
  const verifiedMarket=m?.ticker===p.ticker;
  const ask=verifiedMarket&&['yes','no'].includes(p.side)?money(m,p.side+'_ask_dollars',p.side+'_ask'):null;
  if(!verifiedMarket||m.market_type!=='binary'||m.status!=='active'||!(Date.parse(m.close_time)>now))blockers.push('Mercado cerrado o estado no verificable');
  if(!(ask>0&&ask<1))blockers.push('No hay cotización de compra verificable');
  if(ask!==null&&Number.isFinite(p.price)&&ask>p.price)blockers.push('La oferta actual supera el precio de la propuesta');
  if(!Number.isSafeInteger(p.quantity)||p.quantity<=0)blockers.push('Cantidad de contratos no válida');
  const validCost=Number.isFinite(p.price)&&p.price>0&&p.price<1&&Number.isFinite(p.estimatedFees)&&p.estimatedFees>=0&&Number.isFinite(p.total)&&p.total>0&&p.total+1e-9>=p.price*p.quantity+p.estimatedFees;
  if(!validCost)blockers.push('Coste total o comisiones no verificables');
  const accountFresh=a&&Number.isFinite(a.requestedAt)&&now-a.requestedAt>=0&&now-a.requestedAt<15000;
  if(!accountFresh||!Number.isFinite(a?.balance?.available)||!a?.sections?.positions?.complete||!a?.sections?.orders?.complete)blockers.push('No se pudo verificar saldo, posiciones y órdenes recientes');
  if(Number.isFinite(p.total)&&Number.isFinite(a?.balance?.available)&&p.total>a.balance.available)blockers.push('Saldo insuficiente');
  if(config.paused)blockers.push('Entradas en pausa');
  if(Number.isFinite(p.total)&&(p.total>config.capital||p.total>config.capital*config.maxDailyLossPct/100||(config.maxPerTrade!==null&&p.total>config.maxPerTrade)))blockers.push('Importe superior a los límites configurados');
  return {id,mode:'manual_in_kalshi',execution:'not_sent',startedAt,checkedAt:now,expiresAt:Math.min(p.expiresAt||now,startedAt+15000),
   proposal:{ticker:p.ticker,side:p.side,quantity:p.quantity,limitPrice:p.price,estimatedFees:p.estimatedFees,estimatedCost:p.total},
   market:verifiedMarket?{title:m.title||p.ticker,ask,yesAsk:money(m,'yes_ask_dollars','yes_ask'),noAsk:money(m,'no_ask_dollars','no_ask'),status:m.status,closeTime:m.close_time,rules:m.rules_primary||'',additionalRules:m.rules_secondary||''}:null,
   account:{available:a?.balance?.available??null,checkedAt:a?.balance?.checkedAt??null,openPositions:a?.summary?.openPositions??null,restingOrders:a?.summary?.restingOrders??null},
   limits:{capital:config.capital,perTrade:config.maxPerTrade,dailyBudget:Math.floor(config.capital*config.maxDailyLossPct)/100},
   blockers:[...new Set(blockers)],
   note:'Ficha informativa, no autorización de ejecución. Puedes perder todo el coste de compra más las comisiones. El total usa la comisión estimada del bot: verifica la comisión final y las reglas en Kalshi. El presupuesto diario es el configurado, no el restante; falta reconciliar pérdidas y exposición. Ningún importe queda reservado.',
   kalshiUrl:'https://kalshi.com/markets'};
 };
}
module.exports={create};
