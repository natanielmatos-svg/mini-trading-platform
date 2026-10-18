'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fetchJson}=require('./http');
const {signedHeaders}=require('./kalshi-reference');
const {TtlCache}=require('./cache');
const cache=new TtlCache({ttlMs:60000,maxEntries:1});
async function account(){
 return cache.wrap('account',async()=>{
  try{
   const id=process.env.KALSHI_API_KEY_ID,keyPath=process.env.KALSHI_PRIVATE_KEY_PATH;
   if(!id||!keyPath)return {ok:false,reason:'Faltan credenciales de lectura',checkedAt:Date.now()};
   const key=fs.readFileSync(path.resolve(__dirname,'..',keyPath));
   const base='https://external-api.kalshi.com/trade-api/v2';
   const get=route=>fetchJson(base+route,{headers:signedHeaders(id,key,base+route),timeoutMs:6000,retries:0});
   const [balance,orders,positions]=await Promise.all([get('/portfolio/balance'),get('/portfolio/orders?status=resting&limit=100'),get('/portfolio/positions?limit=100')]);
   if(!Number.isFinite(balance.balance)||balance.balance<0||!Array.isArray(orders.orders)||!Array.isArray(positions.market_positions))throw Error('schema');
   return {ok:true,checkedAt:Date.now(),balanceUSD:balance.balance/100,openOrders:orders.orders.length,positionRecords:positions.market_positions.length,complete:!orders.cursor&&!positions.cursor};
  }catch{return {ok:false,reason:'No se pudo verificar la cuenta completa. Revisa conexión y permisos de lectura.',checkedAt:Date.now()};}
 });
}
function assess({config,bot={},learning={},account={},now=Date.now(),demo=false}){
 const dailyBudgetUSD=Math.floor(config.capital*config.maxDailyLossPct)/100;
 const checks=[
  {id:'mode',ok:!demo,label:'Servidor con datos reales',detail:'Datos reales no significa ejecución real.'},
  {id:'account',ok:account.ok===true&&account.complete===true&&now-account.checkedAt<90000,label:'Lectura reciente de cuenta',detail:account.ok?'Consulta de saldo, órdenes y posiciones; no acredita permiso para operar.':account.reason||'Sin verificar'},
  {id:'balance',ok:account.ok===true&&account.balanceUSD>=config.capital,label:'Saldo disponible para el capital configurado',detail:'El capital es un límite local, no un depósito ni una reserva de saldo.'},
  {id:'risk',ok:config.maxPerTrade!==null&&config.maxPerTrade<=dailyBudgetUSD,label:'Coherencia entre importe por operación y presupuesto diario',detail:'El presupuesto incluye coste expuesto y comisiones; no garantiza limitar la pérdida real.'},
  {id:'bot',ok:bot.running===true,label:'Bot simulado disponible',detail:bot.entryBlock||'El bot permanece en simulación.'},
  {id:'learning',ok:Number.isFinite(learning.lastRun)&&now-learning.lastRun<180000&&!(learning.errors||[]).length,label:'Recolección de aprendizaje reciente',detail:'Recopilar datos no demuestra rentabilidad.'},
  {id:'settlement',ok:false,label:'Objetivo de liquidación y comisiones por contrato',detail:'Pendientes de verificación; el índice instantáneo no es la liquidación.'},
  {id:'execution',ok:false,label:'Órdenes, ejecuciones parciales y reconciliación',detail:'Ejecutor y piloto contable con tarifas por serie/evento integrados y probados localmente. Producción desactivada; validación autenticada con Kalshi demo pendiente.'},
  {id:'advantage',ok:false,label:'Ventaja prospectiva neta demostrada',detail:'No acreditada. El modelo experimental no autoriza una entrada.'},
 ];
 return {checkedAt:now,ready:false,liveEnabled:false,mode:'preparación supervisada',capitalUSD:config.capital,dailyBudgetUSD,maxPerTradeUSD:config.maxPerTrade,checks,account,
 nextStep:'Revisa cada contrato, precio, cantidad, comisiones y pérdida posible. Cualquier operación real debe confirmarse manualmente en Kalshi; esta app no envía órdenes.'};
}
module.exports={account,assess};
