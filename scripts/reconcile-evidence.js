'use strict';
// Recuperación de etiquetas oficiales: no reconstruye predicciones ni toca órdenes.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}}
async function main(){
 const runtime=require('../src/bot-runtime').read();
 const lock=path.join(root,'datos/bot-process.lock');
 if(alive(runtime.pid)||(fs.existsSync(lock)&&alive(Number(fs.readFileSync(lock,'utf8')))))throw Error('Detén el bot antes de reconciliar para evitar escritores simultáneos');
 const E=require('../src/evidencia'),R=require('../src/registro');
 const backup=E.RUTA+'.backup-'+Date.now();fs.copyFileSync(E.RUTA,backup,fs.constants.COPYFILE_EXCL);
 const service=E.crear(),summary={consultados:0,recuperados:0,errores:0};
 for(let i=0;i<100;i++){
  const batch=await service.resolver(async ticker=>{
   await new Promise(resolve=>setTimeout(resolve,500));
   return require('../src/kalshi-settlement').fetchResult(ticker);
  });
  for(const k of Object.keys(summary))summary[k]+=batch[k];
  console.log(JSON.stringify({batch:i+1,...batch}));
  if(batch.consultados<20)break;
 }
 console.log(JSON.stringify({summary,evidence:E.resumir(R.leer({ruta:E.RUTA}).entradas)},null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
