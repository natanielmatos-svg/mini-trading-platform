'use strict';
(()=>{document.addEventListener('DOMContentLoaded',()=>{
 const card=document.getElementById('referenceValue')?.closest('.card');if(!card)return;
 const clock=document.createElement('div');clock.className='reference-countdown';
 clock.innerHTML='<div class="clock-count"><span class="label" data-reference-label></span><span class="time" data-reference-time>--:--</span></div><p class="workspace-note" data-reference-window></p><p class="workspace-note">Tiempo del bloque del gráfico; no es el vencimiento del contrato Kalshi.</p>';
 card.querySelector('.workspace-help')?.before(clock);if(!clock.parentNode)card.append(clock);
 function update(){
  const interval=document.getElementById('intervalSelect')?.value||'';
  const source=document.getElementById('bigCountdown');
  clock.querySelector('[data-reference-label]').textContent='Bloque '+interval+' · cierra en';
  clock.querySelector('[data-reference-time]').textContent=source?.textContent||'--:--';
  clock.querySelector('[data-reference-time]').className=source?.className||'time';
  clock.querySelector('[data-reference-window]').textContent=[document.getElementById('clockOpen')?.textContent,document.getElementById('clockClose')?.textContent].filter(Boolean).join(' · ');
 }
 update();const source=document.getElementById('bigCountdown');if(source)new MutationObserver(update).observe(source,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});document.getElementById('intervalSelect')?.addEventListener('change',update);
});})();
