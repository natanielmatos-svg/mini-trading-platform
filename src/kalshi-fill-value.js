'use strict';
// V2 costs are the acquired outcome value (bid=yes, ask=no).
// Closing an existing position receives the complement of that value.
function fillValue(raw,filled,intent,order){
 const notional=Math.round(filled*1e6);
 if(!Number.isSafeInteger(raw)||raw<0||!Number.isSafeInteger(notional)||raw>notional)throw Error('Valor de ejecución inválido');
 const acquired=intent.action==='buy'?intent.side:(intent.side==='yes'?'no':'yes');
 if(order.outcome_side!==undefined&&order.outcome_side!==acquired)throw Error('Resultado de ejecución incompatible');
 return intent.action==='sell'?notional-raw:raw;
}
module.exports={fillValue};
