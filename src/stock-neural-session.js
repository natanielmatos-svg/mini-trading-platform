'use strict';
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function dateNY(t){const p=Object.fromEntries(fmt.formatToParts(t).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;}
function timeNY(date,time){
 const noon=Date.parse(date+'T12:00:00Z');const zone=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(noon).find(p=>p.type==='timeZoneName').value;
 const offset=Number(zone.replace('GMT',''));return Date.parse(date+'T'+time+':00Z')-offset*3600000;
}
function align(candles,calendar,step){
 if(!Array.isArray(calendar)||!calendar.length||!(step>0)||step>86400000)throw Error('Calendario o intervalo bursátil no compatible con el motor neuronal.');
 const sessions=calendar.map(d=>({date:d.date,open:timeNY(d.date,d.open),close:timeNY(d.date,d.close)}));
 const expected=[];
 for(const s of sessions){if(!Number.isFinite(s.open)||!(s.close>s.open))throw Error('Calendario bursátil inválido.');
  if(step===86400000)expected.push(timeNY(s.date,'00:00'));else for(let t=Math.ceil(s.open/step)*step;t<s.close;t+=step)expected.push(t);
 }
 const positions=new Map(expected.map((t,i)=>[t,i]));
 const output=candles.map(c=>{const s=sessions.find(s=>dateNY(c.openTime)===s.date);return {...c,closeTime:s?Math.min(c.closeTime,s.close-1):c.closeTime};});
 for(let i=0;i<output.length;i++){const c=output[i],pos=positions.get(c.openTime);if(pos==null||(i&&pos!==positions.get(output[i-1].openTime)+1))throw Error('Faltan velas dentro de una sesión bursátil; no se rellenan precios.');}
 return output;
}
module.exports={dateNY,timeNY,align};
