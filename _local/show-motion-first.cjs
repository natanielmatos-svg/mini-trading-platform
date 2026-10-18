const fs=require('node:fs');
const file='public/learning.js';let text=fs.readFileSync(file,'utf8');
const start=text.indexOf('   if(data.pilot?.motionCandidate)'),end=text.indexOf('   if(data.minuteLab)',start);
if(start<0||end<0)throw Error('Candidate block missing');
let block=text.slice(start,end).replace('Candidato BRTI · movimiento y libro','Nuevo modelo de IA · BRTI y libro de Kalshi');
text=text.slice(0,start)+text.slice(end);
const marker="   if(data.pilot?.loadingHistory)";const position=text.indexOf(marker);if(position<0)throw Error('Target missing');
text=text.slice(0,position)+block+text.slice(position);fs.writeFileSync(file,text);
for(const html of ['public/index.html','public/acciones.html']){let s=fs.readFileSync(html,'utf8');s=s.replace('/learning.js?v=10','/learning.js?v=11');fs.writeFileSync(html,s);}
