'use strict';
// Read-only inspection of frozen predictions and artifacts. No orders or backfills.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readJsonl}=require('../src/read-jsonl');
const root=path.join(__dirname,'..'),dir=path.join(root,'datos/diagnosticos');
(async()=>{
 const [learning,lag]=await Promise.all(['/api/learning','/api/kalshi-lag'].map(async p=>{const r=await fetch('http://localhost:3000'+p,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();}));
 const samples=[],settlements=new Map();
 for(const e of readJsonl(path.join(root,'datos/piloto-btc15m/events.jsonl'))){if(e.type==='settlement')settlements.set(e.ticker,e);if(e.midpointProbability?.version==='kalshi-midpoint-450s-v2'&&e.midpointProbability.status==='candidate')samples.push(e);}
 const seen=new Set(),cases=[];
 for(const s of samples){if(seen.has(s.ticker))continue;seen.add(s.ticker);const p=s.midpointProbability,e=s.midpointEconomy,r=settlements.get(s.ticker);
  const raw=fs.readFileSync(path.join(root,'datos/piloto-btc15m/models',p.modelId+'.json'),'utf8'),a=JSON.parse(raw);
  const hashMatches=crypto.createHash('sha256').update(raw).digest('hex')===p.modelId;
  const trainingBeforeCalibration=a.training.every(t=>t.resolvedAt<a.calibration[0].at),allLabelsBeforeDecision=[...a.training,...a.calibration].every(t=>t.resolvedAt<s.requestedAt&&t.ticker!==s.ticker);
  const validResult=r&&['settled','finalized'].includes(r.status)&&['yes','no'].includes(r.resultado)&&r.at>=s.closesAt;
  const net=validResult&&e?.status==='observed'?Number(e.side===r.resultado)-e.ask-e.feeBoundUSD-e.policy.operatingReserveUSD:null;
  const best=side=>Math.max(0,...(s.book?.[side]||[]).filter(l=>Number.isFinite(l.precio)&&l.cantidad>0).map(l=>l.precio));
  const yes=best('yes'),no=best('no'),marketP=s.freshBook&&yes>0&&no>0&&yes+no<=1?(yes+1-no)/2:null;
  cases.push({ticker:s.ticker,at:s.at,secondsRemaining:(s.closesAt-s.at)/1000,modelId:p.modelId,pYes:p.pYes,marketP,training:p.trainingSamples,calibration:p.calibrationSamples,hashMatches,trainingBeforeCalibration,allLabelsBeforeDecision,officialResult:validResult?r.resultado:null,economicSide:e?.side??null,abstentionReason:e?.status==='abstained'?e.reason:null,ask:e?.ask??null,feeBound:e?.feeBoundUSD??null,reserve:e?.policy.operatingReserveUSD??null,netBoundUSD:net});
 }
 const paired=cases.filter(c=>c.officialResult&&Number.isFinite(c.marketP));
 const mean=fn=>paired.length?paired.reduce((n,c)=>n+fn(c),0)/paired.length:null;
 const comparison={cases:paired.length,candidateBrier:mean(c=>(c.pYes-Number(c.officialResult==='yes'))**2),marketBrier:mean(c=>(c.marketP-Number(c.officialResult==='yes'))**2)};
 const report={at:new Date().toISOString(),learningLastRun:learning.lastRun,learningErrors:learning.errors,pilotErrors:learning.pilot?.errors,midpoint:learning.pilot?.midpoint,lag,cases,comparison,artifactFailures:cases.filter(c=>!c.hashMatches||!c.trainingBeforeCalibration||!c.allLabelsBeforeDecision).length};
 fs.mkdirSync(dir,{recursive:true});const jsonFile=path.join(dir,'overnight-audit-'+report.at.replace(/[:.]/g,'-')+'.json');fs.writeFileSync(jsonFile,JSON.stringify(report,null,2));
 const file=path.join(dir,'overnight-profitability-2026-10-07.md');
 if(!fs.existsSync(file))fs.writeFileSync(file,'# Investigación nocturna de rentabilidad\n\nObjetivo: predicción BTC 15m a mitad del bloque. Sin órdenes reales o demo. Fin: 2026-10-07 12:00 UTC. Resultados de entrenamiento separados de predicciones futuras.\n');
 const m=report.midpoint;
 fs.appendFileSync(file,`\n## ${report.at}\n\n- Recolector: última ronda ${new Date(learning.lastRun).toISOString()}; errores ${JSON.stringify(learning.errors)}. Piloto ${JSON.stringify(report.pilotErrors)}.\n- Modelo ${m.version}; ${m.groups.reduce((n,g)=>n+g.contracts,0)} contratos prospectivos evaluados; ${m.pending} pendientes.\n- Economía: ${m.economy.evaluated} casos teóricos; neto con cota de comisiones y reserva ${m.economy.netBoundUSD} USD; caída máxima ${m.economy.maxDrawdownUSD} USD; órdenes ${m.economy.executedOrders}.\n- Artefactos auditados: ${cases.length}; fallos de hash, embargo o etiquetas previas: ${report.artifactFailures}.\n- Retraso (sesión actual): ${lag.closed} recorridos completos; neto teórico ${lag.netBoundUSD} USD; ${lag.invalidSamples}/${lag.samples} muestras inválidas.\n- Evidencia reproducible: ${path.basename(jsonFile)}; ejecutar node scripts/overnight-midpoint-audit.js. Fuentes: GET /api/learning, GET /api/kalshi-lag, events.jsonl y artefactos models de datos/piloto-btc15m.\n- Decisión: continuar la regla congelada, sin rebajar mínimos ni seleccionar variantes con estos resultados. Muestra todavía insuficiente para afirmar rentabilidad; faltan repetición en múltiples condiciones y evidencia de fills. Neto ejecutado no disponible.\n`);
 fs.appendFileSync(file,`- Comparación emparejada con el libro congelado: ${comparison.cases} contratos; Brier candidato ${comparison.candidateBrier}; Brier mercado ${comparison.marketBrier}. Menos es mejor; no seleccionar una nueva regla con esta muestra.\n`);
 const executedTheoretically=cases.filter(c=>Number.isFinite(c.netBoundUSD));
 const total=executedTheoretically.reduce((n,c)=>n+c.netBoundUSD,0);
 const sensitivity={cases:executedTheoretically.length,netBoundUSD:executedTheoretically.length?total:null,extraCostOneCentUSD:executedTheoretically.length?total-.01*executedTheoretically.length:null,extraCostThreeCentsUSD:executedTheoretically.length?total-.03*executedTheoretically.length:null};
 fs.appendFileSync(file,`- Sensibilidad descriptiva, sin cambiar política: ${sensitivity.cases} casos teóricos; neto ${sensitivity.netBoundUSD} USD; con 0,01 USD adicional por caso ${sensitivity.extraCostOneCentUSD} USD; con 0,03 USD adicional ${sensitivity.extraCostThreeCentsUSD} USD. No modela probabilidad de fill ni garantiza ejecución.\n`);
 console.log(JSON.stringify({artifactFailures:report.artifactFailures,totalPredictions:cases.length,latestCases:cases.slice(-2),comparison,sensitivity,learningErrors:learning.errors,report:file}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
