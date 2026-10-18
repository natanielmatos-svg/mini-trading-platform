'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('no consulta tarjetas ocultas, refresca al entrar y no solapa peticiones',async()=>{
 const listeners={},ticks=[];let hidden=true,calls=0,resolve;
 const document={hidden:false,addEventListener:(event,fn)=>listeners[event]=fn,removeEventListener:()=>{}};
 const ctx=vm.createContext({document,Date,requestAnimationFrame:fn=>ticks.push(fn),setInterval:fn=>ticks.push(fn),clearInterval:()=>{}});
 vm.runInContext(fs.readFileSync(require.resolve('../public/panel-polling'),'utf8'),ctx);
 ctx.PanelPolling.watch({isConnected:true,closest:()=>hidden?{}:null},()=>{calls++;return new Promise(r=>resolve=r);},5000);
 ticks.forEach(fn=>fn());assert.equal(calls,0);
 hidden=false;listeners['desktop:viewchange']();assert.equal(calls,1);listeners['desktop:viewchange']();assert.equal(calls,1);
 resolve();await flush();hidden=true;listeners['desktop:viewchange']();hidden=false;listeners['desktop:viewchange']();assert.equal(calls,2);
 resolve();await flush();document.hidden=true;listeners.visibilitychange();ticks.forEach(fn=>fn());assert.equal(calls,2);
});
