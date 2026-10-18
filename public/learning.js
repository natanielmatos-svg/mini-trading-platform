'use strict';
(()=>{
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
 const metricas=(host,pares)=>{const g=el('div',null,'learning-metrics');for(const [label,value] of pares){const b=el('div');const t=String(value);b.append(el('span',label),el('strong',t==='Sin resultados'||t==='Pendiente'?'—':t));g.append(b);}host.append(g);return g;};
 const money=n=>Number.isFinite(n)?n.toLocaleString('es-ES',{maximumFractionDigits:2})+' USD':'Sin resultados';
 function init(){
  const host=document.querySelector('.side-panel');if(!host)return;
  const card=el('section',null,'card');card.dataset.tarjeta='aprendizaje';
  card.append(el('p','LABORATORIO LOCAL · EVALUACIÓN SIN ÓRDENES','workspace-eyebrow'),el('h2','Progreso de la IA'));
  const status=el('p','Consultando recolector…'),filters=el('div',null,'learning-filters');
  const select=el('select');select.setAttribute('aria-label','Activo y bloque del aprendizaje');
  const phase=el('select');phase.setAttribute('aria-label','Momento de la predicción');
  ['Inicio · 0–25% del bloque','25–50% del bloque','50–75% del bloque','75–100% del bloque'].forEach((text,i)=>{const o=el('option',text);o.value=i;phase.append(o);});
  filters.append(select,phase);const body=el('div');card.append(status,filters);const activity=LearningActivity.mount(card);card.append(body);host.append(card);
  let data=null,busy=false;
  function render(){pintar();agrupar();}
  // Las secciones se escriben planas (h3 + párrafos). Agruparlas después en
  // tarjetas evita repetir el envoltorio catorce veces y cubre las que se
  // añadan más adelante sin tocarlas.
  function agrupar(){
   const hijos=[...body.children];if(!hijos.some(n=>n.tagName==='H3'))return;
   const salida=[];let bloque=null;
   for(const n of hijos){if(n.tagName==='H3'){bloque=el('section',null,'learning-block');salida.push(bloque);}bloque?bloque.append(n):salida.push(n);}
   body.replaceChildren(...salida);
   for(const b of body.querySelectorAll('.learning-block'))plegar(b);
  }
  // La prosa explicativa pesaba lo mismo que el dato. Las notas largas se
  // pliegan; las cortas suelen llevar cifras y se quedan a la vista.
  function plegar(bloque){
   const largas=[...bloque.querySelectorAll(':scope > p.workspace-note')].filter(n=>n.textContent.length>120);
   if(!largas.length)return;
   const d=el('details',null,'workspace-help');d.append(el('summary','Cómo se calcula'));
   for(const n of largas)d.append(n);
   bloque.append(d);
  }
  function pintar(){
   const disclosures=[...body.querySelectorAll('details')].map(d=>d.open);body.replaceChildren();if(!data)return;activity.update(data,select.value,Number(phase.value));queueMicrotask(()=>body.querySelectorAll('details').forEach((d,i)=>{if(disclosures[i])d.open=true;}));
   const stale=!data.lastRun||Date.now()-data.lastRun>300000;
   status.textContent=(stale?'Sin ronda reciente':data.errors?.length?'Recolección con incidencias':'Recolector activo')+' · '+(data.lastRun?new Date(data.lastRun).toLocaleString('es-ES'):'esperando primera ronda');
   if(data.pilot?.midpoint){const m=data.pilot.midpoint,p=m.latest,e=m.economy;body.append(el('h3','Prueba principal · predecir a mitad del bloque'),el('p','BTC 15m · pronóstico congelado a los 7:30 (±30 segundos), usando sólo datos conocidos entonces.','workspace-note'),el('p',p?.status==='candidate'?'Probabilidad SÍ: '+(100*p.pYes).toFixed(1)+'% · experimental':p?.reason||'Esperando la próxima mitad de bloque para emitir el primer pronóstico.'),el('p',m.historicalContracts+' contratos históricos con datos comparables · '+(p?.trainingSamples??0)+' de ajuste · '+(p?.calibrationSamples??0)+' de calibración.','workspace-note'));
    for(const g of m.groups)body.append(el('p',g.contracts+' pronósticos futuros evaluados · '+g.correct+' aciertos · Brier '+g.brier.toFixed(4)+' · BRTI: '+g.brtiCorrect+' aciertos sobre los mismos contratos.'));
    body.append(el('p',e.evaluated+' operaciones teóricas evaluadas · '+e.pending+' pendientes · '+e.abstentions+' abstenciones · resultado tras cota de comisiones y reserva: '+money(e.netBoundUSD)),el('p',m.note,'workspace-note'));
   }
   if(data.pilot?.midpointCalibrationTrial){const t=data.pilot.midpointCalibrationTrial;body.append(el('h3','Calibración · comparación nueva'),el('p',t.note,'workspace-note'));if(!t.groups.length)body.append(el('p','Sin cierres nuevos evaluados · '+t.pending+' pendientes. Los resultados anteriores no cuentan en esta prueba.'));for(const g of t.groups){body.append(el('p',g.contracts+' contratos compartidos · menor Brier es mejor'));for(const [k,label] of [['raw','Sin calibración'],['calibrated','Calibración actual'],['market','Mercado']]){const m=g.models[k];body.append(el('p',label+': Brier '+m.brier.toFixed(4)+' · '+m.correct+' aciertos'+(k==='market'?'':' · '+m.entries+' entradas teóricas · '+m.abstentions+' abstenciones · neto '+money(m.netBoundUSD))));}}}
   if(data.pilot?.midpointPriceTrial){const t=data.pilot.midpointPriceTrial;body.append(el('h3','Prueba nueva · entradas de 0,25 a menos de 0,50 USD'),el('p',t.note,'workspace-note'));if(!t.groups.length)body.append(el('p','Esperando capturas nuevas; el histórico anterior no cuenta.'));for(const g of t.groups){body.append(el('p',g.entries+'/100 entradas evaluadas · '+g.observedDays+'/7 días · '+g.pending+' pendientes · '+g.abstentions+' abstenciones'),el('p','Neto teórico: '+money(g.netUSD)+' · con peor ejecución: '+money(g.stressNetUSD)+' · caída máxima: '+money(g.maxDrawdownUSD)));if(g.entries)body.append(el('p','Ganaron '+g.wins+'/'+g.entries+' · probabilidad media estimada '+(g.meanPredictedWin*100).toFixed(1)+'% · Brier modelo '+g.brier.toFixed(4)+' / mercado '+g.marketBrier.toFixed(4)));if(g.reviewDue)body.append(el('p','Punto de revisión alcanzado. No autoriza operaciones.'));}}
   if(data.pilot?.marketResidualTrial){const t=data.pilot.marketResidualTrial;body.append(el('h3','Candidato · corrección del mercado'),el('p','Parte de Kalshi y estima su error histórico por tramo de probabilidad. Sólo evaluación futura; sin órdenes.','workspace-note'));if(!t.groups.length)body.append(el('p',t.latest?.reason||'Esperando capturas nuevas.'));for(const g of t.groups)body.append(el('p',g.contracts+' contratos nuevos · '+g.pending+' pendientes · Brier candidato '+(g.brier?.toFixed(4)??'—')+' / mercado '+(g.marketBrier?.toFixed(4)??'—')),el('p',g.entries+' entradas teóricas · '+g.abstentions+' abstenciones · neto '+money(g.netUSD)+' · con peor ejecución '+money(g.stressNetUSD)));}
   if(data.lagLab){const p=data.lagLab;body.append(el('h3','Prueba de retraso · BRTI frente a Kalshi'),el('p',p.sampler?.running?'Observación activa':'Observación detenida'));metricas(body,[['Muestras',p.samples],['Señales',p.signals],['Recorridos completos',p.closed],['Ventanas no ejecutables',p.missed]]);
    body.append(el('p','Resultado bruto teórico: '+money(p.grossUSD)+' · cota neta: '+money(p.netBoundUSD)+' sobre '+p.costed+' casos con tarifas verificadas · '+p.pending+' pendientes.','workspace-note'),el('p',p.note,'workspace-note'));if(p.error)body.append(el('p',p.error,'warning'));
   }
   if(data.lagLab?.settlementMinute){const m=data.lagLab.settlementMinute,p=m.latest;body.append(el('h3','Último minuto · promedio frente al precio'));metricas(body,[['Observaciones completas',m.observations],['Incompletas',m.incomplete],['Discrepancias de lado',m.disagreements]]);body.append(el('p','Son muestras, no operaciones.','workspace-note'));if(p?.status==='observed')body.append(el('p',p.knownSeconds+' de 60 lecturas · promedio si el precio no cambiara: '+money(p.meanIfUnchanged)+' · promedio futuro necesario para la meta: '+money(p.requiredRemainingMean)),el('p',p.note,'workspace-note'));else body.append(el('p',p?.reason||'Esperando el último minuto del contrato. No emite órdenes.','workspace-note'));}
   if(data.pilot?.motionCandidate){const m=data.pilot.motionCandidate,c=data.pilot.featureCollection,p=m.latest;
    body.append(el('h3','Nuevo modelo de IA · BRTI y libro de Kalshi'),el('p',p?.status==='candidate'?'Estimación SÍ: '+(100*p.pYes).toFixed(1)+'% · experimental':p?.reason||'Esperando capturas nuevas con movimientos completos.'));
    body.append(el('p',(c?.samples??0)+' capturas nuevas · '+(c?.complete60sSamples??0)+' con cobertura completa de 60 segundos · '+(p?.trainingSamples??0)+' contratos de ajuste / 60 · '+(p?.calibrationSamples??0)+' de calibración / 20.','workspace-note'));
    for(const g of m.groups)body.append(el('p',g.evaluated+' predicciones futuras evaluadas · '+g.pending+' pendientes · Brier candidato: '+(g.brier==null?'Sin resultados':g.brier.toFixed(4))+' · mercado, mismos contratos: '+(g.marketBrier==null?'Sin resultados':g.marketBrier.toFixed(4))));
    body.append(el('p',m.note,'workspace-note'));
   }
   if(data.pilot?.loadingHistory)body.append(el('h3','Piloto BTC · Kalshi 15 minutos'),el('p',data.pilot.historyError||'Recuperando el histórico del piloto… Los resultados aparecerán al terminar.','workspace-note'));
   if(data.pilot&&!data.pilot.loadingHistory){const p=data.pilot;body.append(el('h3','Piloto BTC · Kalshi 15 minutos'));metricas(body,[['Capturas',p.samples],['Con predicción previa',p.joinedSamples],['Contratos liquidados',p.resolvedContracts],['En la ventana de evaluación',p.fixedWindowSamples]]);body.append(el('p','Última captura/ronda: '+(p.lastRun?new Date(p.lastRun).toLocaleString('es-ES'):'pendiente')+'. Beneficio neto: no disponible; sólo observación.','workspace-note'));for(const error of p.errors||[])body.append(el('p',error,'warning'));}
   if(data.pilot?.probability){const p=data.pilot.probability,f=p.latest;body.append(el('h3','Probabilidad de liquidación · candidato local'),el('p',f?.status==='candidate'?'Probabilidad SÍ: '+(f.pYes*100).toFixed(1)+'% · calibración experimental, sin validar.':(f?.reason||'Esperando la próxima ventana de 10 minutos para evaluar datos disponibles.')),el('p',(f?.trainingSamples??0)+' contratos de entrenamiento · '+(f?.calibrationSamples??0)+' de calibración · '+p.evaluatedContracts+' predicciones futuras evaluadas.','workspace-note'));if(p.evaluatedContracts)body.append(el('p','Brier candidato: '+p.brier.toFixed(4)+' · Kalshi: '+p.marketBrier.toFixed(4)+' (menos es mejor; mismos contratos).'));for(const c of p.filter?.candidates||[])body.append(el('p',(c.side==='yes'?'SÍ':'NO')+' · margen estimado por contrato: '+money(c.estimatedNetUSD)+' · '+(c.passesIllustrativeMargin?'supera margen ilustrativo':'no supera margen ilustrativo')));body.append(el('p',p.filter?.reason||'No hay señal ejecutable: costes y ventaja prospectiva pendientes.','workspace-note'));}
   if(data.pilot?.probability)body.append(el('p',data.pilot.probability.availableContracts+' contratos históricos con variables y etiqueta disponibles. Mínimo inicial: '+data.pilot.probability.minimum+' comparables; las versiones se separan al entrenar.','workspace-note'));
   if(data.marketFeed||data.feePolicy)body.append(el('h3','Conexión y tarifas'));
   if(data.marketFeed){const f=data.marketFeed;body.append(el('p','Libro Kalshi: '+(f.bookReady?'WebSocket · datos recientes':f.connected?'WebSocket conectado · esperando libro reciente; respaldo REST':'Respaldo REST')+' · '+(f.sequenceGaps||0)+' discontinuidades detectadas.','workspace-note'));if(f.error)body.append(el('p',f.error,'warning'));}
   if(data.feePolicy)body.append(el('p','Tarifas: '+(data.feePolicy.valid?'fórmula revisada':'revisión vencida · entradas bloqueadas')+' · próxima revisión '+new Date(data.feePolicy.reviewBy).toLocaleString('es-ES')+'. Los multiplicadores se verifican al consultar.','workspace-note'));
   if(data.pilot?.brtiProspective){
    const p=data.pilot.brtiProspective;
    body.append(el('h3','Prueba económica BRTI · prospectiva'),el('p','BTC 15m · señal a 10 minutos ±30 s del cierre · un contrato teórico · mantener hasta liquidación oficial.','workspace-note'));
    metricas(body,[['Evaluados',p.evaluated],['Pendientes',p.pending],['Abstenciones',p.abstentions],['Resultado teórico tras cota de comisiones',money(p.netBoundUSD)],['Cota de comisiones',money(p.feeBoundUSD)],['Caída máxima teórica',money(p.maxDrawdownUSD)],['Órdenes de esta prueba',p.executedOrders],['Beneficio ejecutado',money(p.actualNetUSD)]]);body.append(el('p',p.note,'workspace-note'));
    if(p.latest)body.append(el('p','Última decisión: '+p.latest.ticker+' · '+new Date(p.latest.at).toLocaleString('es-ES')+' · '+p.latest.reason));
    const details=el('details');details.append(el('summary','Precios y resultados por contrato'));
    for(const r of p.recent)details.append(el('p',r.ticker+' · '+r.side.toUpperCase()+' · entrada al libro '+money(r.entryPriceUSD)+' · cota de comisión '+money(r.feeBoundUSD)+' · resultado teórico '+money(r.netBoundUSD)));
    body.append(details);
   }
   if(data.pilot?.modelBenchmark){
    const b=data.pilot.modelBenchmark;
    body.append(el('h3','Comparación frente a la meta de Kalshi · BTC 15m'));
    body.append(el('p','Los cuatro modelos y referencias se evalúan sobre los mismos contratos, con estimaciones anteriores al cierre. Acertar el lado no significa acertar el precio exacto ni obtener beneficio.','workspace-note'));
    if(!b.groups.length)body.append(el('p','Sin contratos comparables evaluados todavía. Los pendientes no cuentan como fallos.'));
    for(const g of b.groups){
     body.append(el('p',g.contracts+' contratos compartidos · estimación congelada 10 minutos antes del cierre','workspace-note'));
     const grid=el('div',null,'learning-model-grid');
     for(const [name,label,type] of [['timesfm','TimesFM','Modelo neuronal'],['localAI','IA local','Modelo entrenado localmente'],['spot','Mantener consolidado','Referencia sencilla'],['brti','Mantener BRTI','Referencia del índice']]){
      const result=g.models?.[name],valid=Number.isFinite(result?.accuracy)&&g.contracts>0,hits=valid?Math.round(result.accuracy*g.contracts):null;
      const tile=el('section',null,'learning-model-card');tile.append(el('p',type,'workspace-eyebrow'),el('h4',label),el('strong',valid?(100*result.accuracy).toFixed(1)+'%':'—','learning-model-score'),el('p','Tasa de acierto','workspace-note'));
      const list=el('dl');for(const [title,value] of [['Aciertos',hits??'Sin resultados'],['Fallos',valid?g.contracts-hits:'Sin resultados'],['Evaluados',g.contracts],['Error medio del precio',money(result?.maeUSD)]]){const row=el('div');row.append(el('dt',title),el('dd',String(value)));list.append(row);}tile.append(list);grid.append(tile);
     }
     body.append(grid);
     const detail=el('details');detail.append(el('summary','Metodología, muestra y versiones'));
     detail.append(el('p',g.numericContracts+' contratos con precio oficial numérico. Grupo y versiones: '+g.key,'workspace-note'));body.append(detail);
    }
    body.append(el('p',b.pending+' pendientes de resultado oficial · '+b.invalid+' registros excluidos.','workspace-note'),el('p',b.note,'workspace-note'));
   }
   if(data.pilot?.ablation){
    const a=data.pilot.ablation;body.append(el('h3','¿TimesFM aporta mejora? · comparación prospectiva'),el('p','Tres candidatos entrenados y calibrados sobre las mismas muestras; sólo se puntúan predicciones guardadas antes del resultado.','workspace-note'));
    if(!a.groups.length)body.append(el('p','Comparación iniciada. Esperando cierres nuevos; no se rellenan aciertos históricos.'));
    for(const g of a.groups){const grid=el('div',null,'learning-model-grid');for(const [key,label] of [['full','Híbrido completo'],['without-timesfm','Sin TimesFM'],['brti-only','BRTI + tiempo']]){const m=g.models[key],tile=el('section',null,'learning-model-card');tile.append(el('h4',label),el('strong',(m.accuracy*100).toFixed(1)+'%','learning-model-score'),el('p',m.correct+' / '+g.cases+' aciertos'),el('p','Brier: '+m.brier.toFixed(4)),el('p','Ventaja neta: no validada','workspace-note'));grid.append(tile);}body.append(grid);}
    body.append(el('p',a.note,'workspace-note'));
   }
   if(data.pilot?.hybrid){
    const h=data.pilot.hybrid,p=h.latest;
    body.append(el('h3','Candidato híbrido · objetivo Kalshi'),el('p','Combina TimesFM, BRTI, distancia a la meta, movimiento y rango observados dentro del bloque, y tiempo restante. BTC 15m · evaluación a 10 minutos del cierre.','workspace-note'));
    body.append(el('p',p?.status==='candidate'?'Estimación SÍ: '+(p.pYes*100).toFixed(1)+'% · experimental, aún no validada.':p?.reason||'Esperando la próxima captura de evaluación.'));
    body.append(el('p',(p?.trainingSamples??0)+' contratos de ajuste · '+(p?.calibrationSamples??0)+' de calibración · mínimo inicial 60 + 20; sólo datos con trazabilidad.','workspace-note'));
    if(!h.groups.length)body.append(el('p','Sin predicciones futuras evaluadas todavía. El histórico sin movimiento intrabloque no se rellena.'));
    for(const g of h.groups){
     const tile=el('section',null,'learning-model-card');tile.append(el('h4','Híbrido · muestra independiente'),el('strong',Number.isFinite(g.accuracy)?(g.accuracy*100).toFixed(1)+'%':'—','learning-model-score'));
     const metrics=el('div');metricas(metrics,[['Aciertos',g.correct],['Fallos',g.wrong],['Evaluados',g.contracts],['Brier · menos es mejor',Number.isFinite(g.brier)?g.brier.toFixed(4):'Sin resultados']]);tile.append(metrics,el('p','Sobre estos mismos '+g.contracts+' contratos: TimesFM '+g.timesfmCorrect+' aciertos, consolidado '+g.spotCorrect+', BRTI '+g.brtiCorrect+'. Esta muestra es distinta de la comparación anterior.','workspace-note'));const detail=el('details');detail.append(el('summary','Versiones del híbrido'),el('p',g.key,'workspace-note'));tile.append(detail);body.append(tile);
    }
    body.append(el('p',h.pending+' pendientes. Sólo observación: sin órdenes ni sustitución automática del modelo activo.','workspace-note'));
   }
   if(data.minuteLab){const m=data.minuteLab,latest=m.latest;
    body.append(el('h3','TimesFM · laboratorio de un minuto'),el('p',m.note,'workspace-note'));
    body.append(el('p',m.error?'Incidencia: '+m.error:latest?.status==='observing'?'Última predicción: '+latest.symbol+' · '+latest.horizon+' minutos al cierre · cálculo '+(latest.latencyMs/1000).toFixed(1)+' s':latest?.reason||'Esperando primera recolección'));
    body.append(el('p',(latest?.points||0)+' minutos guardados para el último activo · ventanas de 256, 512 y 1024 según disponibilidad · '+m.pending+' predicciones pendientes. Sin validación histórica en la consulta en vivo.','workspace-note'));
    if(latest?.candidates){const grid=el('div',null,'learning-model-grid');for(const c of latest.candidates){const tile=el('section',null,'learning-model-card');tile.append(el('h4',c.context+' minutos de contexto'),el('strong',money(c.estimatedClose)),el('p','Rango 80% nominal: '+money(c.quantiles[0])+' – '+money(c.quantiles[8]),'workspace-note'));grid.append(tile);}body.append(grid);}
    const results=el('details');results.append(el('summary','Resultados por activo y minutos hasta el cierre'));
    if(!m.groups.length)results.append(el('p','Esperando resultados futuros; no se rellenan retrospectivamente.'));
    for(const g of m.groups){results.append(el('p',g.symbol+' · horizonte '+g.horizon+' min · '+g.cases+' casos · referencia: '+money(g.baselineMae)));for(const context of g.contexts)results.append(el('p',context+' minutos: error '+money(g.models[context].mae)+' · cobertura 80% observada '+(100*g.models[context].coverage80).toFixed(1)+'%'));}body.append(results);
   }
   const group=data.groups?.find(g=>JSON.stringify([g.symbol,g.interval,g.source,g.venues])===select.value);
   if(!group){body.append(el('p','Aún no hay bloques registrados. El servidor recopila BTC y ETH a 15 minutos.'));return;}
   const local=data.localAI?.groups?.find(g=>g.group===select.value&&g.phase===Number(phase.value));
   metricas(body,[['Cierres recopilados',group.closed],['Ventana móvil · hasta 500 cierres',local?.latest?.trainingSamples??'Pendiente'],['Cierres evaluados de IA local',local?.samples??0],['Modo actual','En evaluación']]);
   body.append(el('p',group.source+' · '+(group.venues||[]).join(', '),'workspace-note'));
   const progress=el('progress');progress.max=100;progress.value=Math.min(100,local?.samples||0);progress.setAttribute('aria-label','Cierres evaluados hacia una revisión mínima de 100');
   body.append(el('h3','Evaluación de la IA local'),progress,el('p',(local?.samples||0)+' / 100 cierres para una revisión inicial. Alcanzar 100 no garantiza precisión ni activa el modelo.','workspace-note'));
   if(local?.latest){const p=local.latest;body.append(el('p','Último ajuste de la IA local: '+new Date(p.at).toLocaleString('es-ES')+'. Usa los últimos '+p.trainingSamples+' cierres válidos; la ventana se renueva al incorporar cierres nuevos.','workspace-note'));body.append(el('p','Última estimación: '+money(p.price)+' · '+(Date.now()<p.closesAt?'cierre pendiente':'bloque terminado')+' · objetivo '+new Date(p.closesAt).toLocaleString('es-ES')));}
   const n=local?.rawPairedSamples||0;
   const pairCount=local?.baselineSamples||0;
   body.append(el('h3','Error del cierre de vela · '+phase.options[phase.selectedIndex].textContent),el('p','Menos error es mejor. Esta evaluación corresponde al cierre de la vela de la fuente seleccionada, no a la liquidación oficial de Kalshi.','workspace-note'));
   const values=n?[['IA local',local.localPairedMae],['TimesFM',local.rawPairedMae],['Mantener precio observado',local.baselinePairedMae]]:pairCount?[['IA local',local.baselineLocalMae],['Mantener precio observado',local.baselineObservedMae]]:[];
   if(n||pairCount)body.append(el('p',(n||pairCount)+' cierres compartidos por '+(n?'los tres modelos':'IA local y precio observado')+'. Predicciones congeladas en esta fase del bloque.','workspace-note'));
   const max=Math.max(0,...values.map(x=>Number.isFinite(x[1])?x[1]:0));
   for(const [name,value] of values){const row=el('div',null,'learning-error');row.append(el('span',name),el('strong',money(value)));const track=el('div',null,'learning-track'),bar=el('div',null,'learning-fill');bar.style.width=(Number.isFinite(value)&&max?value/max*100:0)+'%';track.append(bar);row.append(track);body.append(row);}
   if(!n){
    body.append(el('p',pairCount?'TimesFM no participa en esta comparación todavía.':'Esperando cierres comparables de esta fase.','arb-empty'));
    if(local?.missingNeuralSamples)body.append(el('p','En '+local.missingNeuralSamples+' cierres, la predicción local se guardó sin una estimación TimesFM disponible. No se añade después para evitar usar información posterior.','workspace-note'));
    const alternatives=data.localAI?.groups?.filter(g=>g.group===select.value&&g.phase!==Number(phase.value)&&g.rawPairedSamples>0)||[];
    for(const g of alternatives){const button=el('button','Ver '+phase.options[g.phase].textContent+' · '+g.rawPairedSamples+' cierres con los tres modelos');button.type='button';button.addEventListener('click',()=>{phase.value=String(g.phase);render();});body.append(button);}
   }
   if(local?.pendingSamples)body.append(el('p',local.pendingSamples+' predicción pendiente de cierre en esta fase.','workspace-note'));
   const detail=el('details',null,'workspace-help');detail.append(el('summary','Ver seguimiento del neuronal original y límites'),el('p',group.scored+' cierres originales · error neuronal '+money(group.mae)+' · referencia '+money(group.baselineMae)+'. Esta muestra es distinta de la comparación de IA local.'),el('p','Modelo local: '+(data.localAI?.version||'pendiente')+'. Aprende de cierres anteriores. Sigue pendiente validar la reconstrucción histórica y una mejora sostenida fuera de muestra. No predice la liquidación oficial de Kalshi ni ejecuta órdenes.'));body.append(detail);
   for(const error of data.errors||[])body.append(el('p',error,'warning'));
  }
  select.addEventListener('change',render);phase.addEventListener('change',render);
  async function refresh(){if(busy)return;busy=true;try{const r=await fetch('/api/learning',{cache:'no-store'});if(!r.ok)throw Error(r.status===429?'Límite temporal de consultas':'Respuesta del servidor: '+r.status);data=await r.json();try{const lr=await fetch('/api/kalshi-lag',{cache:'no-store'});if(lr.ok)data.lagLab=await lr.json();}catch{}const old=select.value;select.replaceChildren();for(const g of data.groups||[]){const o=el('option',g.symbol+' · '+g.interval+' · '+g.source+' · '+(g.venues||[]).join('/'));o.value=JSON.stringify([g.symbol,g.interval,g.source,g.venues]);select.append(o);}if([...select.options].some(o=>o.value===old))select.value=old;render();}catch(error){status.textContent='No se pudo actualizar el recolector. '+(error.message||'Conexión interrumpida')+'. Se reintentará automáticamente.';activity.offline();}finally{busy=false;}}
  PanelPolling.watch(card,refresh,15000);
 }
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
