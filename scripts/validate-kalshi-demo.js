'use strict';
// Explicit demo-only CLI. Default invocation checks configuration without submitting orders.
require('../src/env');
const fs=require('node:fs'),path=require('node:path'),{parseEnv}=require('node:util');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'datos/executor-demo');
async function main(){
 const extra=path.join(root,'.env.demo');
 if(fs.existsSync(extra)){
  const parsed=parseEnv(fs.readFileSync(extra,'utf8'));
  for(const name of ['KALSHI_DEMO_API_KEY_ID','KALSHI_DEMO_PRIVATE_KEY_PATH'])if(parsed[name]&&!process.env[name])process.env[name]=parsed[name];
 }
 const mode=process.argv[2]||'check';
 if(!['check','init','inspect','approve-rules','verify','submit','reconcile','cancel'].includes(mode))throw Error('Modo no válido');
 if(mode==='submit')throw Error('Las entradas se envían únicamente mediante el bot de estrategia demo');
 const {credentials,create,makeTransport}=require('../src/kalshi-demo-pilot');
 const auth=credentials(),transport=makeTransport({...auth,environment:'demo',role:mode==='cancel'?'bot':'observer',allowWrites:['submit','cancel'].includes(mode)});
 const pilot=create({directory,config:require('../src/kalshi-demo-settings').read(),transport,accountId:auth.accountId});
 if(mode==='check'){const s=await require('../src/kalshi-execution-preflight').snapshot(transport);return {demoConnected:true,environment:'demo',balanceUSD:s.balance/1e6,ordersSubmitted:0,liveEnabled:false};}
 if(mode==='init')return pilot.initialize();
 if(mode==='inspect')return pilot.inspect(process.argv[3]);
 if(mode==='approve-rules')return pilot.approveRules(process.argv[3],process.argv[4]);
 if(mode==='reconcile')return pilot.executor.reconcile(process.argv[3]);
 if(mode==='cancel')return pilot.executor.cancel(process.argv[3]);
 const intent={ticker:process.argv[3],side:process.argv[4],action:process.argv[5],quantity:Number(process.argv[6]),price:Number(process.argv[7]),maxFees:Number(process.argv[8]),expiresAt:Date.now()+15000};
 if(mode==='verify')return pilot.verify(intent);
 return pilot.submit(intent);
}
main().then(result=>{
 fs.mkdirSync(directory,{recursive:true});const report={at:new Date().toISOString(),environment:'demo',mode:process.argv[2]||'check',result,productionValidated:false};
 fs.writeFileSync(path.join(directory,'last-check.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}).catch(error=>{
 // No provider response bodies, private keys, signatures or key IDs in reports.
 const message=/Faltan KALSHI_DEMO/.test(error.message)?error.message:'Prueba demo bloqueada; revisar configuración, cuenta, reglas y registro local. No validada.';
 fs.mkdirSync(directory,{recursive:true});const report={at:new Date().toISOString(),environment:'demo',blocked:true,message,productionValidated:false};fs.writeFileSync(path.join(directory,'last-check.json'),JSON.stringify(report,null,2),{mode:0o600});console.error(message);process.exitCode=1;
});
