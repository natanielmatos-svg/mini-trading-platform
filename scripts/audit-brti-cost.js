'use strict';
// Read-only reconstruction: one contract, frozen BRTI side, hold to settlement.
const fs=require('node:fs'),path=require('node:path');
const {readJsonl}=require('../src/read-jsonl');
function purchase(book,side){
 if((book?.yes?.[0]?.precio??0)+(book?.no?.[0]?.precio??0)>1.000001)return null;
 const levels=book?.[side==='yes'?'no':'yes'];if(!Array.isArray(levels))return null;
 const sorted=levels.filter(l=>Number.isFinite(l.precio)&&l.precio>0&&l.precio<1&&Number.isFinite(l.cantidad)&&l.cantidad>0).sort((a,b)=>b.precio-a.precio);
 let remaining=1,cost=0;for(const l of sorted){const take=Math.min(remaining,l.cantidad);cost+=take*(1-l.precio);remaining-=take;if(remaining<1e-9)return Number(cost.toFixed(8));}return null;
}
function stats(rows){const valid=rows.filter(r=>r.cost!==null),sum=key=>valid.reduce((n,r)=>n+r[key],0),prices=valid.map(r=>r.cost).sort((a,b)=>a-b),wins=valid.filter(r=>r.won);return {contracts:rows.length,correct:rows.filter(r=>r.won).length,priced:valid.length,excluded:rows.length-valid.length,pricedCorrect:wins.length,averageCost:valid.length?sum('cost')/valid.length:null,medianCost:prices.length?(prices[Math.floor((prices.length-1)/2)]+prices[Math.floor(prices.length/2)])/2:null,totalCost:sum('cost'),payout:wins.length,grossPnl:wins.length-sum('cost'),quoteDiscrepancies:valid.filter(r=>r.quoteDifference!==null&&Math.abs(r.quoteDifference)>.010001).length,unverifiedFees:valid.filter(r=>!r.feesVerified).length,feeScenarios:[0,.01,.02,.03].map(fee=>({assumedFeePerContract:fee,totalFees:fee*valid.length,netPnl:wins.length-sum('cost')-fee*valid.length})),bins:[[0,.5],[.5,.6],[.6,.7],[.7,.8],[.8,.9],[.9,1.000001]].map(([lo,hi])=>{const a=valid.filter(r=>r.cost>=lo&&r.cost<hi);return {from:lo,to:hi,count:a.length,wins:a.filter(r=>r.won).length,grossPnl:a.reduce((n,r)=>n+Number(r.won)-r.cost,0)};})};}
function analyze(file){const samples=[],settlements=new Map();for(const e of readJsonl(file)){if(e.type==='sample'&&e.modelBenchmark)samples.push(e);if(e.type==='settlement')settlements.set(e.ticker,e);}
 const groups=new Map(),seen=new Set();let pending=0,invalid=0;
 for(const s of samples.sort((a,b)=>a.at-b.at)){const b=s.modelBenchmark,id=s.ticker+'|'+b.key;if(b.version!=='kalshi-point-transfer-v1'||seen.has(id))continue;seen.add(id);
  if(b.at!==s.at||s.at>=s.closesAt||['timesfm','localAI','spot','brti'].some(n=>!Number.isFinite(b.prices?.[n])||b.prices[n]<=0)){invalid++;continue;}
  const result=settlements.get(s.ticker);if(!result){pending++;continue;}if(!['finalized','settled'].includes(result.status)||!['yes','no'].includes(result.resultado)||!Number.isFinite(result.at)||result.at<s.closesAt){invalid++;continue;}
  const side=(s.operator==='>='?b.prices.brti>=s.threshold:b.prices.brti>s.threshold)?'yes':'no';
  const fresh=Number.isFinite(s.book?.at)&&s.book.at>=s.requestedAt&&s.book.at<=s.at&&s.at-s.book.at<=10000;
  const cost=fresh?purchase(s.book,side):null,quoted=s.quotes?.[side==='yes'?'yesAsk':'noAsk'];
  const row={ticker:s.ticker,at:s.at,closesAt:s.closesAt,settledAt:result.at,threshold:s.threshold,brti:b.prices.brti,side,result:result.resultado,won:side===result.resultado,bookAt:s.book?.at??null,cost,quotedAsk:Number.isFinite(quoted)?quoted:null,quoteDifference:cost!==null&&Number.isFinite(quoted)?quoted-cost:null,feesVerified:s.feesVerified===true,reason:!fresh?'Book missing or request timestamp invalid':cost===null?'Insufficient recorded depth for one contract':null};
  if(!groups.has(b.key))groups.set(b.key,[]);groups.get(b.key).push(row);
 }
 return {generatedAt:new Date().toISOString(),policy:'One contract per frozen BRTI direction, 10m +/-30s window, held to official settlement. Ask reconstructed from opposite bids. No actual orders or fills.',limitations:['Book timestamps are local request times, not exchange quote timestamps.','Historical fees are not verified; fee scenarios are assumptions, not charged fees.','No execution guarantee, latency slippage or capital constraints simulated.','Each model/version group stays separate.'],pending,invalid,groups:[...groups].map(([key,rows])=>({key,summary:stats(rows),first553:rows.length>=553?{...stats(rows.slice(0,553)),matchesUserCounts:rows.slice(0,553).filter(r=>r.won).length===406,from:new Date(rows[0].at).toISOString(),to:new Date(rows[552].at).toISOString()}:null,rows}))};
}
if(require.main===module){const root=path.join(__dirname,'..'),report=analyze(path.join(root,'datos','piloto-btc15m','events.jsonl')),out=path.join(root,'datos','neural','brti-cost-audit.json');fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,groups:report.groups.map(({rows,...g})=>g)},null,2));}
module.exports={purchase,stats,analyze};
