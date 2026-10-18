'use strict';
// Gate for the actual early-exit policy. A settlement probability alone is insufficient.
function evaluate({intent,market,forecast,verified,now=Date.now()}){
 if(intent.action==='sell')return {allowed:true,reason:'Salida de posición; no depende de ventaja de entrada'};
 const e=forecast?.economicEvidence;
 const block=reason=>({allowed:false,reason,productionValidated:false});
 if(intent.action!=='buy'||!Number.isFinite(intent.price)||intent.price<=0||intent.price>=1||!Number.isInteger(intent.quantity)||intent.quantity<=0)return block('Entrada inválida');
 if(!e||e.prospectivelyValidated!==true||e.policy!=='early-exit-v1')return block('Falta ventaja neta prospectiva validada para la política de salida; acierto o banda no bastan');
 if(e.ticker!==intent.ticker||e.side!==intent.side||e.threshold!==market.floor_strike||e.closesAt!==Date.parse(market.close_time)||e.modelId!==forecast.modelId||!Number.isFinite(e.at)||e.at>now||now-e.at>90000)return block('Evidencia económica caducada o incompatible');
 if(!verified?.feesVerified||!Number.isFinite(verified.feeUpperBound)||verified.feeUpperBound<0)return block('Tarifas de entrada sin verificar');
 for(const k of ['exitFeeUpperBound','slippageReserveUSD','operatingCostUSD','minimumMarginUSD','lowerExpectedProceedsUSD'])if(!Number.isFinite(e[k])||e[k]<0)return block('Costes o incertidumbre económica incompletos');
 if(e.lowerExpectedProceedsUSD>intent.quantity||e.minimumMarginUSD<=0||e.costsVerified!==true)return block('Valor económico o costes no verificables');
 const lowerNetUSD=e.lowerExpectedProceedsUSD-intent.price*intent.quantity-verified.feeUpperBound-e.exitFeeUpperBound-e.slippageReserveUSD-e.operatingCostUSD;
 return {allowed:lowerNetUSD>=e.minimumMarginUSD,lowerNetUSD,reason:lowerNetUSD>=e.minimumMarginUSD?'Margen neto conservador suficiente':'Precio y costes consumen la ventaja',productionValidated:false};
}
module.exports={evaluate};
