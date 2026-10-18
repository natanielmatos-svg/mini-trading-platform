const fs=require('node:fs');
let p='src/btc15m-capture.js',s=fs.readFileSync(p,'utf8');
s=s.replace('midpoint:midpoint.summarize(midpointHistory,settlements),','midpoint:midpoint.summarize(midpointHistory,settlements),midpointCalibrationTrial:calibrationTrial.summarize(midpointHistory,settlements),');fs.writeFileSync(p,s);
p='public/learning.js';s=fs.readFileSync(p,'utf8');const marker='   if(data.lagLab){';
const ui=`   if(data.pilot?.midpointCalibrationTrial){const t=data.pilot.midpointCalibrationTrial;body.append(el('h3','Calibración · comparación nueva'),el('p',t.note,'workspace-note'));if(!t.groups.length)body.append(el('p','Sin cierres nuevos evaluados · '+t.pending+' pendientes. Los resultados anteriores no cuentan en esta prueba.'));for(const g of t.groups){body.append(el('p',g.contracts+' contratos compartidos · menor Brier es mejor'));for(const [k,label] of [['raw','Sin calibración'],['calibrated','Calibración actual'],['market','Mercado']]){const m=g.models[k];body.append(el('p',label+': Brier '+m.brier.toFixed(4)+' · '+m.correct+' aciertos'+(k==='market'?'':' · '+m.entries+' entradas teóricas · '+m.abstentions+' abstenciones · neto '+money(m.netBoundUSD))));}}}
`;
if(!s.includes('Calibración · comparación nueva'))s=s.replace(marker,ui+marker);fs.writeFileSync(p,s);
for(const p of ['public/index.html','public/acciones.html']){if(fs.existsSync(p)){const s=fs.readFileSync(p,'utf8');fs.writeFileSync(p,s.replace('/learning.js?v=14','/learning.js?v=15'));}}
