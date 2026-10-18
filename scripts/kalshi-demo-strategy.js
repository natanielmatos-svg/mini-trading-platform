'use strict';

// Bounded demo session. No production credentials, web control or scheduled task.

require('../src/env');

const fs=require('node:fs'),path=require('node:path'),{parseEnv}=require('node:util');

const {credentials,create,makeTransport}=require('../src/kalshi-demo-pilot');

const {decide,VERSION}=require('../src/kalshi-demo-strategy');

const directory=path.resolve(__dirname,'../datos/executor-demo');

const execute=process.argv.includes('--execute');

const arg=process.argv.find(x=>x.startsWith('--cycles='));const cycles=arg?Number(arg.split('=')[1]):1;

const pause=ms=>new Promise(r=>setTimeout(r,ms));

async function main(){

 if(!Number.isInteger(cycles)||cycles<1||cycles>20)throw Error('Usa entre 1 y 20 ciclos');

 const env=parseEnv(fs.readFileSync(path.resolve(__dirname,'../.env.demo'),'utf8'));

 for(const k of ['KALSHI_DEMO_API_KEY_ID','KALSHI_DEMO_PRIVATE_KEY_PATH'])if(env[k])process.env[k]=env[k];

 const auth=credentials(),transport=makeTransport({...auth,environment:'demo',role:'bot',allowWrites:execute});

 const pilot=create({directory,transport,accountId:auth.accountId,config:()=>{const limits=require('../src/kalshi-demo-settings').read(),control=require('../src/demo-bot-control').read();return {...limits,paused:limits.paused||control.paused||control.stopRequested};}});

 fs.mkdirSync(directory,{recursive:true});const lock=path.join(directory,'strategy.lock');const fd=fs.openSync(lock,'wx');

 const record=data=>{const row={at:Date.now(),version:VERSION,environment:'demo',execute,productionEnabled:false,...data};fs.appendFileSync(path.join(directory,'strategy-decisions.jsonl'),JSON.stringify(row)+'\n');fs.writeFileSync(path.join(directory,'strategy-status.json'),JSON.stringify(row,null,2));console.log(JSON.stringify(row));};

 try{for(let i=0;i<cycles;i++){

  if(i>0)await pause(15000);

  try{

   let ledger=pilot.executor.snapshot();

   for(const o of ledger.orders.filter(o=>['unknown','pending','acknowledged','resting'].includes(o.state))){const result=await pilot.executor.reconcile(o.clientId);if(['unknown','pending','acknowledged','resting'].includes(result.state))throw Error('Orden pendiente; solo reconciliar, no reenviar');}

   ledger=pilot.executor.snapshot();

   const net=new Map();for(const o of ledger.orders)if(o.filled)net.set(o.intent.ticker,(net.get(o.intent.ticker)||0)+(o.intent.side==='yes'?1:-1)*(o.intent.action==='buy'?1:-1)*o.filled);

   const positions=[...net].filter(([,q])=>q!==0);if(positions.length>1)throw Error('Más de una posición; requiere conciliación');

   let m;

   if(positions.length)m=(await transport.read('/markets/'+encodeURIComponent(positions[0][0]))).market;

   else {const r=await transport.read('/markets?series_ticker=KXBTC15M&status=open&limit=100');m=r.markets.filter(x=>x.status==='active'&&Date.parse(x.close_time)>Date.now()).sort((a,b)=>Date.parse(a.close_time)-Date.parse(b.close_time))[0];}

   if(!m){record({action:'wait',reason:'Sin contrato BTC 15m activo'});continue;}

   const held=positions[0]?.[1]||0;

   const operationControl=require('../src/demo-bot-control').read();

   if(operationControl.stopRequested&&!held){record({action:'stopped',reason:'Detenido sin posición pendiente'});break;}

   let forecast=null,modelSelection=null,selectionReason=null;

   try{

    const events=fs.readFileSync(path.resolve(__dirname,'../datos/piloto-btc15m/events.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));

    const selected=require('../src/kalshi-demo-model-selector').select(events,{market:m});

    forecast=selected.forecast;modelSelection=selected.selection;selectionReason=selected.reason;

    fs.writeFileSync(path.join(directory,'strategy-model-selection.json'),JSON.stringify({at:Date.now(),...selected},null,2));

   }catch{selectionReason='No se pudo verificar evidencia de los tres motores';}

   m=(await transport.read('/markets/'+encodeURIComponent(m.ticker))).market;

   const entry=ledger.orders.find(o=>o.intent.ticker===m.ticker&&o.intent.action==='buy'&&o.filled);

   let decision=decide({environment:'demo',forecast,market:m,held,entryPrice:entry?entry.cost/1e6/entry.filled:null});

   const config=require('../src/kalshi-demo-settings').read();

   if(decision.action==='buy'&&(config.paused||operationControl.paused||operationControl.stopRequested))decision={action:'wait',reason:'Entradas en pausa'};

   if(decision.action==='buy'&&ledger.orders.some(o=>o.intent.ticker===m.ticker&&o.intent.action==='buy'))decision={action:'wait',reason:'Ya hubo un intento de entrada en este contrato'};

   const evidence={modelSelection,selectionReason,ticker:m.ticker,threshold:m.floor_strike,closesAt:Date.parse(m.close_time),forecast,decision,settlementEquivalent:false};

   if(!['buy','sell'].includes(decision.action)){record(evidence);continue;}

   const inspected=await pilot.inspect(m.ticker);

   // Bind the exact supported BRTI >= contract reviewed by the decision function.

   if(execute)await pilot.approveRules(m.ticker,inspected.hash);

   let intent={ticker:m.ticker,side:decision.side,action:decision.action,quantity:decision.quantity,price:decision.price,maxFees:.03,expiresAt:Date.now()+15000};

   const verified=await pilot.verify(intent);intent.maxFees=verified.feeUpperBound;
   const economics=require('../src/kalshi-economic-gate').evaluate({intent,market:m,forecast,verified});
   if(!economics.allowed){record({...evidence,action:'blocked',reason:economics.reason,economics});continue;}


   const reserved=ledger.orders.reduce((n,o)=>n+o.reserved,0)/1e6;

   const amount=decision.action==='buy'?intent.price*intent.quantity+intent.maxFees:intent.maxFees;

   const exitBuffer=decision.action==='buy'?.03:0;

   if(amount>config.maxPerTrade||reserved+amount+exitBuffer>Math.min(config.capital,Math.floor(config.capital*config.maxDailyLossPct)/100)){

    record({...evidence,action:'blocked',reason:'Presupuesto insuficiente incluyendo reserva para salida',reservedUSD:reserved,requiredUSD:amount+exitBuffer});continue;

   }

   const clientId=require('node:crypto').randomUUID();

   record({...evidence,actor:'bot',purpose:'strategy',clientId,action:execute?'submitting':'preview',intent,economics,rulesHash:inspected.hash});

   if(execute){const result=await pilot.submit(intent,{clientId});record({action:'result',clientId:result.clientId,state:result.state,filled:result.filled??0});}

  }catch(e){record({action:'blocked',reason:e.message});}



 }}finally{fs.closeSync(fd);fs.unlinkSync(lock);}

}

main().catch(e=>{console.error(e.message);process.exitCode=1;});

