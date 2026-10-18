'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {align,timeNY}=require('../src/stock-neural-session');
const bar=(date,t)=>({openTime:timeNY(date,t),closeTime:timeNY(date,t)+3599999,close:100,closed:true});
test('calendario permite fin de semana y cambio horario, pero rechaza una vela intradía ausente',()=>{
 const cal=[{date:'2026-03-06',open:'09:30',close:'16:00'},{date:'2026-03-09',open:'09:30',close:'16:00'}];
 const bars=[bar('2026-03-06','14:00'),bar('2026-03-06','15:00'),bar('2026-03-09','10:00'),bar('2026-03-09','11:00')];
 assert.equal(align(bars,cal,3600000).length,4);assert.throws(()=>align(bars.filter((_,i)=>i!==1),cal,3600000));
 assert.equal(timeNY('2026-03-09','10:00')-timeNY('2026-03-06','10:00'),71*3600000);
});
test('cierre anticipado no exige velas fuera de sesión y recorta objetivo',()=>{
 const cal=[{date:'2026-11-27',open:'09:30',close:'13:00'},{date:'2026-11-30',open:'09:30',close:'16:00'}];
 assert.equal(align([bar('2026-11-27','12:00'),bar('2026-11-30','10:00')],cal,3600000).length,2);
 assert.throws(()=>align([bar('2026-11-27','13:00')],cal,3600000));
});
