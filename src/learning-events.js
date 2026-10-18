'use strict';
// Ephemeral UI telemetry. Never contains credentials, orders or model payloads.
function create(){
  const listeners=new Set();let sequence=0;const latest=new Map();
  function publish({symbol,interval,stage,state}){
    if(!/^[A-Z0-9]{2,20}$/.test(symbol)||!/^\d+[mhdw]$/.test(interval)||!['receive','close','local','neural'].includes(stage)||!['start','done','error'].includes(state))return;
    const event={id:++sequence,at:Date.now(),symbol,interval,stage,state};
    latest.set(symbol+'|'+interval+'|'+stage,event);
    if(latest.size>64)latest.delete(latest.keys().next().value);
    for(const listener of listeners){try{listener(event);}catch{listeners.delete(listener);}}
    return event;
  }
  return {publish,snapshot:()=>[...latest.values()],subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},size:()=>listeners.size};
}
module.exports={create,...create()};
