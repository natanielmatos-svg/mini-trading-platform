'use strict';
// One event stream per page; no extra market connection or inference requests.
window.mountLiveLearning=function(panel){
  const stages=['receive','close','local','neural'];
  const names=['Datos de mercado','Cierre confirmado','IA local','TimesFM'];
  const view=document.createElement('div');view.className='live-pipeline';
  const status=document.createElement('p');status.className='live-pipeline-status';status.textContent='Conectando actividad en vivo…';
  const rail=document.createElement('div');rail.className='live-pipeline-rail';
  const nodes=stages.map((stage,i)=>{const el=document.createElement('div');el.className='live-node';el.dataset.state='idle';el.innerHTML='<div class="live-orbit"><span class="live-core">'+['↘','✓','✦','◈'][i]+'</span><i></i><b></b></div><strong>'+names[i]+'</strong><small>Esperando evento</small>';rail.append(el);return el;});
  const feed=document.createElement('p');feed.className='live-pipeline-caption';feed.textContent='Eventos reales del recolector · sin ejecutar operaciones';
  view.append(status,rail,feed);panel.querySelector('.learning-flow').before(view);
  const minutes=window.MinuteFlow?.mount(panel);
  let source=null,selected=null,lastId=0;const timers=new Map();
  const quiet=()=>{for(const t of timers.values())clearTimeout(t);timers.clear();nodes.forEach(n=>n.dataset.state='idle');};
  function apply(event,replay=false){
    if(!selected||event.symbol!==selected[0]||event.interval!==selected[1])return;
    if(!replay&&event.id<=lastId)return;
    if(!replay)lastId=event.id;
    const i=stages.indexOf(event.stage);if(i<0)return;
    const el=nodes[i],age=Date.now()-event.at;
    clearTimeout(timers.get(i));
    // A reconnect snapshot conveys state, never replays completed animations.
    el.dataset.state=age<180000&&event.state==='start'?'working':!replay&&age<10000?event.state:'idle';
    el.querySelector('small').textContent=(event.state==='start'?'Procesando':event.state==='done'?'Recibido':'Incidencia')+' · '+new Date(event.at).toLocaleTimeString('es-ES');
    feed.textContent=event.symbol+' · '+event.interval+' · '+names[i]+' · '+(event.state==='start'?'en proceso':event.state==='done'?'confirmado':'no completado');
    timers.set(i,setTimeout(()=>{el.dataset.state='idle';if(event.state==='start')el.querySelector('small').textContent='Sin confirmación reciente';},event.state==='start'?Math.max(1,180000-age):1800));
  }
  function connect(){
    if(document.hidden||panel.closest('[hidden]')||source)return;
    source=new EventSource('/api/activity/stream');
    source.addEventListener('snapshot',e=>{lastId=0;quiet();status.textContent='● Actividad en vivo · conexión establecida';view.dataset.connected='true';JSON.parse(e.data).forEach(v=>apply(v,true));});
    source.addEventListener('activity',e=>apply(JSON.parse(e.data)));
    source.onerror=()=>{quiet();view.dataset.connected='false';status.textContent='Reconectando actividad…';};
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){source?.close();source=null;quiet();}else connect();});
  document.addEventListener('desktop:viewchange',()=>{if(panel.closest('[hidden]')){source?.close();source=null;quiet();}else connect();});
  window.addEventListener('pagehide',()=>{source?.close();source=null;quiet();});
  window.addEventListener('pageshow',connect);
  connect();
  return {select(key){let next;try{next=JSON.parse(key);}catch{return;}if(JSON.stringify(next)!==JSON.stringify(selected)){selected=next;minutes?.select(next);quiet();nodes.forEach(n=>n.querySelector('small').textContent='Esperando evento');feed.textContent=next[0]+' · '+next[1]+' · procesamiento del aprendizaje, todas las fases';}}};
};
