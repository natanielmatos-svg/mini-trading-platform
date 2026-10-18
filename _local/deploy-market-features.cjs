const {execFileSync,spawn}=require('node:child_process'),fs=require('node:fs');
const connections=execFileSync('netstat',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true});
if(!connections.split('\n').some(l=>/127\.0\.0\.1:3000\s+0\.0\.0\.0:0\s+LISTENING\s+18560\s*$/.test(l)))throw Error('Server PID changed; stop');
process.kill(18560);
setTimeout(()=>{
 const log=fs.openSync('datos/logs/market-features-server.log','a');
 const child=spawn(process.execPath,['server.js'],{cwd:'C:/opt/mini-trading-platform',windowsHide:true,detached:true,stdio:['ignore',log,log]});child.unref();console.log('server',child.pid);
},1500);
