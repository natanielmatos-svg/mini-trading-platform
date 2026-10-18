const fs=require('node:fs');for(const prefix of ['web-','gateway-']){const names=fs.readdirSync('datos/logs').filter(n=>n.startsWith(prefix)).sort().slice(-2);for(const n of names)console.log(n,fs.readFileSync('datos/logs/'+n,'utf8').slice(-5000));}
for(const pid of [15740,14760])try{process.kill(pid,0);console.log('alive',pid);}catch{console.log('gone',pid);}
