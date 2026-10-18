'use strict';
(()=>{document.addEventListener('DOMContentLoaded',()=>{
 const host=document.querySelector('.side-panel');if(!host)return;
 const card=document.createElement('section');card.className='card';card.dataset.tarjeta='cuenta';
 card.innerHTML='<p class="workspace-eyebrow">Cuenta real · solo lectura</p><h2>Mi cuenta Kalshi</h2><button type="button" id="accountRefresh">Actualizar cuenta</button><p id="accountStatus" role="status">Consultando…</p><div class="account-metrics" id="accountMetrics"></div><p id="accountNote" class="workspace-note"></p><div id="accountTables"></div>';
 host.append(card);const $=id=>card.querySelector('#'+id);
 const fmt=v=>Number.isFinite(v)?new Intl.NumberFormat('es-ES',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(v):'No disponible';
 const count=v=>v==null?'—':String(v);
 const date=v=>v?new Date(v).toLocaleString('es-ES'):'—';
 const labels={yes:'Sí',no:'No',buy:'Compra',sell:'Venta',resting:'Pendiente',executed:'Ejecutada',canceled:'Cancelada',bid:'Compra en libro',ask:'Venta en libro'};
 const str=v=>labels[v]||v||'—';
 const columns={
 positions:[['Contrato','title'],['Identificador','ticker'],['Contratos (+Sí / −No)','contracts',count],['Coste posición','cost',fmt],['Total gastado reportado','traded',fmt],['P&L realizado reportado','pnl',fmt],['Comisiones','fees',fmt],['Actualizado','at',date]],
 orders:[['Contrato','title'],['Identificador','ticker'],['Estado','status',str],['Acción','action',str],['Lado','side',str],['Tipo','type'],['Inicial','initial',count],['Ejecutado','filled',count],['Pendiente','remaining',count],['Precio Sí','yesPrice',fmt],['Precio No','noPrice',fmt],['Coste maker','makerCost',fmt],['Coste taker','takerCost',fmt],['Comisión maker','makerFees',fmt],['Comisión taker','takerFees',fmt],['Fecha','at',date]],
 fills:[['Contrato','title'],['Identificador','ticker'],['Acción','action',str],['Lado','side',str],['Contratos','count',count],['Precio Sí','yesPrice',fmt],['Precio No','noPrice',fmt],['Comisión','fees',fmt],['Liquidez','taker',v=>v==null?'—':v?'Taker':'Maker'],['Fecha','at',date]],
 settlements:[['Contrato','title'],['Identificador','ticker'],['Resultado contrato','result',str],['Contratos Sí','yesCount',count],['Contratos No','noCount',count],['Coste Sí','yesCost',fmt],['Coste No','noCost',fmt],['Cobrado','revenue',fmt],['Comisiones','fees',fmt],['Fecha','at',date]]};
 let busy=false,lastData=null,lastError=false;
 const status=()=>{if(!lastData)return;const age=Math.max(0,Math.floor((Date.now()-lastData.requestedAt)/1000));const partial=!lastData.balance.checkedAt||Object.values(lastData.sections).some(s=>!s.complete);
 $('accountStatus').textContent=(lastError?'Sin conexión · ':partial?'Datos parciales · ':age>15?'Datos atrasados · ':'Actualización automática · ')+ 'consulta hace '+age+' s · sondeo cada 5 s · '+date(lastData.checkedAt)+'. Kalshi puede reflejar cambios con retraso.';};
 setInterval(status,1000);
 async function refresh(){if(busy)return;busy=true;$('accountRefresh').disabled=true;
 try{
  const r=await fetch('/api/kalshi-account',{cache:'no-store',signal:AbortSignal.timeout(90000)});if(!r.ok)throw Error();const d=await r.json();
  lastData=d;lastError=false;status();
  const metrics=[['Saldo disponible',d.balance.available],['Valor de cartera reportado',d.balance.portfolio],['Invertido en posiciones abiertas (coste)',d.summary.positionCost],['P&L realizado de posiciones reportadas',d.summary.realizedReported],['Comisiones de ejecuciones cargadas',d.summary.fillFees],['Cobros de liquidaciones cargadas',d.summary.settlementRevenue]];
  $('accountMetrics').replaceChildren(...metrics.map(([label,value])=>{const box=document.createElement('div'),name=document.createElement('span'),amount=document.createElement('strong');name.textContent=label;amount.textContent=fmt(value);box.append(name,amount);return box;}));
  $('accountNote').textContent=d.note+' Posiciones abiertas: '+count(d.summary.openPositions)+'. Órdenes pendientes: '+count(d.summary.restingOrders)+'. Cobros no significa ganancias: puede haber ventas y compensaciones previas. No se calcula un P&L total sin conciliar el historial completo. Sin posiciones reportadas, el P&L histórico aparece como no disponible, no como cero.';
  const previous=Object.fromEntries([...$('accountTables').children].map(el=>[el.dataset.kind,{open:el.open,left:el.querySelector('.account-table-wrap')?.scrollLeft||0,top:el.querySelector('.account-table-wrap')?.scrollTop||0}]));
  $('accountTables').replaceChildren();
  for(const [kind,title] of [['positions','Posiciones y exposición'],['orders','Órdenes recientes'],['fills','Operaciones ejecutadas recientes'],['settlements','Liquidaciones y resultados']]){
   const section=d.sections[kind],details=document.createElement('details'),summary=document.createElement('summary');details.className='workspace-help';details.dataset.kind=kind;details.open=previous[kind]?.open||false;summary.textContent=title+' · '+section.rows.length+(section.complete?'':' · incompleto');details.append(summary);
   if(section.error){const warning=document.createElement('p');warning.textContent=section.error;details.append(warning);}
   if(!section.rows.length){const empty=document.createElement('p');empty.textContent=section.complete?'Sin registros devueltos por Kalshi.':'Datos no disponibles; no equivale a cero operaciones.';details.append(empty);}
   else{const wrap=document.createElement('div');wrap.className='account-table-wrap';wrap.tabIndex=0;wrap.setAttribute('aria-label',title+'; desplaza horizontalmente para ver todos los importes');const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr'),body=document.createElement('tbody');
    for(const [label] of columns[kind]){const th=document.createElement('th');th.scope='col';th.textContent=label;tr.append(th);}head.append(tr);
    for(const row of section.rows){const tr=document.createElement('tr');for(const [,key,format] of columns[kind]){const td=document.createElement('td');td.textContent=format?format(row[key]):row[key]??'—';tr.append(td);}body.append(tr);}table.append(head,body);wrap.append(table);details.append(wrap);}
   $('accountTables').append(details);const wrap=details.querySelector('.account-table-wrap');if(wrap&&previous[kind]){wrap.scrollLeft=previous[kind].left;wrap.scrollTop=previous[kind].top;}
  }
 }catch{lastError=true;$('accountStatus').textContent='No se pudo actualizar. Los datos anteriores, si aparecen, no están confirmados como actuales.';}
 finally{busy=false;$('accountRefresh').disabled=false;}}
 $('accountRefresh').addEventListener('click',refresh);PanelPolling.watch(card,refresh,5000);
});})();
