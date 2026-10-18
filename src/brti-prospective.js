'use strict';
// A fixed, prospective observation policy. Never creates orders or historical backfills.
const VERSION='brti-hold-10m-v1';
const POLICY=Object.freeze({version:VERSION,symbol:'BTCUSDT',interval:'15m',secondsBeforeClose:600,toleranceSeconds:30,quantity:1,exit:'official-settlement',maxCostWithFees:1.03});
function freeze({sample:s,reference:r,fees,at}){
 const base={policy:POLICY,ticker:s.ticker,at,reference:r,fees,threshold:s.threshold,operator:s.operator,closesAt:s.closesAt,status:'abstained'};
 const reject=reason=>({...base,reason});
 if(s.settlementBoundsType&&s.settlementBoundsType!=='default')return reject('Liquidación no binaria estándar; no se asume pago 0/1');
 if(Math.abs(s.closesAt-s.requestedAt-600000)>30000||at>=s.closesAt||at-s.requestedAt>15000)return reject('Fuera de ventana o captura lenta');
 if(!r?.ok||r.index!=='BRTI'||r.currency!=='USD'||!Number.isFinite(r.price)||r.price<=0||!Number.isFinite(r.at)||r.at>s.at||s.at-r.at>15000)return reject('BRTI sin fecha previa reciente');
 if(!Number.isFinite(s.threshold)||!['>=','>'].includes(s.operator))return reject('Meta o comparador no verificable');
 const b=s.book;
 if(!b||!Number.isFinite(b.at)||b.at<r.at||b.at>s.at||s.at-b.at>10000||![b.yes,b.no].every(a=>Array.isArray(a)&&a.length&&a.every(x=>Number.isFinite(x.precio)&&x.precio>0&&x.precio<1&&Number.isFinite(x.cantidad)&&x.cantidad>0)))return reject('Libro ausente, inválido o sin sincronización');
 const yes=[...b.yes].sort((a,b)=>b.precio-a.precio),no=[...b.no].sort((a,b)=>b.precio-a.precio);
 if(yes[0].precio+no[0].precio>1+1e-9)return reject('Libro cruzado');
 const side=(s.operator==='>='?r.price>=s.threshold:r.price>s.threshold)?'yes':'no';
 let remaining=1,cost=0;for(const row of side==='yes'?no:yes){const q=Math.min(remaining,row.cantidad);cost+=q*(1-row.precio);remaining-=q;if(remaining<1e-9)break;}
 if(remaining>1e-9)return reject('Profundidad insuficiente para un contrato');
 base.side=side;base.entryPriceUSD=cost;base.book=s.book;base.quoteDiscrepancyUSD=Number.isFinite(s.quotes?.[side+'Ask'])?s.quotes[side+'Ask']-cost:null;
 if(!fees?.verified||!Number.isFinite(fees.upperBound)||fees.upperBound<0||!Number.isFinite(fees.checkedAt)||fees.checkedAt>at||at-fees.checkedAt>10000)return reject('Tarifas no verificadas');
 if(cost+fees.upperBound>POLICY.maxCostWithFees)return reject('Coste superior al límite de prueba');
 return {...base,status:'observed',reason:'Un contrato teórico al libro; conservar hasta liquidación oficial. No es un fill.',feeBoundUSD:fees.upperBound};
}
function summarize(decisions,settlements){
 const rows=[...decisions.values()].filter(x=>x.policy?.version===VERSION),observed=rows.filter(x=>x.status==='observed');
 let gross=0,fees=0,equity=0,peak=0,drawdown=0,wins=0;const closed=[];
 for(const d of [...observed].sort((a,b)=>a.closesAt-b.closesAt)){const s=settlements.get(d.ticker);if(!s||!['yes','no'].includes(s.resultado))continue;const payout=d.side===s.resultado?1:0;wins+=payout;const net=payout-d.entryPriceUSD-d.feeBoundUSD;gross+=payout-d.entryPriceUSD;fees+=d.feeBoundUSD;equity+=net;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);closed.push({ticker:d.ticker,side:d.side,entryPriceUSD:d.entryPriceUSD,feeBoundUSD:d.feeBoundUSD,result:s.resultado,netBoundUSD:net});}
 return {policy:POLICY,decisions:rows.length,abstentions:rows.length-observed.length,pending:observed.length-closed.length,evaluated:closed.length,wins,losses:closed.length-wins,grossUSD:closed.length?gross:null,feeBoundUSD:closed.length?fees:null,netBoundUSD:closed.length?equity:null,maxDrawdownUSD:closed.length?drawdown:null,actualNetUSD:null,executedOrders:0,latest:rows.at(-1)||null,recent:closed.slice(-10),note:'Observación prospectiva a precios del libro, con cota de comisiones; no acredita ejecución, rentabilidad realizable ni órdenes demo.'};
}
async function feesFor(m,clock=Date.now,action='buy'){
 const {fetchJson}=require('./http'),{feeBound,pages}=require('./kalshi-execution-preflight');
 const read=p=>{
  const url='https://external-api.kalshi.com/trade-api/v2'+p;
  const keyId=process.env.KALSHI_API_KEY_ID,keyPath=process.env.KALSHI_PRIVATE_KEY_PATH;
  const headers=keyId&&keyPath?require('./kalshi-reference').signedHeaders(keyId,require('node:fs').readFileSync(require('node:path').resolve(__dirname,'..',keyPath)),url):{};
  return fetchJson(url,{headers,timeoutMs:4000,retries:0});
 };
 try{
  if(!m.event_ticker)throw Error();
  const [data,changes,eventChanges]=await Promise.all([read('/series/KXBTC15M'),read('/series/fee_changes?series_ticker=KXBTC15M'),pages(read,'/events/fee_changes?event_ticker='+encodeURIComponent(m.event_ticker),'event_fee_changes')]);
  if(data.series?.ticker!=='KXBTC15M')throw Error();
  const now=clock(),bound=feeBound({intent:{action,price:.5,quantity:1,eventTicker:m.event_ticker,expiresAt:now+15000},series:data.series,seriesChanges:changes.series_fee_change_arr,eventChanges,now});
  return {...bound,verified:true,series:data.series.ticker,feeType:data.series.fee_type,eventChanges,seriesChanges:changes.series_fee_change_arr};
 }catch{return {verified:false,checkedAt:clock(),reason:require('./kalshi-fee-policy').status(clock()).valid?'Método o calendario de tarifas no verificable':'Revisión documental de tarifas vencida'};}
}
module.exports={POLICY,freeze,summarize,feesFor};
