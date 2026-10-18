'use strict';
// Descriptive hypothesis only. Does not estimate probability or submit orders.
function inspect(row){
 const m=row.market?.value,r=row.index?.value,at=row.completedAt;
 if(!m||!r?.ok||r.index!=='BRTI'||r.currency!=='USD'||!Number.isFinite(at)||!Number.isFinite(m.closesAt)||m.closesAt%1000!==0||at<m.closesAt-60000||at>=m.closesAt)return null;
 const base={version:'settlement-minute-observation-v1',at,ticker:m.ticker,closesAt:m.closesAt,threshold:m.threshold,operator:m.operator,rulesHash:m.rulesHash,status:'incomplete'};
 if(!Number.isFinite(m.threshold)||m.threshold<=0||!['>','>='].includes(m.operator)||!m.rulesHash||!Number.isFinite(r.observedAt)||r.observedAt>at||at-r.observedAt>5000||!Number.isFinite(r.at)||r.at>at||at-r.at>5000)return {...base,reason:'Referencia o contrato sin trazabilidad reciente'};
 const end=Math.min(Math.floor(r.at/1000)*1000,m.closesAt-1000),start=m.closesAt-60000,points=new Map();let conflict=false;
 for(const p of r.observedSeconds||[]){if(!Number.isFinite(p.at)||p.at%1000!==0||p.at<start||p.at>end||!Number.isFinite(p.price)||p.price<=0)continue;if(points.has(p.at)&&points.get(p.at)!==p.price)conflict=true;points.set(p.at,p.price);}
 const expected=(end-start)/1000+1;if(expected<1||expected>60||conflict||points.size!==expected)return {...base,knownSeconds:points.size,expectedSeconds:Math.max(0,expected),reason:'Faltan lecturas de origen del minuto; no se interpolan'};
 const sum=[...points.values()].reduce((a,b)=>a+b,0),remaining=60-points.size,meanIfUnchanged=(sum+remaining*r.price)/60;
 const above=p=>m.operator==='>='?p>=m.threshold:p>m.threshold;
 return {...base,status:'observed',referenceAt:r.at,knownSeconds:points.size,remainingSeconds:remaining,knownMean:sum/points.size,requiredRemainingMean:remaining?(60*m.threshold-sum)/remaining:null,meanIfUnchanged,currentPrice:r.price,instantSide:above(r.price)?'yes':'no',constantPriceSide:above(meanIfUnchanged)?'yes':'no',disagreement:above(r.price)!==above(meanIfUnchanged),probability:null,book:row.market.value.book,note:'Escenario si BRTI permaneciera constante; no predicción ni resultado oficial. Validar la ventana exacta con reglas y liquidación.'};
}
module.exports={inspect};
