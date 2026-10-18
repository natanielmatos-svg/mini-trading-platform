'use strict';
const fs=require('node:fs'),path=require('node:path');
const POLICY=Object.freeze({version:'brti-book-lag-v1',movePct:.02,unchangedMid:.005,lookbackMs:10000,entryDelayMs:2000,entryToleranceMs:3000,exitAfterMs:30000,exitToleranceMs:3000,quantity:1});
function quote(row){
 const r=row.index?.value,m=row.market?.value,b=m?.book,at=row.completedAt;
 if(!r?.ok||r.index!=='BRTI'||r.currency!=='USD'||!(r.price>0)||!Number.isFinite(r.at)||r.at>at||at-r.at>5000||at-row.index.receivedAt>5000||!m?.ticker||m.closesAt-at<60000||!b||b.at>at||at-b.at>3000||at-row.market.receivedAt>3000)return null;
 const level=side=>[...(b[side]||[])].filter(x=>x.cantidad>=1&&x.precio>0&&x.precio<1).sort((a,b)=>b.precio-a.precio)[0];
 const y=level('yes'),n=level('no');if(!y||!n||y.precio+n.precio>1)return null;
 return {at,ticker:m.ticker,indexAt:r.at,indexPrice:r.price,yesBid:y.precio,noBid:n.precio,yesAsk:1-n.precio,noAsk:1-y.precio,mid:(y.precio+1-n.precio)/2,fees:m.fees,sellFees:m.sellFees,bookSource:b.source||'rest',referenceReceivedAt:row.index.receivedAt,bookReceivedAt:row.market.receivedAt};
}
function create({dir,now=Date.now}={}){
 let recent=[],pending=[],lastSignal=0,count=0,invalid=0,signals=0,closed=0,missed=0,costed=0,gross=0,net=0,latest=null,error=null;
 const minute={observations:0,incomplete:0,disagreements:0,latest:null,orders:0};
 const file=path.join(dir,'lag-'+new Date(now()).toISOString().replace(/[:.]/g,'-')+'.jsonl');
 function append(e){fs.mkdirSync(dir,{recursive:true});if((fs.existsSync(file)?fs.statSync(file).size:0)>16*1024*1024)throw Error('Límite de registro alcanzado');fs.appendFileSync(file,JSON.stringify(e)+'\n');}
 const fee=(q,action)=>{const f=action==='sell'?q.sellFees:q.fees;return f?.verified&&Number.isFinite(f.upperBound)&&f.upperBound>=0&&Number.isFinite(f.checkedAt)&&f.checkedAt<=q.at&&q.at-f.checkedAt<=10000?f.upperBound:null;};
 function observe(row){try{
  count++;
  const closing=require('./settlement-minute-observation').inspect(row);
  if(closing){minute.latest={...closing};delete minute.latest.book;if(closing.status==='observed'){minute.observations++;if(closing.disagreement)minute.disagreements++;}else minute.incomplete++;append({type:'settlement-minute',...closing});}
  for(const p of pending){const target=p.entry?p.entry.at+POLICY.exitAfterMs:p.signal.at+POLICY.entryDelayMs,tolerance=p.entry?POLICY.exitToleranceMs:POLICY.entryToleranceMs;if(row.completedAt>target+tolerance){p.done=true;missed++;append({type:'abstention',id:p.id,reason:'Ventana vencida sin ejecución observable'});}}
  pending=pending.filter(p=>!p.done);
  const q=quote(row);if(!q){invalid++;return;}
  append({type:'quote',policy:POLICY.version,...q});
  for(const p of pending){
   if(q.ticker!==p.signal.ticker){p.done=true;missed++;append({type:'abstention',id:p.id,reason:'Cambio de contrato'});continue;}
   const target=p.entry?p.entry.at+POLICY.exitAfterMs:p.signal.at+POLICY.entryDelayMs;
   if(q.at<target)continue;
   if(q.at-target>(p.entry?POLICY.exitToleranceMs:POLICY.entryToleranceMs)){p.done=true;missed++;append({type:'abstention',id:p.id,reason:'No hubo libro válido en ventana de ejecución'});continue;}
   if(!p.entry){p.entry=q;p.ask=q[p.side+'Ask'];append({type:'paper-entry',id:p.id,side:p.side,quote:q,ask:p.ask,actualFill:false});}
   else {const bid=q[p.side+'Bid'],g=bid-p.ask,a=fee(p.entry,'buy'),b=fee(q,'sell'),n=a==null||b==null?null:g-a-b;closed++;gross+=g;if(n!=null){costed++;net+=n;}latest={id:p.id,side:p.side,grossUSD:g,netBoundUSD:n,entryAt:p.entry.at,exitAt:q.at};append({type:'paper-exit',...latest,entry:p.entry,exit:q,actualFill:false});p.done=true;}
  }
  pending=pending.filter(p=>!p.done);
  const prior=[...recent].reverse().find(p=>p.ticker===q.ticker&&q.at-p.at>=POLICY.lookbackMs&&q.at-p.at<=POLICY.lookbackMs+3000);
  if(prior&&q.at-lastSignal>=60000&&q.indexAt>prior.indexAt){const move=100*(q.indexPrice/prior.indexPrice-1);
   if(Math.abs(move)>=POLICY.movePct&&Math.abs(q.mid-prior.mid)<=POLICY.unchangedMid){const side=move>0?'yes':'no',id=POLICY.version+'|'+q.ticker+'|'+q.at;lastSignal=q.at;signals++;pending.push({id,side,signal:q});append({type:'signal',id,policy:POLICY,side,movePct:move,prior,signal:q});}
  }
  recent.push(q);recent=recent.filter(p=>q.at-p.at<=20000);
 }catch{error='No se pudo registrar la prueba; observación detenida';}}
 return {observe:row=>{if(!error)observe(row);},snapshot:()=>({policy:POLICY,settlementMinute:minute,samples:count,invalidSamples:invalid,signals,pending:pending.length,closed,missed,costed,grossUSD:closed?gross:null,netBoundUSD:costed?net:null,latest,error,orders:0,actualNetUSD:null,note:'Precios observados, entrada demorada 2s y salida a 30s. No son fills; sólo casos con tarifas verificadas tienen cota neta. El muestreo y los relojes no demuestran causalidad ni ejecución.'})};
}
function createMarketReader(){let cached=null,next=0;return async()=>{
 const now=Date.now();if(now>=next){next=now+10000;cached=null;const {fetchJson}=require('./http');const r=await fetchJson('https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=1000',{timeoutMs:4000,retries:0});if(r.cursor)throw Error('Listado incompleto');const selected=require('./kalshi-threshold').select(r.markets,{symbol:'BTCUSDT',interval:'15m',now:Date.now()});if(selected.contracts.length!==1)throw Error('Contrato ambiguo');const c=selected.contracts[0],m=r.markets.find(m=>m.ticker===c.ticker),feesFor=require('./brti-prospective').feesFor;const [fees,sellFees]=await Promise.all([feesFor(m),feesFor(m,Date.now,'sell')]);cached={ticker:c.ticker,closesAt:c.closesAt,threshold:c.threshold,operator:c.operator,rulesHash:require('node:crypto').createHash('sha256').update(JSON.stringify([m.rules_primary||'',m.rules_secondary||''])).digest('hex'),fees,sellFees};}
 if(!cached)throw Error('Contrato no disponible');return {...cached,book:await require('./kalshi-market-feed').obtener(cached.ticker)};
};}
module.exports={POLICY,quote,create,createMarketReader};
