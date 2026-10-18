'use strict';
const fs=require('node:fs'),path=require('node:path');
const sources=require('./arbitrage-sources'),engine=require('./arbitrage-engine'),registro=require('./registro');
const ROOT=path.join(__dirname,'..','datos','arbitraje');
async function pool(items,work,concurrency=3){
  let next=0;const results=Array(items.length);
  await Promise.allSettled(Array.from({length:Math.min(items.length,concurrency)},async()=>{
    while(next<items.length){const i=next++;try{results[i]=await work(items[i],i);}catch{results[i]={error:'No se pudo verificar la pareja'};}}
  }));return results;
}
function create({adapters=sources,provider='polymarket_us',root=ROOT,clock=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms)),capital=()=>require('./trading-settings').read().capital}={}){
  let busy=false,timer=null,running=false,lastCatalog=0,catalogs={},geo=null,rotation=0,state={status:'waiting',mode:'observation',liveEnabled:false,results:[]};
  const latest=path.join(root,'latest.json');
  function persist(){
    fs.mkdirSync(root,{recursive:true});const temp=latest+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,latest);
    const ruta=path.join(root,new Date(clock()).toISOString().slice(0,10)+'.jsonl');
    if(!registro.anotar({tipo:'arbitrage_scan',...state},{ruta}))throw Error('No se pudo guardar el escaneo');
  }
  async function scan(){
    if(busy)return state;busy=true;const startedAt=clock();
    try{
      const errors=[];
      if(!lastCatalog||clock()-lastCatalog>600000){
        const fetched=await Promise.allSettled(['kalshi',provider].map(p=>adapters.catalog(p)));
        for(let i=0;i<fetched.length;i++){
          const name=['kalshi',provider][i],r=fetched[i];
          catalogs[name]=r.status==='fulfilled'?r.value:null;
          if(r.status==='rejected')errors.push(name+': catálogo no disponible');
        }
        geo=await adapters.eligibility(provider);lastCatalog=clock();
      }
      const kalshi=catalogs.kalshi?.markets||[],poly=catalogs[provider]?.markets||[];
      let certificates=[];
      try{certificates=JSON.parse(fs.readFileSync(path.join(root,'equivalencias.json'),'utf8'));if(!Array.isArray(certificates))throw Error();}
      catch(e){if(e.code!=='ENOENT')throw Error('Certificados de equivalencia dañados');}
      const suggestions=engine.candidates(kalshi,poly,6);
      const pairs=suggestions.flatMap(p=>[{a:p.a,b:p.b,type:'cross',similarity:p.similarity},{a:p.b,b:p.a,type:'cross',similarity:p.similarity}]);
      // Muestreo rotatorio transparente, no se afirma cubrir todo el exchange.
      const own=[];for(let i=0;i<Math.min(8,poly.length);i++){const m=poly[(rotation+i)%poly.length];own.push({a:m,b:m,type:'same'});}rotation+=8;
      pairs.push(...own);
      const budget=capital();
      const results=await pool(pairs,async pair=>{
        const {a,b}=pair,id=a.provider+':'+a.id+'|'+b.provider+':'+b.id;
        const eq=engine.equivalence(a,b,certificates,clock());
        const base={id,type:pair.type,title:a.title,otherTitle:b.title,providers:[a.provider,b.provider],
          urls:[a.url,b.url],outcomes:[a.outcomes[0],b.outcomes[1]],ruleHashes:[a.rulesHash,b.rulesHash],
          ruleReview:{a:{text:a.rules,source:a.resolutionSource,closeTime:a.closeTime,currency:a.currency},b:{text:b.rules,source:b.resolutionSource,closeTime:b.closeTime,currency:b.currency}}};
        const fetched=await Promise.allSettled([adapters.book(a,'yes'),adapters.book(b,'no')]);
        if(fetched.some(r=>r.status!=='fulfilled'))return {...base,at:clock(),qualified:false,reasons:['No se obtuvieron ambos libros recientes'],equivalence:eq,net:null};
        const bookA=fetched[0].value,bookB=fetched[1].value;
        const evaluated=engine.evaluate({a,b,bookA,bookB,certificates,capital:budget,now:clock()});
        const result={...base,...evaluated,at:clock(),bookTimes:[bookA.at,bookB.at]};
        if(evaluated.qualified && Math.max(a.delaySeconds||0,b.delaySeconds||0)>10){
          result.qualified=false;result.reasons=['Retraso de mercado superior al intervalo simulado'];
        } else if(evaluated.qualified){
          // Segunda lectura tras latencia. Nunca enviar órdenes ni consumir saldo real.
          await delay(Math.max(1000,Math.min(10000,Math.max(a.delaySeconds||0,b.delaySeconds||0)*1000)));
          const second=await Promise.allSettled([adapters.book(a,'yes'),adapters.book(b,'no')]);
          if(second.some(r=>r.status!=='fulfilled'))result.simulation={state:'cancelled',reason:'No se pudo volver a leer ambos libros'};
          else{
            result.simulation=engine.simulate(evaluated,a,b,second[0].value,second[1].value,clock());
            // Estrés explícito: desaparece toda la liquidez de la segunda compra.
            result.singleLegStress=engine.simulate(evaluated,a,b,second[0].value,{...second[1].value,asks:[]},clock());
            result.executionSnapshots={initial:[bookA,bookB],afterLatency:second.map(r=>r.value)};
          }
        }
        return result;
      });
      state={version:engine.VERSION,provider,status:errors.length||!catalogs.kalshi||!catalogs[provider]?'degraded':'ready',mode:'observation',liveEnabled:false,
        startedAt,at:clock(),durationMs:clock()-startedAt,errors,eligibility:geo,
        protectedCapitalUSD:budget,realRiskBudgetUSD:0,paperBudget:budget,
        capitalPolicy:'Capital inicial no autorizado para riesgo. Sin ganancias reales verificadas: presupuesto real cero. Escáner sin ejecutor de órdenes.',
        coverage:Object.fromEntries(['kalshi',provider].map(p=>[p,{count:catalogs[p]?.markets.length||0,at:catalogs[p]?.at||null,partial:true,scope:catalogs[p]?.scope||'No disponible'}])),
        crossCandidates:suggestions.length,checked:pairs.length,projectedOpportunities:results.filter(r=>r?.qualified).length,
        results,realizedProfit:null,
        assumptions:'Solo lectura. Máximo 100 pares de contratos por cálculo; 25% de profundidad; reserva supuesta de 0,02 por conjunto. Margen proyectado en moneda nativa. No incluye conversión de capital ni garantiza ejecución.'};
      persist();return state;
    }catch(e){state={...state,status:'error',at:clock(),projectedOpportunities:0,results:[],errors:[e.message],liveEnabled:false};return state;}
    finally{busy=false;}
  }
  function start(){if(running)return;running=true;const tick=async()=>{if(!running)return;await scan();if(running){timer=setTimeout(tick,60000);timer.unref();}};timer=setTimeout(tick,1500);timer.unref();}
  function stop(){running=false;clearTimeout(timer);}
  function snapshot(){
    // Un proceso reiniciado puede mostrar el último escaneo, siempre marcado por edad.
    let data=state;
    if(!data.at){try{const saved=JSON.parse(fs.readFileSync(latest,'utf8'));if(saved.provider===provider)data=saved;}catch{}}
    return {...data,running,busy,stale:!data.at||clock()-data.at>120000,liveEnabled:false};
  }
  return {scan,start,stop,snapshot};
}
let instance;
const get=()=>instance||(instance=create());
module.exports={create,pool,start:()=>get().start(),stop:()=>get().stop(),snapshot:()=>get().snapshot()};
