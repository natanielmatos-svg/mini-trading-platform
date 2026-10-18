'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),file=path.join(root,'datos/bot-control.json'),lock=path.join(root,'datos/bot-process.lock');
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function read(){try{const v=JSON.parse(fs.readFileSync(file,'utf8'));if(typeof v.botEnabled!=='boolean'||typeof v.agentEnabled!=='boolean')throw Error();return v;}catch(e){if(e.code==='ENOENT')return {botEnabled:true,agentEnabled:false};throw Error('Control del bot no legible; entradas bloqueadas');}}
function save(v){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v));fs.renameSync(tmp,file);return v;}
function lockedPid(){try{return Number(fs.readFileSync(lock,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function acquire(){fs.mkdirSync(path.dirname(lock),{recursive:true});const pid=lockedPid();if(pid!==null){if(alive(pid))throw Error('Ya existe un proceso del bot');fs.unlinkSync(lock);}fs.writeFileSync(lock,String(process.pid),{flag:'wx'});process.once('exit',()=>{if(lockedPid()===process.pid)fs.unlinkSync(lock);});}
let starting=false;
async function command(action){
 if(!['start','stop','agent-on','agent-off','pause','resume'].includes(action))throw Error('Acción no válida');
 if(starting)throw Error('Inicio en curso; espera unos segundos');
 const current=read();
 if(action==='pause'||action==='resume'){const settings=require('./trading-settings');settings.save({...settings.read(),paused:action==='pause'});return current;}
 if(action==='agent-on'){
  const agent=require('./agente');if(!process.env[agent.PROVEEDOR==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY'])throw Error('Falta la credencial del agente');
 }
 if(action!=='start')return save({...current,...(action==='stop'?{botEnabled:false}:{agentEnabled:action==='agent-on'})});
 const runtime=require('./bot-runtime').read();
 if(alive(lockedPid())||alive(runtime.pid)){if(!current.botEnabled)throw Error('El bot todavía está terminando; espera antes de reiniciar');return current;}
 starting=true;
 save({...current,botEnabled:true});
 const log=path.join(root,'datos/logs');fs.mkdirSync(log,{recursive:true});const out=fs.openSync(path.join(log,'bot-control.log'),'a');
 try{
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts/agente.js'),'--web'],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,out]});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
  return read();
 }catch(e){save({...current,botEnabled:false});throw Error('No se pudo iniciar el bot');}
 finally{fs.closeSync(out);starting=false;}
}
module.exports={read,save,acquire,command};
