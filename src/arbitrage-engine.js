'use strict';
const { createHash } = require('node:crypto');
const { textSimilarity } = require('./normalize');
const VERSION = 'arb-observer-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fingerprint(m) {
  return hash([m.provider,m.id,m.outcomes,m.rules,m.resolutionSource,m.closeTime,m.currency,m.conditionId]);
}
function equivalence(a,b,certificates=[],now=Date.now()) {
  if(a.provider===b.provider && a.id===b.id && a.conditionId && a.conditionId===b.conditionId && fingerprint(a)===fingerprint(b) && JSON.stringify(a.tokens)===JSON.stringify(b.tokens) && a.outcomes?.length===2 && new Set(a.tokens||[]).size===2)
    return {ok:true,reason:'Dos resultados complementarios del mismo contrato',kind:'same-market'};
  // Una similitud textual nunca otorga equivalencia. Certificados ligados a reglas/versiones.
  const c=certificates.find(c=>c.a===a.provider+':'+a.id && c.b===b.provider+':'+b.id);
  if(!c)return {ok:false,reason:'Reglas de ambas plataformas pendientes de verificación'};
  const fields=['event','observationTime','referenceSource','predicate','cancellation','disputeTreatment','payout'];
  if(c.hashA!==fingerprint(a)||c.hashB!==fingerprint(b)||!Number.isFinite(c.expiresAt)||c.expiresAt<=now||!c.reviewedBy ||
    fields.some(k=>typeof c.semanticsA?.[k]!=='string'||!c.semanticsA[k].trim()||c.semanticsA[k]!==c.semanticsB?.[k]))
    return {ok:false,reason:'Certificado incompleto, vencido o reglas modificadas'};
  if(a.currency!==b.currency)return {ok:false,reason:'Monedas distintas: conversión y riesgo de paridad sin validar'};
  return {ok:true,kind:'reviewed-cross-market',reason:'Reglas verificadas y huellas vigentes'};
}
function candidates(kalshi,poly,limit=8) {
  const out=[];
  for(const a of kalshi)for(const b of poly){
    if(!a.title||!b.title||!Number.isFinite(a.closeTime)||!Number.isFinite(b.closeTime)||Math.abs(a.closeTime-b.closeTime)>86400000)continue;
    const similarity=textSimilarity(a.title,b.title);
    if(similarity>=.58)out.push({a,b,similarity});
  }
  return out.sort((a,b)=>b.similarity-a.similarity).slice(0,limit);
}
function fee(fills, schedule) {
  if(!schedule || !Number.isFinite(schedule.rate)||schedule.rate<0||schedule.rate>1||schedule.exponent!==1||![2,5].includes(schedule.precision))return null;
  const raw=fills.reduce((s,f)=>s+f.quantity*schedule.rate*f.price*(1-f.price),0),scale=10**schedule.precision;
  // Redondeo conservador por lote, sin asumir descuentos ni rebates.
  return Math.ceil((raw-1e-12)*scale)/scale;
}
function sweep(levels,quantity,side='buy',limit=side==='buy'?1:0) {
  if(!Number.isFinite(quantity)||quantity<=0||!Array.isArray(levels))return {quantity:0,cash:0,fills:[]};
  const sorted=levels.map(x=>({...x})).sort((a,b)=>side==='buy'?a.price-b.price:b.price-a.price);
  const fills=[];let left=quantity,cash=0;
  for(const level of sorted){
    if(!Number.isFinite(level.price)||level.price<=0||level.price>=1||!Number.isFinite(level.quantity)||level.quantity<=0)continue;
    if(side==='buy'?level.price>limit:level.price<limit)continue;
    const q=Math.min(left,level.quantity);fills.push({price:level.price,quantity:q});cash+=q*level.price;left-=q;if(left<1e-9)break;
  }
  return {quantity:quantity-left,cash,fills};
}
function validBook(book,now){return book&&Number.isFinite(book.at)&&now-book.at<=10000&&book.at<=now&&Array.isArray(book.asks)&&Array.isArray(book.bids);}
function evaluate({a,b,bookA,bookB,certificates=[],capital=50,costReserve=.02,now=Date.now()}) {
  const eq=equivalence(a,b,certificates,now),base={version:VERSION,liveEnabled:false,equivalence:eq,qualified:false};
  const reasons=[];
  if(!eq.ok)reasons.push(eq.reason);
  if(!validBook(bookA,now)||!validBook(bookB,now))reasons.push('Libro ausente, futuro o de más de 10 segundos');
  if(bookA?.market!==a.id||bookB?.market!==b.id||bookA?.side!=='yes'||bookB?.side!=='no')reasons.push('El libro no corresponde al contrato o resultado solicitado');
  if(Math.abs((bookA?.at||0)-(bookB?.at||0))>3000)reasons.push('Cotizaciones separadas por más de 3 segundos');
  if(!Number.isFinite(capital)||capital<=0||!Number.isFinite(costReserve)||costReserve<0)reasons.push('Presupuesto simulado inválido');
  if(!Number.isFinite(a.closeTime)||!Number.isFinite(b.closeTime)||Math.min(a.closeTime,b.closeTime)<=now)reasons.push('Contrato cerrado o sin fecha verificable');
  if(fee([],a.fee)===null||fee([],b.fee)===null)reasons.push('Tarifa de algún contrato no verificada');
  if(![a,b].every(m=>Number.isFinite(m.minNotional)&&m.minNotional>=0&&Number.isFinite(m.minShares)&&m.minShares>=0))reasons.push('Mínimo de orden desconocido');
  if(reasons.length)return {...base,reasons,net:null};
  const depth=x=>x.asks.reduce((s,l)=>s+l.quantity,0);
  const max=Math.min(100,Math.floor(Math.min(depth(bookA),depth(bookB))*.25));
  let best=null;
  for(let quantity=1;quantity<=max;quantity++){
    const x=sweep(bookA.asks,quantity),y=sweep(bookB.asks,quantity);
    if(x.quantity!==quantity||y.quantity!==quantity)continue;
    if(quantity<a.minShares||quantity<b.minShares||x.cash<a.minNotional||y.cash<b.minNotional)continue;
    const fees=fee(x.fills,a.fee)+fee(y.fills,b.fee),cost=x.cash+y.cash+fees+costReserve;
    const net=quantity-cost;
    if(cost>capital)continue;
    if(!best||net>best.net)best={quantity,cost,fees,costReserve,net,gross:quantity-x.cash-y.cash,legA:x,legB:y,
      capitalByProvider:[{provider:a.provider,amount:x.cash+fee(x.fills,a.fee)},{provider:b.provider,amount:y.cash+fee(y.fills,b.fee)}]};
  }
  if(!best)return {...base,reasons:['Profundidad, mínimos o capital insuficientes'],net:null};
  const qualified=best.net>=.02;
  return {...base,...best,qualified,reasons:qualified?[]:['Sin margen neto suficiente'],currency:a.currency,
    note:'Proyección condicionada a ambas ejecuciones; no es beneficio realizado. Reserva operativa supuesta.'};
}
function simulate(plan,a,b,bookA,bookB,now=Date.now()) {
  if(!plan.qualified||!validBook(bookA,now)||!validBook(bookB,now)||bookA.market!==a.id||bookB.market!==b.id||bookA.side!=='yes'||bookB.side!=='no'||Math.abs(bookA.at-bookB.at)>3000||Math.min(a.closeTime,b.closeTime)<=now||fee([],a.fee)===null||fee([],b.fee)===null)return {state:'cancelled',reason:'Plan o libros de comprobación no válidos'};
  const limitA=Math.max(...plan.legA.fills.map(f=>f.price)),limitB=Math.max(...plan.legB.fills.map(f=>f.price));
  const x=sweep(bookA.asks,plan.quantity,'buy',limitA),y=sweep(bookB.asks,plan.quantity,'buy',limitB);
  const covered=Math.min(x.quantity,y.quantity),extraA=x.quantity-covered,extraB=y.quantity-covered;
  const unwindA=sweep(bookA.bids,extraA,'sell'),unwindB=sweep(bookB.bids,extraB,'sell');
  const commissions=fee(x.fills,a.fee)+fee(y.fills,b.fee)+fee(unwindA.fills,a.fee)+fee(unwindB.fills,b.fee);
  const residual=extraA-unwindA.quantity+extraB-unwindB.quantity;
  // Cero valor para contratos sin cobertura que no pudieron venderse: escenario adverso.
  const worstNet=covered+unwindA.cash+unwindB.cash-x.cash-y.cash-commissions-plan.costReserve;
  return {state:residual>1e-8?'unhedged':covered===plan.quantity?'covered':covered>0?'partial':'cancelled',
    covered,filledA:x.quantity,filledB:y.quantity,residual,worstNet,realizedProfit:null,
    note:'Simulación al libro observado tras latencia; no reproduce prioridad de cola ni liquidez oculta.'};
}
module.exports={VERSION,fingerprint,equivalence,candidates,fee,sweep,evaluate,simulate,validBook};
