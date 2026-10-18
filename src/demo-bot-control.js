const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'datos/executor-demo'),file=path.join(dir,'control.json');
function read(){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {paused:false,stopRequested:false};throw Error('Control demo ilegible');}}
function status(){let last=null;try{last=JSON.parse(fs.readFileSync(path.join(dir,'strategy-status.json'),'utf8'));}catch{}return {...read(),running:fs.existsSync(path.join(dir,'strategy.lock')),last,environment:'demo',productionEnabled:false};}
function command(action){if(!['start','pause','resume','stop'].includes(action))throw Error('Acción no válida');const current=read();if(action==='start'&&status().running)throw Error('Sesión demo ya activa');const next={...current,paused:action==='pause'||action==='stop'?true: false,stopRequested:action==='stop',at:Date.now()};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(next));fs.renameSync(file+'.tmp',file);
 if(action==='start'){const out=fs.openSync(path.join(dir,'bot-session.log'),'a');try{const child=require('node:child_process').spawn(process.execPath,[path.join(root,'scripts/kalshi-demo-strategy.js'),'--execute','--cycles=20'],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,out]});child.on('error',()=>{});child.unref();}finally{fs.closeSync(out);}}
 return status();}
module.exports={read,status,command};
