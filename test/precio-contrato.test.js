'use strict';
const test=require('node:test'),assert=require('node:assert');
const P=require('../src/precio-contrato');
const {comision}=require('../src/kalshi-edge');

const CIERRE=10_000_000;
const captura=({at,yesBid=0.48,yesAsk=0.52,spot=80000,umbral=80000,ticker='T',cierre=CIERRE,
                valido=true,libro=true,yes=[[0.48,100]],no=[[0.48,100]]})=>({
 type:'sample',ticker,at,closesAt:cierre,threshold:umbral,operator:'>',
 quotes:{yesBid,yesAsk,noBid:1-yesAsk,noAsk:1-yesBid},quoteValid:valido,freshBook:libro,
 book:libro?{at,yes,no}:null,
 predictions:[{observation:{price:spot}}]});

// Una trayectoria de n capturas cada 30 s terminando 'faltan' ms antes del cierre.
const ruta=(n,faltan,extra=()=>({}))=>Array.from({length:n},(_,i)=>
 captura({at:CIERRE-faltan-(n-1-i)*30000,...extra(i)}));

test('cada contrato produce una trayectoria ordenada en el tiempo',()=>{
 // Separadas de verdad: dentro de la misma ranura de 30 s se fundirían en una.
 const r=P.rutas([captura({at:90000}),captura({at:30000}),captura({at:60000})]);
 assert.deepEqual(r.get('T').map(s=>s.at),[30000,60000,90000]);
});

test('dos capturas de la misma ranura de 30 s cuentan una vez',()=>{
 // El id del piloto lleva floor(requestedAt/30000): la segunda es un reintento.
 const r=P.rutas([captura({at:30000}),captura({at:30001,yesAsk:0.9})]);
 assert.equal(r.get('T').length,1);
});

test('una captura con cotización inválida o libro viejo no entra',()=>{
 assert.equal(P.rutas([captura({at:100,valido:false})]).size,0);
 assert.equal(P.rutas([captura({at:100,libro:false})]).size,0);
});

test('la etiqueta es el neto de la ida y vuelta, no el movimiento del punto medio',()=>{
 const r=ruta(24,600000,i=>i>=14?{yesBid:0.58,yesAsk:0.62}:{});
 const m=P.muestras(r,{horizonteMs:300000});
 const primera=m.find(x=>x.ask===0.52);
 assert.ok(primera,'debería haber un par que entra a 0,52');
 // Entra pagando el ask, sale cobrando el bid, y paga comisión en los dos.
 const esperado=0.58-0.52-comision(1,0.52)-comision(1,0.58);
 assert.equal(Number(primera.y.toFixed(10)),Number(esperado.toFixed(10)));
 // El punto medio se movió 10c; lo cobrable es bastante menos.
 assert.ok(primera.y<0.10-0.02,'la horquilla y las dos comisiones tienen que estar dentro');
});

test('no se genera par si el horizonte cae después del cierre',()=>{
 // Seis capturas acabando 2 min antes del cierre: la más antigua está a 4:30
 // del final, así que NINGUNA llega a los 5 minutos. No hay a quién vender.
 const m=P.muestras(ruta(6,120000),{horizonteMs:300000});
 assert.equal(m.length,0);
 // Una ruta larga sí da pares: la diferencia es el cierre, no las capturas.
 // (Seis capturas abarcan 2:30, menos que el propio horizonte.)
 assert.ok(P.muestras(ruta(30,900000),{horizonteMs:300000}).length>0);
});

test('las variables no miran al futuro',()=>{
 // El precio salta en la captura 10. Las variables de la 9 no pueden notarlo.
 const r=ruta(20,600000,i=>i>=10?{yesBid:0.9,yesAsk:0.94}:{});
 const antes=P.variables(r,9),despues=P.variables(r,10);
 assert.equal(antes[0],0.52,'el ask de la 9 es el suyo, no el del salto');
 assert.equal(despues[0],0.94);
 assert.equal(antes[4],0,'sin movimiento previo, el arrastre de 60 s es cero');
 assert.ok(despues[4]>0,'después del salto el arrastre sí lo recoge');
});

test('sin histórico suficiente para el arrastre no hay variables',()=>{
 // Tres capturas son 90 s: no alcanza para mirar 180 s atrás.
 const r=ruta(3,600000);
 assert.equal(P.variables(r,2),null);
});

