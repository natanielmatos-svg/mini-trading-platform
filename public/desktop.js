'use strict';
(() => {
  const init = () => {
    const root = document.querySelector('.container#workspaceMain') || document.querySelector('#results');
    if (!root) return;
    const key = 'mtp.desktop.v1.' + location.pathname;
    const viewKey = 'mtp.view.v3.' + location.pathname;
    const guided = root.id !== 'results';
    const summaryKey='mtp.summary.v2.'+location.pathname;
    const summaryOrderKey='mtp.summary.order.v1.'+location.pathname;
    let summaryOrder=[];
    try { const stored=JSON.parse(localStorage.getItem(summaryOrderKey)); if(Array.isArray(stored))summaryOrder=[...new Set(stored.filter(r=>typeof r==='string'))]; } catch {}
    const defaultSummary=['reloj','referencia','chart','estimacion','probabilidad','avisos'];
    let summaryRoles=[...defaultSummary];
    try{const savedRoles=JSON.parse(localStorage.getItem(summaryKey));if(Array.isArray(savedRoles)&&savedRoles.every(r=>typeof r==='string'))summaryRoles=savedRoles;}catch{}
    let summaryPicker;
    let view = 'resumen';
    try { view = localStorage.getItem(viewKey) || view; } catch {}
    if (!['resumen','analisis','bot','arbitraje','aprendizaje','ajustes','libre'].includes(view)) view='resumen';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch { /* almacenamiento opcional */ }
    if (typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    const toolbar = document.createElement('div');
    toolbar.className = 'desktop-controls';
    toolbar.innerHTML = '<strong>Mi escritorio</strong><span>Arrastra las barras · cambia el tamaño desde la esquina · flechas con el teclado</span><button type="button">Restablecer distribución</button><output aria-live="polite"></output>';
    root.before(toolbar);
    if (guided) {
      toolbar.querySelector('strong').textContent='Vista general';
      const nav=document.createElement('nav');nav.className='desktop-views';nav.setAttribute('aria-label','Vistas del escritorio');
      for (const [id,label] of [['resumen','Resumen'],['analisis','Análisis'],['bot','Operación'],['arbitraje','Arbitraje'],['aprendizaje','Progreso IA'],['ajustes','Ajustes'],['libre','Vista libre']]) {
        const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.view=id;
        button.addEventListener('click',()=>{view=id;try{localStorage.setItem(viewKey,view);}catch{}applyView();});nav.append(button);
      }
      toolbar.prepend(nav);
      summaryPicker=document.createElement('details');summaryPicker.className='summary-picker';
      const heading=document.createElement('summary');heading.textContent='Elegir tarjetas de Resumen';summaryPicker.append(heading);
      toolbar.append(summaryPicker);
    }
    const notice = toolbar.querySelector('output');
    const mobile = matchMedia('(max-width: 700px)');
    let items = [], topZ = 1, drag = null;
    let summaryFrame=0;
    function compactSummary(){
      if(summaryFrame)return;
      summaryFrame=requestAnimationFrame(()=>{
        summaryFrame=0;
        if(!guided||view!=='resumen'||mobile.matches)return;
        const cols=window.innerWidth>1200?3:2,gap=16,w=(root.clientWidth-gap*(cols-1))/cols,heights=Array(cols).fill(0);
        const visible=items.filter(i=>!i.el.hidden).sort((a,b)=>Number(a.el.style.getPropertyValue('--priority'))-Number(b.el.style.getPropertyValue('--priority')));
        const set=(el,key,value)=>{if(el.style.getPropertyValue(key)!==value)el.style.setProperty(key,value);};
        for(const i of visible)set(i.el,'--summary-width',w+'px');
        const measured=visible.map(i=>({i,height:i.el.getBoundingClientRect().height}));
        for(const {i,height} of measured){
          const col=heights.indexOf(Math.min(...heights));
          set(i.el,'--summary-x',(col*(w+gap))+'px');
          set(i.el,'--summary-y',heights[col]+'px');
          heights[col]+=height+gap;
        }
        set(root,'--summary-height',Math.max(0,...heights)+'px');
      });
    }
    const summarySizes=new ResizeObserver(compactSummary);
    function applyView() {
      if (!guided) return;
      const free=view==='libre';
      if(summaryPicker)summaryPicker.hidden=view!=='resumen';
      root.classList.toggle('desktop-guided',!free);root.dataset.view=view;
      compactSummary();
      toolbar.querySelector('span').textContent=free?'Arrastra y redimensiona las tarjetas a tu gusto.':({resumen:'Arrastra la barra de una tarjeta sobre otra para cambiar su posición. También puedes usar las flechas del teclado.',analisis:'Explora probabilidades, escenarios y señales técnicas.',bot:'Comprueba el estado, la evidencia y los límites de capital.',aprendizaje:'Entrenamiento, cierres y errores comparables. La evidencia antes de activar mejoras.',arbitraje:'Diferencias entre contratos, con reglas, costes y liquidez a la vista.',ajustes:'Configura indicadores y alertas.'}[view]);
      toolbar.querySelector(':scope > button').hidden=!free;
      toolbar.querySelector('output').textContent='';
      for(const b of toolbar.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
      const titles={resumen:'Vista general',analisis:'Análisis del mercado',bot:'Control de automatización',aprendizaje:'Laboratorio de aprendizaje',arbitraje:'Explorador de arbitraje',ajustes:'Preferencias',libre:'Escritorio libre'};
      toolbar.querySelector('strong').textContent=titles[view];
      let order=({resumen:['reloj','referencia','chart','estimacion','probabilidad','avisos','sistema'],analisis:['probabilidad','ruptura','prediccion','tendencia','estimacion'],bot:['sistema','cuenta','propuestas','riesgo','evidencia'],ajustes:['avisos','ema']}[view]||[]);
      if(view==='resumen')order=[...summaryOrder,...order.filter(r=>!summaryOrder.includes(r))];
      for(const i of items){
        const group=i.role==='aprendizaje'?'aprendizaje':i.role==='arbitraje'?'arbitraje':['reloj','referencia','sistema','chart','estimacion'].includes(i.role)?'resumen':['propuestas','cuenta','evidencia','riesgo'].includes(i.role)?'bot':['ema','avisos'].includes(i.role)?'ajustes':'analisis';
        i.el.hidden=!free && (view==='resumen'?!summaryRoles.includes(i.role):group!==view && !((view==='bot'&&i.role==='sistema')||(view==='analisis'&&i.role==='estimacion')));
 
        i.el.style.setProperty('--priority',order.includes(i.role)?order.indexOf(i.role):order.length);
        i.el.querySelector('.desktop-handle').tabIndex=(free||view==='resumen')?0:-1;
        i.el.querySelector('.desktop-handle').title=view==='resumen'?'Arrastra sobre otra tarjeta o usa las flechas para reordenar.':'Arrastra o usa las flechas. Mayús: pasos de 40 px.';
        i.el.querySelector('.desktop-resize').tabIndex=free?0:-1;
      }
      if (!free) [...items].sort((a,b)=>Number(a.el.style.getPropertyValue('--priority'))-Number(b.el.style.getPropertyValue('--priority'))).forEach(i=>root.append(i.el));
      document.dispatchEvent(new Event('desktop:viewchange'));
      window.dispatchEvent(new Event('resize'));
    }
    function reorderSummary(item,target) {
      if(!target || target===item)return;
      const ordered=[...items].sort((a,b)=>Number(a.el.style.getPropertyValue('--priority'))-Number(b.el.style.getPropertyValue('--priority')));
      const from=ordered.indexOf(item),to=ordered.indexOf(target);
      ordered.splice(from,1);ordered.splice(to,0,item);
      summaryOrder=ordered.map(i=>i.role);
      applyView();
      try{localStorage.setItem(summaryOrderKey,JSON.stringify(summaryOrder));notice.textContent='Orden de Resumen guardado';}catch{notice.textContent='Orden cambiado; guardado no disponible';}
      item.el.querySelector('.desktop-handle').focus({preventScroll:true});
    }
    const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
    const width = () => root.clientWidth;
    const persist = () => {
      for (const i of items) saved[i.id] = i.box;
      try { localStorage.setItem(key, JSON.stringify(saved)); notice.textContent = 'Distribución guardada'; }
      catch { notice.textContent = 'Guardado no disponible en este navegador'; }
    };
    function bounds(b) {
      const w = clamp(b.w, Math.min(240, width()), width());
      return { x: clamp(b.x, 0, width() - w), y: clamp(b.y, 0, 20000), w, h: clamp(b.h, 160, 2400), z: clamp(b.z || 1, 1, 10000) };
    }
    function paint(i) {
      const b = i.box;
      Object.assign(i.el.style, { left: b.x+'px', top: b.y+'px', width: b.w+'px', height: b.h+'px', zIndex: b.z });
      root.style.height = Math.max(500, ...items.map(t => t.box.y+t.box.h+24))+'px';
    }
    function defaults() {
      const gap = 16, cols = root.id === 'results' ? (width() >= 980 ? 2 : 1) : width() >= 1000 ? 3 : width() >= 700 ? 2 : 1;
      const colW = (width() - gap*(cols-1))/cols, heights = Array(cols).fill(0);
      for (const i of items) {
        const span = i.chart ? Math.min(2, cols) : 1;
        let col = 0, y = Infinity;
        for (let k=0;k<=cols-span;k++) { const h = Math.max(...heights.slice(k,k+span)); if(h<y){ y=h; col=k; } }
        i.box = bounds({x:col*(colW+gap), y, w:span*colW+(span-1)*gap, h:i.initialH, z:1});
        for(let k=col;k<col+span;k++)heights[k]=y+i.box.h+gap;
      }
    }
    function install() {
      const fresh = [...root.querySelectorAll('.card, .chart-area, .entry')].filter(el => !el.classList.contains('desktop-card'));
      if (!fresh.length) return;
      items = items.filter(i=>root.contains(i.el));
      for (const el of fresh) {
        const chart = el.classList.contains('chart-area');
        const title = chart ? 'Gráfico de precio' : el.querySelector('h2')?.textContent.replace(/^⠿/,'').trim() || 'Precio y cierre';
        const id = el.dataset.tarjeta || (chart ? 'chart' : title);
        const role=chart?'chart':el.querySelector('#probPanel')?'probabilidad':el.querySelector('#neuralResult')?'estimacion':el.querySelector('#referenceValue')?'referencia':id;
        el.dataset.role=role;
        if(role==='reloj'){
          const venues=el.querySelector('#venueBox');if(venues){const detail=document.createElement('details');detail.className='workspace-help source-details';const summary=document.createElement('summary');summary.textContent='Fuentes del precio';detail.append(summary);venues.before(detail);detail.append(venues);}
        }
        if(role==='riesgo'){
          const panel=el.querySelector('.workspace-controls');
          if(panel){
            const groups=document.createElement('div');groups.className='control-groups';let group=document.createElement('section');groups.append(group);
            for(const node of [...panel.children]){
              if(node.id==='agentAnimation'){group=document.createElement('section');groups.append(group);}
              if(node.matches('.activity-avatar,#controlBotState,#controlAgentState,button'))group.append(node);
            }
            panel.querySelector('h3').after(groups);
            const note=panel.querySelector('.workspace-note');if(note){const detail=document.createElement('details');detail.className='workspace-help';const title=document.createElement('summary');title.textContent='Qué hace cada control';detail.append(title);note.before(detail);detail.append(note);}
          }
        }
        if(role==='avisos'){
          el.querySelector('h2').textContent='Avisos y señales';
          const settings=document.createElement('details');settings.className='workspace-help';
          const title=document.createElement('summary');title.textContent='Configurar avisos';settings.append(title);
          for(const node of [...el.children])if(!node.matches('h2,#positionBox,#signalHistory'))settings.append(node);
          el.append(settings);
        }
        const initialH = chart ? 490 : clamp(el.getBoundingClientRect().height+52, 220, 650);
        const content = document.createElement('div'); content.className='desktop-content';
        while(el.firstChild)content.append(el.firstChild);
        const handle = document.createElement('button'); handle.type='button'; handle.className='desktop-handle'; handle.textContent='⠿ '+title;
        handle.setAttribute('aria-label','Mover '+title); handle.title='Arrastra o usa las flechas. Mayús: pasos de 40 px.';
        const resize = document.createElement('button'); resize.type='button';resize.className='desktop-resize';resize.textContent='◢';
        resize.setAttribute('aria-label','Cambiar tamaño de '+title);resize.title='Arrastra o usa las flechas para cambiar el tamaño';
        el.append(handle,content,resize);el.classList.add('desktop-card');
        root.append(el);
        const i = {el,id,role,chart,initialH,box:null};items.push(i);
        for(const [button,mode] of [[handle,'move'],[resize,'resize']]) {
          button.addEventListener('pointerdown', e=>{
            if(guided&&view==='resumen'&&mode==='move'&&e.button===0){
              e.preventDefault();drag={i,mode:'summary',id:e.pointerId,target:null};button.setPointerCapture(e.pointerId);el.classList.add('desktop-active');return;
            }
            if((guided&&view!=='libre')||mobile.matches||e.button!==0)return;
            e.preventDefault(); i.box.z=++topZ;paint(i);
            drag={i,mode,id:e.pointerId,x:e.clientX,y:e.clientY+scrollY,box:{...i.box}};
            button.setPointerCapture(e.pointerId);el.classList.add('desktop-active');
          });
          button.addEventListener('pointermove', e=>{
            if(!drag||drag.i!==i||drag.id!==e.pointerId)return;
            if(drag.mode==='summary'){
              const hit=document.elementFromPoint(e.clientX,e.clientY)?.closest('.desktop-card');
              drag.target=items.find(t=>t.el===hit&&!t.el.hidden&&t!==i)||null;
              items.forEach(t=>t.el.classList.toggle('desktop-drop-target',t===drag.target));
              if(e.clientY>innerHeight-45)scrollBy(0,16);else if(e.clientY<45)scrollBy(0,-16);
              return;
            }
            const dx=e.clientX-drag.x,dy=e.clientY+scrollY-drag.y,b=drag.box;
            i.box=bounds({...b,...(mode==='move'?{x:b.x+dx,y:b.y+dy}:{w:b.w+dx,h:b.h+dy})});paint(i);
            if(e.clientY>innerHeight-35)scrollBy(0,12);
            else if(e.clientY<35)scrollBy(0,-12);
          });
          const finish=(event)=>{ if(!drag||drag.i!==i)return;if(drag.mode==='summary'){const target=event?.type==='pointerup'?drag.target:null;drag=null;el.classList.remove('desktop-active');items.forEach(t=>t.el.classList.remove('desktop-drop-target'));reorderSummary(i,target);return;}drag=null;el.classList.remove('desktop-active');persist();window.dispatchEvent(new Event('resize')); };
          button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',finish);button.addEventListener('lostpointercapture',finish);
          button.addEventListener('keydown',e=>{
            if(guided&&view==='resumen'&&mode==='move'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
              e.preventDefault();const visible=[...root.children].map(el=>items.find(t=>t.el===el)).filter(t=>t&&!t.el.hidden);
              const direction=['ArrowLeft','ArrowUp'].includes(e.key)?-1:1;reorderSummary(i,visible[visible.indexOf(i)+direction]);return;
            }
            if((guided&&view!=='libre')||mobile.matches||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
            e.preventDefault(); const n=e.shiftKey?40:10,dx=e.key==='ArrowRight'?n:e.key==='ArrowLeft'?-n:0,dy=e.key==='ArrowDown'?n:e.key==='ArrowUp'?-n:0,b=i.box;
            i.box=bounds({...b,z:++topZ,...(mode==='move'?{x:b.x+dx,y:b.y+dy}:{w:b.w+dx,h:b.h+dy})});paint(i);persist();window.dispatchEvent(new Event('resize'));
          });
        }
      }
      root.classList.add('desktop-board');
      // Las columnas originales quedan vacías; los nodos y sus eventos se conservan.
      root.querySelectorAll(':scope > .main-col, :scope > .side-panel').forEach(el=>el.remove());
      defaults();
      for(const i of items){ const b=saved[i.id];if(b&&['x','y','w','h'].every(k=>Number.isFinite(b[k])))i.box=bounds(b);topZ=Math.max(topZ,i.box.z);paint(i); }
      if(summaryPicker){
        const labels={propuestas:'Propuestas del bot',cuenta:'Mi cuenta Kalshi (saldo y resultados)',probabilidad:'¿Termina por encima de…?',reloj:'Precio y cierre',avisos:'Avisos y señales de compra/venta',prediccion:'Escenarios de precio',ruptura:'Probabilidad de ruptura',tendencia:'Tendencia por horizonte',chart:'Gráfico',estimacion:'Estimación neuronal',referencia:'Referencia Kalshi',sistema:'Estado del bot y agente',riesgo:'Controles y riesgo',evidencia:'Evidencia',aprendizaje:'Progreso IA',arbitraje:'Arbitraje',ema:'Parámetros EMA'};
        const options=document.createElement('div');options.className='summary-options';
        for(const i of items){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=summaryRoles.includes(i.role);input.addEventListener('change',()=>{summaryRoles=items.filter(item=>item.role===i.role?input.checked:summaryRoles.includes(item.role)).map(item=>item.role);try{localStorage.setItem(summaryKey,JSON.stringify(summaryRoles));}catch{}applyView();});label.append(input,labels[i.role]||i.id);options.append(label);}
        const restore=document.createElement('button');restore.type='button';restore.textContent='Restaurar resumen recomendado';restore.addEventListener('click',()=>{summaryRoles=[...defaultSummary];summaryOrder=[];try{localStorage.removeItem(summaryOrderKey);}catch{}try{localStorage.setItem(summaryKey,JSON.stringify(summaryRoles));}catch{}options.querySelectorAll('input').forEach((input,index)=>input.checked=summaryRoles.includes(items[index].role));applyView();});
        summaryPicker.append(options,restore);
      }
      items.forEach(item=>summarySizes.observe(item.el));
      applyView();
      window.dispatchEvent(new Event('resize'));
    }
    toolbar.querySelector(':scope > button').addEventListener('click',()=>{saved={};defaults();items.forEach(paint);persist();window.dispatchEvent(new Event('resize'));});
    install();
    if(root.id==='results')new MutationObserver(install).observe(root,{childList:true});
    let timer;
    window.addEventListener('resize',()=>{ clearTimeout(timer);timer=setTimeout(()=>{ if(mobile.matches)return;for(const i of items){i.box=bounds(i.box);paint(i);} },140); });
    window.addEventListener('resize',compactSummary);
  };
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
