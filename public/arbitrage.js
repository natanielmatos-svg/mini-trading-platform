'use strict';
(()=>{
  function element(tag,text,className){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;}
  const amount=(n,currency='USD')=>Number.isFinite(n)?n.toFixed(2)+' '+currency:'No calculable';
  function init(){
    const host=document.querySelector('.side-panel');if(!host)return;
    const card=element('section',null,'card');card.dataset.tarjeta='arbitraje';
    card.append(element('p','Kalshi + Polymarket US · solo observación','workspace-eyebrow'),element('h2','Escáner de arbitraje'));
    const status=element('p','Consultando escáner…'),metrics=element('div',null,'arb-metrics'),results=element('div'),foot=element('p',null,'workspace-note');
    const note=element('p','Una diferencia de precio solo es una candidata. Los importes son proyecciones del último escaneo, no cotizaciones para ejecutar. Ninguna operación real está habilitada.','workspace-note');
    card.append(status,metrics,note,results,foot);host.append(card);
    let busy=false;
    async function refresh(){
      if(busy)return;busy=true;
      try{
        const response=await fetch('/api/arbitrage');if(!response.ok)throw Error();const data=await response.json();
        status.textContent=(data.stale?'Sin escaneo reciente':data.status==='ready'?'Observación activa':data.status==='degraded'?'Cobertura parcial: alguna fuente no responde':'Esperando datos verificados')+(data.at?' · '+new Date(data.at).toLocaleTimeString('es-ES'):'');
        metrics.replaceChildren();
        for(const [label,value] of [['Capital protegido',amount(data.protectedCapitalUSD)],['Presupuesto real','0,00 USD'],['Pares examinados',data.checked??0],['Margen proyectado positivo',data.stale?0:data.projectedOpportunities??0]]){
          const box=element('div');box.append(element('span',label),element('strong',String(value)));metrics.append(box);
        }
        results.replaceChildren();
        const coverage=Object.entries(data.coverage||{}).map(([p,v])=>p+': '+v.count+' contratos · '+v.scope).join(' | ');
        results.append(element('p',coverage,'workspace-note'));
        const access=data.eligibility?.internationalBlocked;
        results.append(element('p',data.provider==='polymarket_us'?'Polymarket US: '+(data.coverage?.polymarket_us?.count>0?'catálogo público disponible. ':'sin catálogo disponible. ')+'Elegibilidad y permisos de tu cuenta pendientes de verificar.':access===true?'Polymarket internacional: órdenes bloqueadas desde esta red. Elegibilidad de cuenta sin verificar.':access===false?'La red permite acceso a Polymarket internacional; la elegibilidad de tu cuenta sigue sin verificar.':'Acceso operativo a Polymarket pendiente de verificar.','workspace-note'));
        const rows=(data.results||[]).filter(r=>r&&!r.error);
        const qualified=rows.filter(r=>r.qualified);
        if(!qualified.length)results.append(element('p','No hay oportunidades con margen neto positivo verificadas en esta muestra.','arb-empty'));
        function render(r){
          const item=element('article',null,'arb-result');item.append(element('h3',r.title));
          item.append(element('p',(r.providers||[]).join(' → ')+' · '+(r.outcomes||[]).join(' + '),'workspace-note'));
          item.append(element('p',r.qualified?'Margen condicionado: '+amount(r.net,r.currency)+' · coste '+amount(r.cost,r.currency)+' · '+r.quantity+' pares':(r.reasons||['Pendiente de revisión']).join(' · ')));
          if(r.simulation)item.append(element('p','Relectura tras latencia: '+r.simulation.state+' · escenario adverso '+amount(r.simulation.worstNet,r.currency),'workspace-note'));
          if(r.singleLegStress)item.append(element('p','Si falla la segunda compra: '+amount(r.singleLegStress.worstNet,r.currency)+' · contratos sin cobertura '+(r.singleLegStress.residual??'—'),'workspace-note'));
          const details=element('details',null,'workspace-help');details.dataset.detailKey='arb-rules|'+JSON.stringify([r.providers,r.urls,r.title,r.otherTitle]);details.append(element('summary','Revisar reglas y fuentes'));
          for(const [i,rule] of Object.values(r.ruleReview||{}).entries()){
            details.append(element('h4',r.providers[i]+' · '+(i===0?r.title:r.otherTitle)),element('p',rule.text||'Reglas ausentes'),element('p','Referencia: '+rule.source+' · Moneda: '+rule.currency));
            const url=r.urls?.[i];if(url&&/^https:\/\/(polymarket\.com|polymarket\.us|kalshi\.com)\//.test(url)){const a=element('a','Abrir contrato en origen');a.href=url;a.target='_blank';a.rel='noopener noreferrer';details.append(a);}
          }
          item.append(details);return item;
        }
        qualified.forEach(r=>results.append(render(r)));
        const excluded=element('details',null,'workspace-help');excluded.dataset.detailKey='arb-excluded';excluded.append(element('summary','Descartes y coincidencias por revisar ('+(rows.length-qualified.length)+')'));
        rows.filter(r=>!r.qualified).forEach(r=>excluded.append(render(r)));results.append(excluded);
        foot.textContent=(data.errors||[]).join(' · ')+' '+(data.assumptions||'El escáner inicia con el servidor local. No necesita que esta vista esté abierta.');
      }catch{status.textContent='Escáner no disponible. No hay oportunidades verificadas.';metrics.replaceChildren();results.replaceChildren();}finally{busy=false;}
    }
    PanelPolling.watch(card,refresh,15000);
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
