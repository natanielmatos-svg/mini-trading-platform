const fs=require('node:fs'),{execFileSync,spawn}=require('node:child_process');
(async()=>{
 const status=await fetch('http://localhost:3000/api/learning').then(r=>r.json());
 fs.writeFileSync('datos/diagnosticos/pre-price-trial-learning.json',JSON.stringify(status));
 const lag=await fetch('http://localhost:3000/api/kalshi-lag').then(r=>r.json());fs.writeFileSync('datos/diagnosticos/pre-price-trial-lag.json',JSON.stringify(lag));
 const c=execFileSync('netstat',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true});
 if(!c.split('\n').some(l=>/127\.0\.0\.1:3000\s+0\.0\.0\.0:0\s+LISTENING\s+5816\s*$/.test(l)))throw Error('PID changed');
 process.kill(5816);
 await new Promise(r=>setTimeout(r,1500));
 const log=fs.openSync('datos/logs/price-trial-server.log','a');const p=spawn(process.execPath,['server.js'],{cwd:process.cwd(),windowsHide:true,detached:true,stdio:['ignore',log,log]});p.unref();console.log('server',p.pid);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
