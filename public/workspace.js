'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const stocks = location.pathname.includes('acciones');
  let revision = 0, referenceId = 0, referenceBusy = false;
  let neuralBusy=false, neuralTimer=null, neuralNext=0;
  function queueNeural(){
    clearTimeout(neuralTimer);
    if(!$('neuralAuto')?.checked || neuralBusy || !selection().symbol)return;
    neuralTimer=setTimeout(neural,700);
  }
  const money = (n,unit='USD') => Number.isFinite(n) ? new Intl.NumberFormat('es-ES',{ maximumFractionDigits:Math.abs(n)<1?6:2 }).format(n)+' '+unit : '—';
  const selection = () => ({ symbol: $('symbolSelect').value === '__otro' ? $('symbolInput').value : $('symbolSelect').value, interval: $('intervalSelect').value });
  async function json(url) { const r=await fetch(url); if(!r.ok)throw Error('No se pudo conectar con el servidor.'); return r.json(); }
  async function reference() {
    if (!$('referenceValue') || referenceBusy) return;
    const rev=revision, id=++referenceId, {symbol}=selection();
    if(!symbol)return;
    referenceBusy=true;
    try {
      const d=await json('/api/reference?symbol='+encodeURIComponent(symbol));
      if(rev!==revision||id!==referenceId)return;
      $('referenceValue').textContent=d.ok?money(d.price):'Referencia no disponible';
      $('referenceNote').textContent=d.ok?d.index+' · dato de hace '+Math.max(0,(Date.now()-d.at)/1000).toFixed(1)+' s · consulta cada 2 s · '+d.note:d.reason;
    } catch(e) { if(rev===revision && id===referenceId){ $('referenceValue').textContent='Sin conexión'; $('referenceNote').textContent=e.message; } } finally { referenceBusy=false; }
  }
  async function neural() {
    if(neuralBusy)return;
    neuralBusy=true;neuralNext=Date.now()+60000;
    const rev=revision, {symbol,interval}=selection();
    const btn=$('neuralRun'); btn.disabled=true;
    $('neuralResult').textContent='Analizando el histórico. La primera consulta puede tardar hasta tres minutos…';
    try {
      const params=new URLSearchParams({symbol,interval,market:stocks?'stocks':'crypto'});
      const selectedVenues=[...document.querySelectorAll('[data-venue]:checked')].map(el=>el.dataset.venue);
      if(!stocks&&selectedVenues.length)params.set('venues',selectedVenues.join(','));
      const d=await json('/api/neural-forecast?'+params);
      if(rev!==revision)return;
      $('neuralResult').replaceChildren();
      if(!d.ok) { $('neuralResult').textContent=d.reason; return; }
      neuralNext=d.closesAt+1500;
      const detail=document.createElement('details');detail.className='workspace-help';
      const summary=document.createElement('summary');summary.textContent='Fuente y validación del modelo';detail.append(summary);
      const delta=Number.isFinite(d.estimatedClose)&&Number.isFinite(d.baseline?.price)&&d.baseline.price>0?d.estimatedClose-d.baseline.price:null;
      const direction=delta===null?'Sin precio de referencia':delta>0?'Subida estimada':delta<0?'Bajada estimada':'Sin cambio estimado';
      for(const [label,value] of [
        ['Cierre estimado por TimesFM · no confirmado',money(d.estimatedClose,d.referenceUnit)],
        ['Último precio de la vela al consultar',money(d.baseline?.price,d.referenceUnit)],
        ['Diferencia frente al precio al consultar',money(delta,d.referenceUnit)],
        ['Rango central 80% nominal · no garantizado',money(d.quantiles[0],d.referenceUnit)+' – '+money(d.quantiles[8],d.referenceUnit)],
        ['Dirección frente al precio al consultar',direction],
        ['Hora de cierre de la vela estimada',new Date(d.closesAt).toLocaleString('es-ES')],
        ['Fuente',d.source+(d.demo?' · datos simulados':'')],
        ['Error medio absoluto de TimesFM',money(d.validation.mae,d.referenceUnit)+' · '+d.validation.samples+' casos de validación'],
        ['Error medio absoluto de mantener el último precio',money(d.validation.baselineMae,d.referenceUnit)+' · misma validación'],
        ['Evaluación desde predicciones guardadas',d.prospective?.samples?d.prospective.samples+' cierres · error '+money(d.prospective.mae,d.referenceUnit):'Aún sin cierres evaluados'],
        ['Aprendizaje por cierre',d.learning?'Activo en segundo plano · candidato en evaluación':'Sin estado disponible'],
      ]) { const row=document.createElement('div');row.className='workspace-row'; const a=document.createElement('span');a.textContent=label;const b=document.createElement('strong');b.textContent=value;row.append(a,b);(label==='Fuente'||label.startsWith('Error medio absoluto')?detail:$('neuralResult')).append(row); }
      const targetNote=document.createElement('p');targetNote.className='workspace-note';targetNote.textContent='Estimación del cierre de una vela de la fuente indicada, no del precio de liquidación de Kalshi. El cierre real se conoce después de terminar la vela. La dirección se compara con el precio guardado al consultar, no con una cotización en vivo.';$('neuralResult').append(targetNote);
      const note=document.createElement('p');note.className='workspace-note';note.textContent=d.note;$('neuralResult').append(note);
      if(d.validationStatus?.reason){const warning=document.createElement('p');warning.className='workspace-note';warning.textContent=d.validationStatus.reason;$('neuralResult').append(warning);}
      if(d.evidenceWarning){const warning=document.createElement('p');warning.className='workspace-note';warning.textContent=d.evidenceWarning;$('neuralResult').append(warning);}
      if(d.learning){const info=document.createElement('p');info.className='workspace-note';const groups=d.learning.groups.filter(g=>g.symbol===symbol&&g.interval===interval);info.textContent=groups.map(g=>g.source+': '+g.closed+' cierres guardados, '+g.scored+' predicciones evaluadas, '+g.candidateSamples+' pruebas de corrección').join(' · ')||'Esperando el primer cierre. El aprendizaje no cambia todavía TimesFM.';$('neuralResult').append(info);}
      if(d.learningWarning){const warning=document.createElement('p');warning.className='workspace-note';warning.textContent=d.learningWarning;$('neuralResult').append(warning);}
      if(d.learning?.localAI){const info=document.createElement('p');info.className='workspace-note';const rows=d.learning.localAI.groups.filter(g=>{const k=JSON.parse(g.group);return k[0]===symbol&&k[1]===interval;});const last=rows.map(g=>g.latest).filter(p=>p.closesAt>Date.now()).sort((a,b)=>b.at-a.at).at(-1);info.textContent=last?'IA local en evaluación: '+money(last.price,d.referenceUnit)+' · '+last.trainingSamples+' bloques de entrenamiento · emitida '+new Date(last.at).toLocaleTimeString('es-ES')+'. No sustituye al modelo principal.':'IA local: recopilando ejemplos para este activo y bloque.';$('neuralResult').append(info);}
      $('neuralResult').append(detail);
    } catch(e) { if(rev===revision)$('neuralResult').textContent=e.message; }
    finally { neuralBusy=false;btn.disabled=false;if(rev!==revision)queueNeural(); }
  }
  function changed() {
    revision++; referenceId++;
    if($('neuralResult'))$('neuralResult').textContent='Calcula una estimación para el activo y bloque seleccionados.';
    if($('neuralRun'))$('neuralRun').disabled=false;
    if($('referenceValue'))$('referenceValue').textContent='Consultando referencia…';
    reference();
    queueNeural();
  }
  document.addEventListener('DOMContentLoaded',() => {
    $('venueBox')?.addEventListener('change',e=>{if(e.target.matches('[data-venue]'))changed();});
    if($('neuralRun')){
      const label=document.createElement('label');label.className='workspace-auto';
      label.innerHTML='<input id="neuralAuto" type="checkbox" checked> Actualizar al cambiar activo, bloque y al comenzar un bloque nuevo';
      $('neuralRun').after(label);
      const settings=document.createElement('details');settings.className='workspace-help';
      const summary=document.createElement('summary');summary.textContent='Opciones de actualización';settings.append(summary);
      $('neuralResult').after(settings);settings.append($('neuralRun'),label);
      $('neuralAuto').addEventListener('change',()=>{if($('neuralAuto').checked)queueNeural();else clearTimeout(neuralTimer);});
      queueNeural();
      setInterval(()=>{if(!document.hidden && Date.now()>=neuralNext)queueNeural();},10000);
    }
    $('neuralRun')?.addEventListener('click',neural);
    for(const id of ['symbolSelect','symbolInput','intervalSelect']) $(id)?.addEventListener('change',changed);
    $('loadBtn')?.addEventListener('click',changed);
    let controlBusy=false;
    const controls=document.createElement('div');controls.className='workspace-controls';
    controls.innerHTML='<h3>Simulador de investigación</h3><span id="botAnimation" class="activity-avatar bot-avatar" data-state="unknown" aria-hidden="true"><i></i><i></i></span><p id="controlBotState" role="status">Consultando estado…</p><button type="button" data-bot-action="start">Iniciar simulador</button> <button type="button" data-bot-action="stop">Detener simulador</button><button type="button" data-bot-action="pause" id="botPause">Pausar entradas</button><h3>Supervisión y aprendizaje</h3><span id="agentAnimation" class="activity-avatar agent-avatar" data-state="unknown" aria-hidden="true"><i></i><i></i><i></i></span><p id="controlAgentState" role="status"></p><button type="button" data-bot-action="agent-on">Activar revisión de contexto</button> <button type="button" data-bot-action="agent-off">Desactivar revisión</button><p id="controlNotice" role="status"></p><p class="workspace-note">Solo simulación. Detener el bot detiene también la supervisión de sus posiciones; no las cierra. Para mantener las salidas, usa la pausa de nuevas entradas. El agente revisa contexto dentro del bot y sus consultas pueden consumir saldo de API. Desactivarlo no cancela una consulta ya en curso. El aprendizaje de precios continúa por separado.</p>';
    controls.addEventListener('click',async e=>{
      const action=e.target.dataset.botAction;if(!action||controlBusy)return;
      controlBusy=true;controls.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{const r=await fetch('/api/bot-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});const d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo aplicar el cambio');if(['pause','resume'].includes(action)&&$('riskForm'))$('riskForm').elements.paused.checked=action==='pause';$('controlNotice').textContent=action==='pause'?'Entradas pausadas; las salidas siguen supervisadas. Se aplica al siguiente ciclo.':action==='resume'?'Entradas reanudadas para el siguiente ciclo.':action==='stop'?'Detención solicitada; esperando que termine el ciclo actual.':'Cambio solicitado. El estado se actualizará al confirmarse.';}
      catch(e){$('controlNotice').textContent=e.message;}
      finally{controlBusy=false;systemStatus();}
    });
    const systemStatus=()=>json('/api/system-status').then(d => {
      if(d.demo)$('workspaceDemo').hidden=false;
      const running=d.bot.running,desired=d.control?.botEnabled,enabled=d.control?.agentEnabled,paused=d.control?.paused;
      if($('controlBotState')){
        $('controlBotState').textContent=running?(desired?(paused?'Bot en pausa · sigue revisando salidas':'Bot activo · simulación'):'Bot deteniéndose · simulación'):d.bot.stopping?'Bot detenido o terminando el ciclo':'Bot detenido o sin señal reciente';
        $('controlAgentState').textContent=(enabled?(running?'Agente habilitado dentro del bot':'Agente habilitado · esperando al bot'):'Agente desactivado')+(d.bot.agentBusy?' · consulta en curso':'');
        $('botAnimation').dataset.state=running&&desired?(paused?'paused':'active'):'stopped';
        $('agentAnimation').dataset.state=running&&d.bot.agentBusy?'working':running&&enabled?'active':'stopped';
        $('botPause').dataset.botAction=paused?'resume':'pause';$('botPause').textContent=paused?'Reanudar entradas':'Pausar entradas';
        controls.querySelectorAll('button').forEach(b=>{const a=b.dataset.botAction;b.disabled=controlBusy||d.demo||(['pause','resume'].includes(a)&&(!running||!desired))||(a==='start'&&running)||(a==='stop'&&!desired)||(a==='agent-on'&&(enabled||!d.agent.configured))||(a==='agent-off'&&!enabled);});
      }
      if($('agentStatus'))$('agentStatus').textContent=d.agent.configured?`${d.agent.provider === 'openai' ? 'OpenAI' : 'Anthropic'} · ${d.agent.model} · configurado`:'Sin credencial configurada';
      if($('botState'))$('botState').textContent=d.bot.running?`Activo · ${d.bot.symbol} · ${d.bot.interval} · ciclo ${d.bot.cycle}`:'Proceso detenido o sin señal reciente';
      if($('summaryBotStatus'))$('summaryBotStatus').textContent=d.bot.running?(paused?'Bot en pausa · salidas supervisadas':'Bot activo en simulación'):'Bot detenido';
    }).catch(()=>{if($('agentStatus'))$('agentStatus').textContent='Estado no disponible';for(const id of ['botAnimation','agentAnimation'])if($(id))$(id).dataset.state='unknown';if($('controlBotState'))$('controlBotState').textContent='Sin conexión: estado no confirmado';});
    const systemCard=document.querySelector('[data-tarjeta="sistema"]');
    if(systemCard){const status=document.createElement('p');status.id='summaryBotStatus';status.setAttribute('role','status');status.textContent='Comprobando proceso…';systemCard.querySelector('h2').after(status);}
    systemStatus();setInterval(systemStatus,15000);
    const host=document.querySelector('.side-panel');
    if(host){
      const evidence=document.createElement('section');evidence.className='card';evidence.dataset.tarjeta='evidencia';
      evidence.innerHTML='<p class="workspace-eyebrow">Validación · piloto Bitcoin</p><h2>¿Hay ventaja medida?</h2><p><strong>Rentabilidad todavía no demostrada</strong></p><div id="evidenceMetrics" aria-live="polite">Consultando observaciones…</div><p id="evidenceState" class="workspace-note"></p><p class="workspace-note">Comparación prospectiva contra probabilidades de Kalshi. Dinero real desactivado. El gráfico general y TimesFM siguen siendo análisis exploratorio.</p>';
      host.append(evidence);
      const evidenceStatus=()=>json('/api/evidence').then(d=>{
        const rows=[['Contratos observados',d.contratos],['Observaciones liquidadas',d.resueltas],['Pendientes',d.pendientes],['Minutos continuos del índice',(d.bot.warmup??0)+' / 400'],['Beneficio neto verificado','No disponible']];
        for(const g of d.comparaciones)rows.push([g.grupo+' · '+g.n+' casos','Brier: modelo '+g.brierModelo.toFixed(3)+' / Kalshi '+g.brierKalshi.toFixed(3)]);
        $('evidenceMetrics').replaceChildren(...rows.map(([k,v])=>{const row=document.createElement('div');row.className='workspace-row';const a=document.createElement('span'),b=document.createElement('strong');a.textContent=k;b.textContent=v;row.append(a,b);return row;}));
        $('evidenceState').textContent=(d.bot.entryBlock||d.bot.lastError||'Esperando el primer ciclo')+'. '+d.nota;
      }).catch(()=>{$('evidenceState').textContent='No se pudo verificar la evidencia. No asumir rentabilidad.';});
      PanelPolling.watch(evidence,evidenceStatus,15000);
      const card=document.createElement('section');card.className='card';card.dataset.tarjeta='riesgo';
      card.innerHTML='<p class="workspace-eyebrow">Kalshi · control de capital</p><h2>Capital y límites</h2><p id="botState" role="status">Consultando proceso…</p><form id="riskForm"><label>Capital máximo (USD)<input name="capital" type="number" min="0.01" step="0.01" required></label><label>Pérdida diaria máxima (%, día UTC)<input name="maxDailyLossPct" type="number" min="0.01" step="0.01" placeholder="Automático dentro del riesgo diario"></label><label>Máximo por operación, con comisiones (USD)<input name="maxPerTrade" type="number" min="0.01" step="0.01" placeholder="Automático dentro del riesgo diario"></label><label class="workspace-auto"><input name="paused" type="checkbox"> Pausar nuevas entradas; mantener revisión de salidas</label><button type="submit">Guardar límites</button></form><p id="riskNotice" role="status"></p><p class="workspace-note">Los límites se aplican al siguiente ciclo del bot simulado. Guardarlos no activa dinero real.</p><ul id="liveBlockers" class="workspace-note"></ul>';
      host.append(card);const research=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Simulador y revisión de contexto (investigación)';research.append(summary,controls);card.querySelector('#botState').after(research);systemStatus();
      const preparation=document.createElement('section');preparation.className='production-preparation';
      preparation.innerHTML='<h3>Preparación para operación real</h3><p><strong>No habilitada · revisión manual obligatoria</strong></p><p id="productionBudget"></p><button type="button" id="checkProduction">Comprobar preparación y cuenta</button><p id="productionChecked" role="status">Sin comprobar. Consulta de solo lectura; no envía órdenes.</p><ul id="productionChecks"></ul><p id="productionNext"></p><a href="https://kalshi.com" target="_blank" rel="noopener noreferrer">Abrir Kalshi para revisión manual</a>';
      card.append(preparation);
      $('checkProduction').addEventListener('click',async()=>{
        const button=$('checkProduction');button.disabled=true;$('productionChecked').textContent='Verificando acceso de lectura y estado local…';
        try{
          const d=await json('/api/production-readiness');
          $('productionBudget').textContent='Capital: '+money(d.capitalUSD)+' · presupuesto diario: '+money(d.dailyBudgetUSD)+' · máximo por operación: '+(d.maxPerTradeUSD===null?'automático':money(d.maxPerTradeUSD));
          $('productionChecks').replaceChildren(...d.checks.map(c=>{const li=document.createElement('li');li.textContent=(c.ok?'✓ ':'Pendiente · ')+c.label+'. '+c.detail;li.dataset.ok=String(c.ok);return li;}));
          $('productionChecked').textContent='Comprobado '+new Date(d.checkedAt).toLocaleTimeString('es-ES')+' · operaciones reales desactivadas';
          $('productionNext').textContent=d.nextStep;
        }catch{$('productionChecks').replaceChildren();$('productionChecked').textContent='No se pudo verificar. Operación real no habilitada.';}
        finally{button.disabled=false;}
      });
      const form=$('riskForm');
      const show=d=>{for(const k of ['capital','maxDailyLossPct','maxPerTrade'])form.elements[k].value=d.config[k]??'';form.elements.paused.checked=d.config.paused;$('liveBlockers').replaceChildren(...d.blockers.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));};
      json('/api/trading-settings').then(show).catch(()=>{$('riskNotice').textContent='No se pudo cargar la configuración';});
      form.addEventListener('submit',async e=>{
        e.preventDefault();const button=form.querySelector('button');button.disabled=true;
        try{const config={paused:form.elements.paused.checked};for(const k of ['capital','maxDailyLossPct','maxPerTrade'])config[k]=form.elements[k].value===''?null:Number(form.elements[k].value);
          const res=await fetch('/api/trading-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});const data=await res.json();if(!res.ok)throw Error(data.error||'No se pudo guardar');show(data);systemStatus();$('riskNotice').textContent='Guardado · se aplicará en el siguiente ciclo';
        }catch(e){$('riskNotice').textContent=e.message;}finally{button.disabled=false;}
      });
    }
    reference();
    // El catálogo de símbolos llega después de DOMContentLoaded.
    if($('symbolSelect') && !$('symbolSelect').value) {
      const observer=new MutationObserver(()=>{ if($('symbolSelect').value){observer.disconnect();reference();queueNeural();} });
      observer.observe($('symbolSelect'),{childList:true,subtree:true});
    }
    setInterval(()=>{if(!document.hidden)reference();},2000);
  });
})();
