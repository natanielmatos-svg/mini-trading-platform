'use strict';
(()=>{
 const key='mercado-appearance',root=document.documentElement,media=matchMedia('(prefers-color-scheme: dark)');
 const valid=v=>['light','dark','system'].includes(v)?v:'system';
 let preference='system';try{preference=valid(localStorage.getItem(key));}catch{}
 function apply(){root.dataset.theme=preference==='system'?(media.matches?'dark':'light'):preference;window.dispatchEvent(new Event('resize'));}
 apply();media.addEventListener('change',()=>{if(preference==='system')apply();});
 document.addEventListener('DOMContentLoaded',()=>{
  const host=document.querySelector('.workspace-nav');if(!host)return;
  const label=document.createElement('label');label.className='appearance-picker';label.append('Tema ');
  const select=document.createElement('select');select.setAttribute('aria-label','Tema de la aplicación');
  for(const [value,text] of [['system','Sistema'],['light','Claro'],['dark','Oscuro']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
  select.value=preference;label.append(select);host.append(label);
  select.addEventListener('change',()=>{preference=valid(select.value);try{localStorage.setItem(key,preference);}catch{}apply();});
  window.addEventListener('storage',e=>{if(e.key===key){preference=valid(e.newValue);select.value=preference;apply();}});
 });
})();