test('el desequilibrio del libro va de -1 a 1 y mira los tres mejores niveles',()=>{
 assert.equal(P.desequilibrio(captura({at:0,yes:[[0.5,300]],no:[[0.5,100]]})),0.5);
 assert.equal(P.desequilibrio(captura({at:0,yes:[[0.5,100]],no:[[0.5,100]]})),0);
 // El cuarto nivel se ignora a propósito: el fondo del libro no mueve el precio.
 const hondo=captura({at:0,yes:[[0.5,10],[0.49,10],[0.48,10],[0.1,9999]],no:[[0.5,30]]});
 assert.equal(P.desequilibrio(hondo),0);
});

test('un par se empareja con tolerancia de una captura perdida, no más',()=>{
 const base=ruta(30,600000);
 // Se borra la captura exacta de +300s para una entrada concreta.
 const entrada=base[10],objetivo=entrada.at+300000;
 const conHueco=base.filter(s=>s.at!==objetivo);
 assert.ok(P.muestras(conHueco,{horizonteMs:300000}).some(x=>x.at===entrada.at),
  'con una captura perdida todavía debe emparejar');
 const granHueco=base.filter(s=>Math.abs(s.at-objetivo)>60000);
 assert.ok(!P.muestras(granHueco,{horizonteMs:300000}).some(x=>x.at===entrada.at),
  'con dos minutos de hueco no debe inventarse la salida');
});

test('las muestras salen ordenadas por el momento de entrada',()=>{
 const m=P.muestras(ruta(30,600000),{horizonteMs:300000});
 for(let i=1;i<m.length;i++)assert.ok(m[i].at>=m[i-1].at);
});

// --- Ajuste y evaluación ---------------------------------------------------

test('el ajuste recupera una relación lineal que existe',()=>{
 const m=Array.from({length:400},(_,i)=>({x:[i%7,0,0,0,0,0,0],y:0.01*(i%7)-0.02,at:i,salidaAt:i+1}));
 const a=P.ajustar(m);
 assert.ok(Math.abs(a.predecir([0,0,0,0,0,0,0])-(-0.02))<0.002);
 assert.ok(Math.abs(a.predecir([6,0,0,0,0,0,0])-0.04)<0.002);
});

test('caminar sólo entrena con pares ya cerrados antes de la entrada',()=>{
 // Cada par se abre en `at` y se cierra en `salidaAt`. El par 250 no puede
 // haber entrenado con el 249 si éste seguía abierto.
 const m=Array.from({length:400},(_,i)=>({x:[0,0,0,0,0,0,0],y:0,at:i*10,salidaAt:i*10+5000}));
 const p=P.caminar(m,{minimo:50,cadaCuantas:1});
 for(const q of p){
  const cerrados=m.filter(r=>r.salidaAt<q.at).length;
  assert.ok(q.entrenamiento<=cerrados,
   `entrenó con ${q.entrenamiento} pares cuando sólo ${cerrados} habían cerrado`);
 }
});

test('sobre ruido puro NO encuentra ventaja',()=>{
 // Esta es la prueba que importa. Las variables no llevan información sobre y.
 // Si el modelo saca beneficio aquí, está mirando al futuro en alguna parte y
 // cualquier resultado sobre datos reales sería mentira.
 let s=20260101;
 const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648;
 const normal=()=>{let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
 const m=Array.from({length:3000},(_,i)=>({
  x:Array.from({length:7},()=>normal()),
  y:0.05*normal()-0.02,                 // media −2c: las dos comisiones
  at:i*30000,salidaAt:i*30000+300000}));
 const r=P.rendimiento(P.caminar(m,{minimo:200}),0);
 if(r.operaciones){
  // Sin información, filtrar no puede subir la media por encima de la base.
  // Se admiten dos errores estándar de margen.
  assert.ok(r.media<=-0.02+2*r.error,
   `inventó una media de ${(r.media*100).toFixed(2)}c sobre ruido puro`);
 }
});

test('sobre una señal real sí la encuentra, y filtrar mejora la media',()=>{
 let s=7777;
 const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648;
 const normal=()=>{let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
 const m=Array.from({length:3000},(_,i)=>{
  const x=Array.from({length:7},()=>normal());
  return {x,y:0.04*x[4]+0.03*normal()-0.02,at:i*30000,salidaAt:i*30000+300000};
 });
 const p=P.caminar(m,{minimo:200});
 const todas=P.rendimiento(p,-Infinity), filtradas=P.rendimiento(p,0);
 assert.ok(filtradas.operaciones>0,'debería operar alguna');
 assert.ok(filtradas.media>todas.media,'filtrar por la predicción debe mejorar la media');
});

test('rendimiento no inventa cifras cuando no opera nada',()=>{
 const r=P.rendimiento([{prediccion:-1,y:0.5}],0);
 assert.equal(r.operaciones,0);
 assert.equal(r.media,null);
});
