'use strict';
(() => {
  const stock=location.pathname.includes('acciones');
  let revision=0, controller=null, timer=null, referenceTimer=null;
  const $=id=>document.getElementById(id);
  const price=n=>Number.isFinite(n)?n.toLocaleString('es-ES',{maximumFractionDigits:n<1?6:2}):'—';
  const paragraph=(box,text,className='note')=>{const p=document.createElement('p');p.className=className;p.textContent=text;box.appendChild(p);return p;};
  function selection(){
    const symbol=$('symbolSelect').value;
    return {symbol:symbol==='__otro'?$('symbolInput').value:symbol|| (stock?'AAPL':'BTCUSDT'),interval:$('intervalSelect').value};
  }
  async function reference(token,params){
    if(stock || token!==revision)return;
    const box=$('kalshiReference');
    try{
      const r=await fetch('/api/reference?'+params,{signal:controller.signal});const data=await r.json();
      if(token!==revision)return;
      box.replaceChildren();
      if(!data.ok)paragraph(box,data.reason);
      else {paragraph(box,price(data.price)+' USD · '+data.index,'forecast-price');paragraph(box,'Fecha del índice: '+new Date(data.at).toLocaleTimeString());paragraph(box,data.note);}
    }catch(err){if(token===revision && err.name!=='AbortError'){box.replaceChildren();paragraph(box,'Referencia no disponible.');}}
    if(token===revision)referenceTimer=setTimeout(()=>reference(token,params),5000);
  }
  async function update(token,params){
    const box=$('forecastPanel');
    try{
      const r=await fetch('/api/forecast?'+params+'&market='+(stock?'stocks':'crypto'),{signal:controller.signal});
      const data=await r.json();if(token!==revision)return;
      box.replaceChildren();
      if(!data.ok){paragraph(box,data.reason);}
      else if(Date.now()>=data.closesAt){paragraph(box,'El bloque terminó. Actualizando…');}
      else {
        if(data.demo)paragraph(box,'DEMOSTRACIÓN · datos sintéticos','warning');
        paragraph(box,'Cierre estimado: '+price(data.estimatedClose)+' '+data.referenceUnit,'forecast-price');
        paragraph(box,'Sesgo de la mediana: '+data.medianDirection+' · '+data.expectedChangePct.toFixed(3)+'% respecto al precio observado.');
        paragraph(box,'Rango central del modelo (80% nominal): '+price(data.range80.low)+' – '+price(data.range80.high)+' '+data.referenceUnit);
        paragraph(box,data.direction==='sin ventaja clara'?'El rango incluye subidas y bajadas: sin ventaja direccional clara.':'El rango apunta a '+data.direction+'.');
        paragraph(box,'Cierre del bloque: '+new Date(data.closesAt).toLocaleString());
        paragraph(box,data.model+' · '+data.source+' · '+data.interval);
        paragraph(box,data.basis);
        const v=data.validation;
        paragraph(box,'Validación reciente ('+v.samples+' cierres): error medio '+price(v.mae)+'; mantener último cierre '+price(v.baselineMae)+'. Cobertura observada del rango: '+(v.coverage80*100).toFixed(0)+'%.');
        if(v.mae>=v.baselineMae)paragraph(box,'En esta muestra el modelo no mejora la referencia sencilla.','warning');
        paragraph(box,'Muestra corta; resultados exploratorios, no precisión futura demostrada.');
        paragraph(box,data.target);
      }
    }catch(err){if(token===revision && err.name!=='AbortError'){box.replaceChildren();paragraph(box,'No se pudo consultar el motor.');}}
    if(token===revision)timer=setTimeout(()=>update(token,params),15000);
  }
  function reload(){
    revision++;controller?.abort();controller=new AbortController();clearTimeout(timer);clearTimeout(referenceTimer);
    const params=new URLSearchParams(selection());
    $('forecastPanel').replaceChildren();paragraph($('forecastPanel'),'Calculando con el historial del activo… La primera carga puede tardar.');
    if(!stock){$('kalshiReference').replaceChildren();paragraph($('kalshiReference'),'Consultando referencia…');}
    update(revision,params);reference(revision,params);
  }
  document.addEventListener('DOMContentLoaded',()=>{
    $('symbolSelect').addEventListener('change',reload);$('intervalSelect').addEventListener('change',reload);
    $('loadBtn').addEventListener('click',reload);
    $('symbolInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')reload();});
    reload();
  });
})();
