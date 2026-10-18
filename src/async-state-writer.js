'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
// Single writer: coalesce requests, encode current state at execution time,
// and atomically replace only after the temporary file is complete.
function createWriter({file,encode,io=fs}){
 let dirty=false,pending=null,error=null;
 function request(){dirty=true;if(pending)return;
  pending=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
   await io.mkdir(path.dirname(file),{recursive:true});
   while(dirty){dirty=false;const data=encode();await io.writeFile(file+'.tmp',data);await io.rename(file+'.tmp',file);error=null;}
  }).catch(e=>{error=e;}).finally(()=>{pending=null;});
 }
 async function flush(){while(pending)await pending;if(error)throw error;}
 return {request,flush};
}
module.exports={createWriter};
