'use strict';
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'../datos/bot-runtime.json');
function write(data){const tmp=file+'.tmp';fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(tmp,JSON.stringify({...data,pid:process.pid,at:Date.now(),mode:'simulación'}));fs.renameSync(tmp,file);}
function read(){try{const data=JSON.parse(fs.readFileSync(file,'utf8'));const fresh=Date.now()-data.at<45000;let alive=false;try{process.kill(data.pid,0);alive=true;}catch{}return {...data,running:fresh&&alive&&data.running===true};}catch{return {running:false,mode:'simulación'};}}
module.exports={write,read};
