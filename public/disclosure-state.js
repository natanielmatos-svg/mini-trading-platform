'use strict';
(function(){
 function createState(){
  const values=new Map(),known=new WeakMap();
  function restore(node,key){
   if(known.has(node))return;
   known.set(node,key);
   if(values.has(key))node.open=values.get(key);else values.set(key,!!node.open);
   if(values.size>1000)values.delete(values.keys().next().value);
  }
  function remember(node){const key=known.get(node);if(key!==undefined)values.set(key,!!node.open);}
  return {restore,remember};
 }
 if(typeof module==='object'&&module.exports)module.exports={createState};
 if(typeof document==='undefined')return;
 const state=createState();
 function key(node){
  if(node.dataset.detailKey)return node.dataset.detailKey;
  const anchor=node.parentElement?.closest('[data-tarjeta],[id]');
  const scope=anchor?.dataset.tarjeta||anchor?.id||'page';
  const label=node.id||node.dataset.k||node.dataset.kind||node.querySelector(':scope > summary')?.textContent.trim().replace(/\s*\(\d+\)\s*$/,'')||'details';
  return scope+'|'+label;
 }
 function scan(root){if(root.nodeType!==1)return;if(root.matches('details'))state.restore(root,key(root));root.querySelectorAll('details').forEach(node=>state.restore(node,key(node)));}
 function init(){
  scan(document.documentElement);
  document.addEventListener('toggle',event=>{const node=event.target;if(node.tagName==='DETAILS'&&node.isConnected){state.restore(node,key(node));state.remember(node);}},true);
  new MutationObserver(records=>{for(const r of records)for(const node of r.addedNodes)if(node.isConnected)scan(node);}).observe(document.documentElement,{childList:true,subtree:true});
 }
 document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
