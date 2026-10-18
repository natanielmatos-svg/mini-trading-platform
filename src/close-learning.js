'use strict';
const fs=require('node:fs'),path=require('node:path');
const DEFAULT_ROOT=path.join(__dirname,'..','datos','aprendizaje');
const localAI=require('./local-price-ai');
const activity=require('./learning-events');
const MODEL_VERSION=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,'forecast-neural.js'))).update(fs.readFileSync(path.join(__dirname,'..','forecast','worker.py'))).digest('hex').slice(0,16);
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};
// Schedule from round start, not completion; never overlap slow rounds.
function nextDelay(startedAt,finishedAt){return Math.max(5000,30000-Math.max(0,finishedAt-startedAt));}
function create({root=DEFAULT_ROOT,clock=Date.now,getData,predict,getReference,pilot=null,minuteLab=null,asyncPersistence=false}={}){
  const file=path.join(root,'state.json');let timer,busy=false,running=false;
  const encodeState=require('./learning-state-encoding').createEncoder();
  let state={version:1,mode:'shadow',targets:[{symbol:'BTCUSDT',interval:'15m'},{symbol:'ETHUSDT',interval:'15m'}],blocks:[],lastRun:null,errors:[]};
  try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version!==1||!Array.isArray(saved.blocks)||!Array.isArray(saved.targets))throw Error('Registro de aprendizaje inválido');state=saved;}catch(e){if(e.code!=='ENOENT')throw e;}
  const writer=asyncPersistence?require('./async-state-writer').createWriter({file,encode:()=>encodeState(state)}):null;
  function save(){if(writer){writer.request();return;}fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file+'.tmp',encodeState(state));fs.renameSync(file+'.tmp',file);}
  function watch(target){
    if(!/^[A-Z0-9]{2,20}$/.test(target.symbol)||!['1m','5m','15m','30m','1h','4h','12h','1d','1w'].includes(target.interval))return;
    if(state.targets.some(t=>t.symbol===target.symbol&&t.interval===target.interval))return;
    if(state.targets.length>=12)return;
    state.targets.push({symbol:target.symbol,interval:target.interval});save();
  }
  function ingest(target,data,reference=null,forecast=null){
    let changed=false;
    const now=clock(),source=data.source||data.fuente;
    if(String(source).includes('demo'))return;
    const venues=(data.consolidado?.venues||[]).filter(v=>v.usado).map(v=>v.id).sort();
    const unit=source==='consolidado'?'USD':'USDT';
    const group=JSON.stringify([target.symbol,target.interval,source,venues]);
    // Las etiquetas se fijan al ver una vela cerrada. No reescribir el pasado.
    for(const b of state.blocks.filter(b=>b.group===group&&b.actual==null)){
      const c=data.candles.find(c=>c.closeTime+1===b.closesAt&&c.closed!==false&&c.closeTime<now);
      if(!c||!Number.isFinite(c.close)||c.close<=0)continue;
      changed=true;
      b.actual=c.close;b.resolvedAt=now;b.realized={open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume,returnPct:c.open>0?(c.close/c.open-1)*100:null,rangePct:c.open>0?(c.high-c.low)/c.open*100:null};
      if(b.prediction){b.error=b.prediction.raw-b.actual;b.baselineError=Math.abs(b.prediction.baseline-b.actual);b.candidateError=Math.abs(b.prediction.candidate-b.actual);}
      b.closeProvenance=c.provenance||null;
      for(const p of b.localPredictions||[]){p.absoluteError=Math.abs(p.price-b.actual);p.baselineError=Math.abs(p.baseline-b.actual);p.rawError=Number.isFinite(p.rawNeural)?Math.abs(p.rawNeural-b.actual):null;}
      fs.mkdirSync(root,{recursive:true});fs.appendFileSync(path.join(root,'closed-'+new Date(now).toISOString().slice(0,10)+'.jsonl'),JSON.stringify(b)+'\n');
      activity.publish({...target,stage:'close',state:'done'});
    }
    const current=data.candles.at(-1);
    if(!current||current.openTime>now||current.closeTime<now){if(changed)save();return;}
    let block=state.blocks.find(b=>b.group===group&&b.closesAt===current.closeTime+1);
    if(!block){block={group,symbol:target.symbol,interval:target.interval,source,venues,unit,opensAt:current.openTime,closesAt:current.closeTime+1,actual:null,observations:[]};state.blocks.push(block);changed=true;}
    if(Number.isFinite(current.close)&&current.close>0&&(!block.observations.length||now-block.observations.at(-1).at>=30000)){
      changed=true;
      const ref=reference?.ok&&Number.isFinite(reference.price)&&reference.price>0&&reference.at<=now&&now-reference.at<=15000?{price:reference.price,at:reference.at,index:reference.index}:null;
      block.observations.push({at:now,snapshotAt:data.fetchedAt??null,price:current.close,open:current.open,high:current.high,low:current.low,volume:current.volume,reference:ref,basisPct:ref&&unit==='USD'?(current.close/ref.price-1)*100:null,comparison:'snapshot de vela frente a índice instantáneo; no liquidación'});
      block.observations=block.observations.slice(-1440);
      block.observations.at(-1).provenance=current.provenance||null;
      const observation=block.observations.at(-1),bucket=localAI.phase(block,observation);
      block.localPredictions??=[];
      if(target.symbol==='BTCUSDT'&&target.interval==='15m'&&!block.localPredictions.some(p=>p.version===localAI.VERSION&&p.phase===bucket)){
        const proposal=localAI.propose(block,observation,state.blocks);
        if(proposal){const modelDir=path.join(root,'models');fs.mkdirSync(modelDir,{recursive:true});fs.writeFileSync(path.join(modelDir,proposal.modelId+'.json'),JSON.stringify(proposal.model));delete proposal.model;block.localPredictions.push(proposal);activity.publish({...target,stage:'local',state:'done'});}
      }
    }
    if(!block.prediction&&forecast?.ok&&!forecast.demo&&forecast.closesAt===block.closesAt&&forecast.generatedAt<=now&&now<block.closesAt&&Number.isFinite(forecast.estimatedClose)&&forecast.estimatedClose>0&&Number.isFinite(forecast.baseline?.price)&&forecast.baseline.price>0){
      const version=forecast.modelId+'|'+MODEL_VERSION;
      changed=true;
      const history=state.blocks.filter(b=>b.group===group&&b.actual>0&&b.resolvedAt<forecast.generatedAt&&b.prediction?.version===version&&Number.isFinite(b.error)).slice(-100);
      const correction=history.length>=30?median(history.map(b=>-b.error/b.prediction.raw)):0;
      // Candidato congelado antes del resultado; límite de 1% evita correcciones explosivas.
      const bounded=Math.max(-.01,Math.min(.01,correction));
      block.prediction={at:forecast.generatedAt,version,raw:forecast.estimatedClose,baseline:forecast.baseline.price,candidate:forecast.estimatedClose*(1+bounded),correctionPct:bounded*100,trainingSamples:history.length,active:false};
    }
    if(changed){state.blocks=state.blocks.slice(-10000);save();}
  }
  function snapshot(){
    const localGroups=[];
    for(const group of new Set(state.blocks.map(b=>b.group))){for(let phase=0;phase<4;phase++){
      const blocks=state.blocks.filter(b=>b.group===group),predictions=blocks.flatMap(b=>(b.localPredictions||[]).filter(p=>p.version===localAI.VERSION&&p.phase===phase));
      if(!predictions.length)continue;const scored=predictions.filter(p=>Number.isFinite(p.absoluteError)),paired=scored.filter(p=>Number.isFinite(p.rawError));
      const mean=(rs,k)=>rs.length?rs.reduce((s,r)=>s+r[k],0)/rs.length:null;
      const baselinePaired=scored.filter(p=>Number.isFinite(p.baselineError));
      localGroups.push({group,phase,samples:scored.length,pendingSamples:predictions.length-scored.length,missingNeuralSamples:scored.filter(p=>!Number.isFinite(p.rawNeural)).length,baselineSamples:baselinePaired.length,baselineLocalMae:mean(baselinePaired,'absoluteError'),baselineObservedMae:mean(baselinePaired,'baselineError'),mae:mean(scored,'absoluteError'),baselineMae:mean(scored,'baselineError'),rawPairedSamples:paired.length,rawPairedMae:mean(paired,'rawError'),localPairedMae:mean(paired,'absoluteError'),baselinePairedMae:mean(paired,'baselineError'),latest:predictions.at(-1)});
    }}
    const groups=[...new Set(state.blocks.map(b=>b.group))].map(group=>{
      const rows=state.blocks.filter(b=>b.group===group),scored=rows.filter(b=>Number.isFinite(b.error)&&b.prediction?.version?.endsWith('|'+MODEL_VERSION)),candidates=scored.filter(b=>b.prediction.trainingSamples>=30);
      const mean=(rs,fn)=>rs.length?rs.reduce((s,r)=>s+fn(r),0)/rs.length:null;
      return {symbol:rows[0].symbol,interval:rows[0].interval,source:rows[0].source,venues:rows[0].venues,version:MODEL_VERSION,lastObservation:rows.at(-1).observations.at(-1)||null,closed:rows.filter(b=>b.actual!=null).length,scored:scored.length,mae:mean(scored,b=>Math.abs(b.error)),baselineMae:mean(scored,b=>b.baselineError),candidateSamples:candidates.length,candidateMae:mean(candidates,b=>b.candidateError),pairedRawMae:mean(candidates,b=>Math.abs(b.error)),pairedBaselineMae:mean(candidates,b=>b.baselineError)};
    });
    return {minuteLab:minuteLab?.snapshot()||null,pilot:pilot?.snapshot()||null,localAI:{version:localAI.VERSION,mode:'shadow',promotionAllowed:false,groups:localGroups},mode:'shadow',liveEnabled:false,activeModelChanged:false,lastRun:state.lastRun,targets:state.targets,groups,errors:state.errors,retainedBlocks:state.blocks.length,note:'Aprende sesgo con cierres anteriores y evalúa un candidato separado. No reentrena TimesFM ni modifica órdenes. Cierres reconstruidos de cada fuente; no liquidación Kalshi.'};
  }
  async function tick(){
    if(busy)return;busy=true;state.errors=[];
    try{for(const target of [...state.targets]){
      try{
        activity.publish({...target,stage:'receive',state:'start'});
        const data=await getData(target);const ref=await getReference(target).catch(()=>null);
        activity.publish({...target,stage:'receive',state:'done'});
        ingest(target,data,ref);
        const current=data.candles.at(-1);
        const exists=state.blocks.some(b=>b.symbol===target.symbol&&b.interval===target.interval&&b.closesAt===current?.closeTime+1&&b.prediction);
        if(!exists){activity.publish({...target,stage:'neural',state:'start'});const forecast=await predict({...data,...target,source:data.source||data.fuente});ingest(target,data,ref,forecast);activity.publish({...target,stage:'neural',state:forecast?.ok?'done':'error'});}
      }catch{activity.publish({...target,stage:'receive',state:'error'});activity.publish({...target,stage:'neural',state:'error'});state.errors.push(target.symbol+' '+target.interval+': no se pudo completar el muestreo');}
    }
    if(pilot){try{await pilot.tick(state.blocks);}catch{state.errors.push('No se pudo persistir el piloto BTC15m');}}
    if(minuteLab)await minuteLab.tick();
    state.lastRun=clock();save();if(writer)await writer.flush();}finally{busy=false;}
  }
  function start(){if(running)return;running=true;const loop=async()=>{const startedAt=clock();try{await tick();}catch{state.errors=['No se pudo persistir aprendizaje'];}finally{if(running){timer=setTimeout(loop,nextDelay(startedAt,clock()));timer.unref?.();}}};timer=setTimeout(loop,5000);timer.unref?.();}
  function stop(){running=false;clearTimeout(timer);return writer?.flush();}
  return {watch,ingest,snapshot,tick,start,stop};
}
module.exports={create,nextDelay};
