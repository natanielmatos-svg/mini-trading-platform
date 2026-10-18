'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.join(__dirname,'..','datos');
function candidates(entries,config,bot,now=Date.now()){
 const latest=new Map();for(const e of entries)if(e.tipo==='decision'&&typeof e.ticker==='string')latest.set(e.ticker,e);
 return [...latest.values()].sort((a,b)=>Date.parse(b.t)-Date.parse(a.t)).slice(0,12).map(e=>{
  const at=Date.parse(e.t),expiresAt=Math.min(at+60000,Date.parse(e.vence));
  const valid=['yes','no'].includes(e.lado)&&Number.isFinite(e.precio)&&e.precio>0&&e.precio<1&&Number.isFinite(e.contratos)&&e.contratos>0&&Number.isFinite(e.comision)&&e.comision>=0;
  const total=valid?Math.ceil((e.precio*e.contratos+e.comision)*100)/100:null;
  const blockers=[];if(!e.operar||e.vetado)blockers.push(e.motivo||'El bot no recomienda esta entrada');
  if(!valid)blockers.push('Sin precio, cantidad y comisión de contrato verificables');
  if(!Number.isFinite(expiresAt)||expiresAt<=now||at>now)blockers.push('Evaluación vencida');
  if(!bot.running||config.paused)blockers.push('Bot detenido o entradas en pausa');
  if(total!==null&&(total>config.capital||total>config.capital*config.maxDailyLossPct/100||(config.maxPerTrade!==null&&total>config.maxPerTrade)))blockers.push('Importe superior a los límites configurados');
  const id=crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
  return {id,ticker:e.ticker,side:valid?e.lado:null,quantity:valid?e.contratos:null,price:valid?e.precio:null,estimatedFees:valid?e.comision:null,total,at,expiresAt,closesAt:Date.parse(e.vence)||null,source:e.fuente||'No declarada',reason:e.motivo||e.motivoSinVeto||'El modelo detectó una ventaja estimada; no demuestra beneficio',blockers,approvable:!blockers.length,liveEnabled:false};
 });
}
function create({root=ROOT,readEntries=()=>require('./registro').leer(),settings=()=>require('./trading-settings').read(),runtime=()=>require('./bot-runtime').read(),clock=Date.now}={}){
 const file=path.join(root,'proposal-reviews.json');
 function history(){try{const rows=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(rows))throw Error();return rows;}catch(e){if(e.code==='ENOENT')return [];throw Error('Historial de revisiones no legible');}}
 function snapshot(){const {entradas,rotas}=readEntries();if(rotas)throw Error('Registro de decisiones dañado');const reviews=history();return {liveEnabled:false,proposals:candidates(entradas,settings(),runtime(),clock()).map(p=>({...p,review:reviews.find(r=>r.id===p.id)||null})),history:reviews.slice(-20).reverse(),note:'Aprobar registra tu conformidad con esta propuesta exacta; no envía ni programa órdenes, no reserva saldo y no elimina bloqueos. Comisión estimada. La confirmación real se realiza en Kalshi.'};}
 function review(id,action){if(!/^[a-f0-9]{64}$/.test(id||'')||!['approve','reject'].includes(action))throw Error('Revisión no válida');const state=snapshot(),p=state.proposals.find(p=>p.id===id);if(!p)throw Error('Propuesta sustituida; actualiza la lista');if(p.review){if(p.review.action===action)return p.review;throw Error('La propuesta ya fue revisada');}if(action==='approve'&&!p.approvable)throw Error('No se puede aprobar una propuesta bloqueada o vencida');
  const row={id,action,at:clock(),proposal:p,execution:'not_sent'};const rows=history();rows.push(row);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(rows.slice(-1000)));fs.renameSync(file+'.tmp',file);return row;
 }
 return {snapshot,review};
}
module.exports={create,candidates};
