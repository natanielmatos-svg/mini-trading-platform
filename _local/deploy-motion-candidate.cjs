const {execFileSync,spawn}=require('node:child_process'),fs=require('node:fs');
const connections=execFileSync('netstat',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true});
if(!connections.split('\n').some(l=>/127\.0\.0\.1:3000\s+0\.0\.0\.0:0\s+LISTENING\s+14032\s*$/.test(l)))throw Error('Server PID changed; stop');
process.kill(14032);
setTimeout(()=>{const log=fs.openSync('datos/logs/motion-candidate-server.log','a');const p=spawn(process.execPath,['server.js'],{cwd:'C:/opt/mini-trading-platform',windowsHide:true,detached:true,stdio:['ignore',log,log]});p.unref();console.log('server',p.pid);},1500);
