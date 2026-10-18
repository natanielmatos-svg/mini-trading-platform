'use strict';
require('../src/env');
const fs=require('node:fs'),path=require('node:path'),{parseEnv}=require('node:util');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'datos/executor-demo');
async function main(){
 const env=parseEnv(fs.readFileSync(path.join(root,'.env.demo'),'utf8'));
 for(const k of ['KALSHI_DEMO_API_KEY_ID','KALSHI_DEMO_PRIVATE_KEY_PATH'])if(env[k])process.env[k]=env[k];
 const pilot=require('../src/kalshi-demo-pilot'),f=require('../src/kalshi-execution-preflight'),auth=pilot.credentials();
 const transport=pilot.makeTransport({...auth,environment:'demo'}),snapshot=await f.snapshot(transport);
 const baseline=JSON.parse(fs.readFileSync(path.join(dir,'baseline.json'),'utf8')),ledger=JSON.parse(fs.readFileSync(path.join(dir,'orders.json'),'utf8'));
 const recovery=[];
 for(const r of ledger.orders.filter(r=>r.orderId&&!snapshot.orders.some(o=>o.order_id===r.orderId))){
  try{const response=await transport.read('/portfolio/orders/'+encodeURIComponent(r.orderId));if(response.order?.order_id===r.orderId){snapshot.orders.push(response.order);recovery.push({state:r.state,status:'recovered-directly'});}else recovery.push({state:r.state,status:'unexpected-response'});}catch(e){recovery.push({state:r.state,status:'unavailable',httpStatus:e.httpStatus??null});}
 }
 const report={at:new Date().toISOString(),environment:'demo',executable:false,balanceUSD:snapshot.balance/1e6,openPositions:snapshot.positions.filter(p=>Number(p.position_fp)!==0).length,restingOrders:snapshot.orders.filter(o=>o.status==='resting').length,baselineExpired:snapshot.checkedAt-baseline.startedAt>86400000,reservedUSD:ledger.orders.reduce((s,r)=>s+r.reserved,0)/1e6};
 report.directOrderChecks=recovery;report.orderHistory=snapshot.orderHistory;
 try{report.accounting=f.auditCampaign({snapshot,baseline,ledger,accountId:auth.accountId});}catch(e){report.blocked=true;report.reason=e.message;}
 report.missingOrders=ledger.orders.filter(r=>!snapshot.orders.some(o=>o.order_id===r.orderId)).map(r=>({state:r.state,filled:r.filled??null,cost:r.cost??null,fees:r.fees??null,reservedUSD:r.reserved/1e6,auditedAbsent:r.audit?.reservationRetained===true&&r.audit?.allShardsChecked===true}));
 fs.writeFileSync(path.join(dir,'campaign-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error('Auditoría demo no disponible; no se modificó la cuenta ni el inicio contable.');process.exitCode=1;});
