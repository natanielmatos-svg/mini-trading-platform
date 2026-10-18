'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {create:makeTransport}=require('./kalshi-order-transport'),{create:makeExecutor,fingerprint}=require('./kalshi-executor');
const preflight=require('./kalshi-execution-preflight');
function credentials(env=process.env){
 const keyId=env.KALSHI_DEMO_API_KEY_ID,keyPath=env.KALSHI_DEMO_PRIVATE_KEY_PATH;
 if(!keyId||!keyPath)throw Error('Faltan KALSHI_DEMO_API_KEY_ID y KALSHI_DEMO_PRIVATE_KEY_PATH; no se utilizarán credenciales reales');
 if(keyId===env.KALSHI_API_KEY_ID||(env.KALSHI_PRIVATE_KEY_PATH&&path.resolve(keyPath)===path.resolve(env.KALSHI_PRIVATE_KEY_PATH)))throw Error('Demo requiere credenciales separadas de producción');
 const privateKey=fs.readFileSync(keyPath);
 return {keyId,privateKey,accountId:crypto.createHash('sha256').update(keyId).digest('hex')};
}
function create({directory,config,transport,accountId,clock=Date.now}){
 if(transport.environment!=='demo')throw Error('Este piloto solo admite Kalshi demo');
 const baselineFile=path.join(directory,'baseline.json'),rulesFile=path.join(directory,'rules.json');
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 const baseline=()=>read(baselineFile),approvedRules=()=>{try{return read(rulesFile);}catch(e){if(e.code==='ENOENT')return {};throw e;}};
 let executor;
 const verify=preflight.create({transport,baseline,approvedRules,accountId,ledger:()=>executor.snapshot(),clock});
 executor=makeExecutor({directory,transport,settings:()=>typeof config==='function'?config():config,preflight:verify,enabled:true,clock});
 return {
  executor,
  async initialize(){
   if(executor.snapshot().orders.length)throw Error('Existe registro: no reiniciar contabilidad');
   const state=await preflight.snapshot(transport,clock),start=preflight.flatBaseline(state,accountId);
   fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(baselineFile,JSON.stringify(start,null,2),{flag:'wx',mode:0o600});return {initialized:true,environment:'demo'};
  },
  async inspect(ticker){
   const m=(await transport.read('/markets/'+encodeURIComponent(ticker))).market;
   if(m?.ticker!==ticker||!m.rules_primary)throw Error('Reglas no disponibles');
   return {ticker,hash:preflight.ruleHash(m),rules:m.rules_primary,additionalRules:m.rules_secondary||'',closeTime:m.close_time};
  },
  async approveRules(ticker,hash){
   const m=await this.inspect(ticker);if(m.hash!==hash)throw Error('Las reglas cambiaron');
   const rules=approvedRules();rules[ticker]=hash;fs.writeFileSync(rulesFile,JSON.stringify(rules,null,2),{mode:0o600});return {approved:true,ticker};
  },
  verify,
  submit:async (intent,{clientId=crypto.randomUUID()}={})=>executor.submit(intent,{clientId,confirmedFingerprint:fingerprint(intent)})
 };
}
module.exports={credentials,create,makeTransport};
