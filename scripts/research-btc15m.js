'use strict';
// Exploratory counterfactual, NOT a simulated fill ledger or a trading strategy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const bytes=fs.readFileSync(path.join(root,'datos/piloto-btc15m/events.jsonl'));
const events=bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
// La evaluación vive en src/pronosticos.js: este informe y `npm run
// pronosticos` leen los mismos datos y no pueden dar cifras distintas.
const {evaluar}=require('../src/pronosticos');
const {rows,groups,coverage}=evaluar(events);
const report={generatedAt:new Date().toISOString(),inputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
 coverage,groups,rows,
 caveat:'Exploratorio seleccionado después de observar datos; sin validación independiente. Un contrato hipotético al ask anunciado por caso; sin prioridad, latencia ni verificación de fills. Comisión ilustrativa 0.07*p*(1-p) redondeada al céntimo; no tarifa certificada de cuenta/evento. No sumar como beneficio real. El cierre puntual neuronal no equivale al promedio oficial. Muestra pequeña correlacionada.'};
const dir=path.join(root,'datos/diagnosticos','research-'+Date.now());fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'events-snapshot.jsonl'),bytes);fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({dir,coverage:report.coverage,groups},null,2));
