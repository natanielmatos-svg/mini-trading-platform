'use strict';
(()=>{document.addEventListener('DOMContentLoaded',()=>{
 const host=document.querySelector('.side-panel');if(!host)return;
 const card=document.createElement('section');card.className='card';card.dataset.tarjeta='propuestas';
 card.innerHTML='<p class="workspace-eyebrow">Revisión humana · sin ejecución</p><h2>Propuestas del bot</h2><p id="proposalNote"></p><button type="button" id="proposalRefresh">Actualizar propuestas</button><p id="proposalStatus" role="status"></p><div id="proposalList"></div><details class="workspace-help"><summary>Historial de revisiones</summary><div id="proposalHistory"></div></details>';
 host.append(card);const $=id=>card.querySelector('#'+id),money=v=>Number.isFinite(v)?v.toLocaleString('es-ES',{style:'currency',currency:'USD',maximumFractionDigits:4}):'No disponible';let busy=false;
 const dialog=document.createElement('dialog');dialog.className='supervised-ticket';dialog.setAttribute('aria-label','Revisión de operación en Kalshi');document.body.append(dialog);
 let ticketVersion=0;
 const para=(parent,text)=>{const el=document.createElement('p');el.textContent=text;parent.append(el);return el;};
 async function showTicket(id){
  const version=++ticketVersion;dialog.replaceChildren();const close=document.createElement('button');close.type='button';close.textContent='Cerrar revisión';close.addEventListener('click',()=>dialog.close());dialog.append(close);
  const body=document.createElement('div');dialog.append(body);para(body,'Consultando contrato y cuenta de Kalshi…');if(!dialog.open)dialog.showModal();
  try{const res=await fetch('/api/proposals/'+encodeURIComponent(id)+'/ticket',{cache:'no-store',signal:AbortSignal.timeout(30000)});const t=await res.json();if(!res.ok)throw Error(t.error||'No se pudo preparar la ficha');if(version!==ticketVersion||!dialog.open)return;body.replaceChildren();
   const h=document.createElement('h2');h.textContent='Revisar en Kalshi · sin orden enviada';body.append(h);const p=t.proposal;
   para(body,t.market?.title||p.ticker);para(body,'Contrato exacto: '+p.ticker);
   para(body,'Compra '+(p.side==='yes'?'Sí':p.side==='no'?'No':'—')+' · cantidad '+(p.quantity??'—')+' · precio límite propuesto '+money(p.limitPrice));
   para(body,'Ofertas consultadas: Sí '+money(t.market?.yesAsk)+' / No '+money(t.market?.noAsk)+' · cierre del mercado: '+(t.market?.closeTime?new Date(t.market.closeTime).toLocaleString('es-ES'):'No disponible'));
   para(body,'Coste total y pérdida si pierde el contrato (estimados): '+money(p.estimatedCost)+' · incluye comisión estimada de '+money(p.estimatedFees));
   para(body,'Saldo consultado: '+money(t.account.available)+' · posiciones abiertas: '+(t.account.openPositions??'—')+' · órdenes pendientes: '+(t.account.restingOrders??'—'));
   para(body,'Capital configurado: '+money(t.limits.capital)+' · máximo por operación: '+money(t.limits.perTrade)+' · presupuesto diario configurado: '+money(t.limits.dailyBudget));
   const age=para(body,'');age.dataset.ticketExpiry=t.expiresAt;age.dataset.checkedAt=t.checkedAt;updateTicketClock();
   if(t.blockers.length){const warning=para(body,'Propuesta bloqueada: '+t.blockers.join(' · '));warning.setAttribute('role','status');}
   para(body,t.note);
   const rules=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Reglas de liquidación del contrato';rules.append(summary);para(rules,t.market?.rules||'No disponibles: compruébalas en Kalshi.');if(t.market?.additionalRules)para(rules,t.market.additionalRules);body.append(rules);
   para(body,'Para una operación manual: busca este contrato en Kalshi y comprueba lado, cantidad, precio, comisión final y pérdida máxima antes de confirmar allí. Una aprobación local no envía una orden. Las ejecuciones aparecerán en Cuenta Kalshi cuando la API las reporte.');
   const copy=document.createElement('button');copy.type='button';copy.textContent='Copiar contrato';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(p.ticker);copy.textContent='Contrato copiado';}catch{copy.textContent='Selecciona y copia el contrato mostrado arriba';}});body.append(copy);
   const link=document.createElement('a');link.href=t.kalshiUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Abrir Kalshi para revisión manual';body.append(link);
  }catch(e){if(version===ticketVersion&&dialog.open){body.replaceChildren();para(body,e.message);}}
 }
 function updateTicketClock(){const el=dialog.querySelector('[data-ticket-expiry]');if(!el)return;const left=Math.ceil((Number(el.dataset.ticketExpiry)-Date.now())/1000);el.textContent='Consulta '+new Date(Number(el.dataset.checkedAt)).toLocaleTimeString('es-ES')+' · '+(left>0?'referencia válida durante '+left+' s':'Referencia vencida: cierra y vuelve a revisar antes de usar estos importes.');}
 dialog.addEventListener('close',()=>{ticketVersion++;});setInterval(()=>{if(dialog.open)updateTicketClock();},1000);
 async function refresh(){if(busy)return;busy=true;try{const res=await fetch('/api/proposals',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!res.ok)throw Error('No se pudo cargar propuestas');const d=await res.json();$('proposalNote').textContent=d.note;$('proposalList').replaceChildren();
 if(!d.proposals.length){const p=document.createElement('p');p.textContent='El bot aún no ha guardado evaluaciones. No hay una propuesta para aprobar.';$('proposalList').append(p);}
 for(const p of d.proposals){const box=document.createElement('article');box.className='proposal-item';const h=document.createElement('h3');h.textContent=p.ticker;box.append(h);
 const info=document.createElement('p');info.textContent='Compra '+(p.side==='yes'?'Sí':p.side==='no'?'No':'sin lado válido')+' · contratos: '+(p.quantity??'—')+' · precio: '+money(p.price)+' · comisión estimada: '+money(p.estimatedFees)+' · coste total estimado: '+money(p.total);box.append(info);
 const reason=document.createElement('p');reason.textContent=p.reason;box.append(reason);const times=document.createElement('p');times.className='workspace-note';times.textContent='Evaluada '+new Date(p.at).toLocaleString('es-ES')+' · válida hasta '+(p.expiresAt?new Date(p.expiresAt).toLocaleTimeString('es-ES'):'—')+' · '+p.source;box.append(times);
 const inspect=document.createElement('button');inspect.type='button';inspect.textContent='Revisar contrato y coste en Kalshi';inspect.addEventListener('click',()=>showTicket(p.id));box.append(inspect);
 const blocked=document.createElement('p');blocked.textContent=p.review?(p.review.action==='approve'?'Aprobada para revisión manual · no enviada':'Rechazada'):p.blockers.join(' · ')||'Pendiente de tu revisión';box.append(blocked);
 for(const [action,label] of [['approve','Aprobar propuesta (no envía orden)'],['reject','Rechazar']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.proposalAction=action;button.disabled=!!p.review||(action==='approve'&&!p.approvable);button.addEventListener('click',async()=>{box.querySelectorAll('button').forEach(b=>b.disabled=true);try{const r=await fetch('/api/proposals/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,action})});const result=await r.json();if(!r.ok)throw Error(result.error||'No se pudo guardar');$('proposalStatus').textContent=action==='approve'?'Aprobación registrada. No se ha enviado ninguna orden.':'Rechazo registrado.';}catch(e){$('proposalStatus').textContent=e.message;}await refresh();});box.append(button);}
 $('proposalList').append(box);}
 $('proposalHistory').replaceChildren(...d.history.map(r=>{const p=document.createElement('p');p.textContent=new Date(r.at).toLocaleString('es-ES')+' · '+r.proposal.ticker+' · '+(r.action==='approve'?'Aprobada para revisión manual':'Rechazada')+' · sin envío de orden';return p;}));
 }catch(e){$('proposalStatus').textContent=e.message;$('proposalList').querySelectorAll('button').forEach(b=>b.disabled=true);}finally{busy=false;}}
 $('proposalRefresh').addEventListener('click',refresh);PanelPolling.watch(card,refresh,15000);
});})();
