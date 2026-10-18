const {spawn,execFileSync}=require('node:child_process'),fs=require('node:fs');
const root='C:\\opt\\mini-trading-platform';
const net=execFileSync('netstat',['-ano','-p','tcp'],{encoding:'utf8'});
if(!/127\.0\.0\.1:3000\s+\S+\s+LISTENING\s+10008\b/.test(net))throw Error('Server PID changed; refusing restart');
process.kill(10008);
setTimeout(()=>{const out=fs.openSync(root+'\\datos\\diagnosticos\\live-ui-server.log','a'),err=fs.openSync(root+'\\datos\\diagnosticos\\live-ui-server-error.log','a');const child=spawn(process.execPath,[root+'\\server.js'],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]});child.unref();console.log('server pid',child.pid);},1500);
