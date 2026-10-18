'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateForSave}=require('./trading-settings');
const {fillValue}=require('./kalshi-fill-value');
const VERSION='kalshi-executor-v1';
function failure(error){
 return {at:Date.now(),httpStatus:Number.isInteger(error?.httpStatus)?error.httpStatus:null,providerCode:typeof error?.providerCode==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(error.providerCode)?error.providerCode:null};
}
const units=value=>{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.round(value*1e6))||Math.abs(value*1e6-Math.round(value*1e6))>1e-6)throw Error('Importe no válido');
 return Math.round(value*1e6);
};
function normalize(input){
 if(!input||!/^[-A-Z0-9]{1,150}$/.test(input.ticker)||!['yes','no'].includes(input.side)||!['buy','sell'].includes(input.action)||!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>1000000)throw Error('Orden no válida');
 const price=units(input.price),fee=units(input.maxFees);
 if(price<=0||price>=1e6||price%10000!==0||!Number.isSafeInteger(input.expiresAt))throw Error('Precio o caducidad no válida');
 return {ticker:input.ticker,side:input.side,action:input.action,quantity:input.quantity,price:input.price,maxFees:fee/1e6,expiresAt:input.expiresAt};
}
function payload(intent,id){
 const p=normalize(intent),yesPrice=p.side==='yes'?units(p.price):1e6-units(p.price);
 return {ticker:p.ticker,client_order_id:id,side:(p.side==='yes')===(p.action==='buy')?'bid':'ask',count:p.quantity.toFixed(2),price:(yesPrice/1e6).toFixed(4),time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',cancel_order_on_pause:true,reduce_only:p.action==='sell',subaccount:0};
}
function fingerprint(intent){return crypto.createHash('sha256').update(JSON.stringify(normalize(intent))).digest('hex');}
// File lock spans preflight, durable reservation, network call and reconciliation.
// A leftover lock after a crash requires operator investigation, never automatic expiry.
function create({directory,transport,settings,preflight,enabled=false,clock=Date.now}){
 if(!directory)throw Error('Falta directorio del registro');
 const file=path.join(directory,'orders.json'),lock=path.join(directory,'executor.lock');
 function read(){
  let s;try{s=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {version:VERSION,orders:[]};throw Error('Registro ilegible; ejecución bloqueada');}
  if(s.version!==VERSION||!Array.isArray(s.orders)||s.orders.some(r=>!Number.isSafeInteger(r.reserved)||r.reserved<0||r.environment!==transport.environment||fingerprint(r.intent)!==r.fingerprint||!['pending','unknown','acknowledged','resting','canceled','executed','absent_after_close'].includes(r.state))||new Set(s.orders.map(r=>r.clientId)).size!==s.orders.length)throw Error('Registro no válido');
  return s;
 }
 function write(s){const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(s,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
 async function exclusive(fn){
  fs.mkdirSync(directory,{recursive:true});let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch{throw Error('Ejecutor ocupado o recuperación pendiente');}
  try{return await fn();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
 }
 function find(s,id){const r=s.orders.find(r=>r.clientId===id);if(!r)throw Error('Orden no registrada');return r;}
 function merge(r,o){
  if(!o||!o.order_id||o.client_order_id!==r.clientId||o.ticker!==r.intent.ticker||(r.orderId&&r.orderId!==o.order_id))throw Error('Identidad de orden no verificada');
  const expected=payload(r.intent,r.clientId);
  if(o.book_side!==expected.side||Number(o.yes_price_dollars)!==Number(expected.price))throw Error('Lado o precio de orden no verificado');
  const filled=Number(o.fill_count_fp),remaining=Number(o.remaining_count_fp),initial=Number(o.initial_count_fp);
  if(![o.fill_count_fp,o.remaining_count_fp,o.initial_count_fp].every(v=>typeof v==='string'&&/^\d+(\.\d+)?$/.test(v))||!Number.isFinite(filled)||filled<0||remaining<0||initial!==r.intent.quantity||filled+remaining>initial||filled<(r.filled||0)||!['resting','canceled','executed'].includes(o.status)||(o.status==='executed'&&filled!==initial)||(o.status!=='resting'&&remaining!==0))throw Error('Ejecuciones no verificables');
  const costNames=['taker_fill_cost_dollars','maker_fill_cost_dollars','taker_fees_dollars','maker_fees_dollars'];
  if(!costNames.every(k=>typeof o[k]==='string'&&/^\d+(\.\d{1,6})?$/.test(o[k])))throw Error('Costes de ejecución pendientes');
  const amounts=costNames.map(k=>units(Number(o[k]))),fees=amounts[2]+amounts[3];
  if(fees>units(r.intent.maxFees)||(r.intent.action==='buy'&&amounts[0]+amounts[1]+fees>r.reserved))throw Error('Costes reales superan la reserva; revisión requerida');
  const value=fillValue(amounts[0]+amounts[1],filled,r.intent,o);
  r.orderId=o.order_id;r.filled=filled;r.remaining=remaining;r.state=o.status;r.fees=fees;r.rawOutcomeCost=amounts[0]+amounts[1];r.cost=value;r.checkedAt=clock();
  delete r.error;
  // A canceled order may have fills. Retain its entire budget if any contract filled.
  if(o.status==='canceled'&&filled===0&&fees===0)r.reserved=0;
 }
 async function reconcileRecord(s,r){
  try{const o=r.orderId?await transport.get(r.orderId,r.intent.ticker):await transport.find(r.clientId,r.intent.ticker);if(!o)throw Error('No encontrada; no demuestra que no se envió');merge(r,o);}catch(e){r.state='unknown';r.error='Reconciliación pendiente; no reenviar';r.reconciliationFailure=failure(e);}
  write(s);return structuredClone(r);
 }
 return {
  snapshot:()=>structuredClone(read()),
  async auditUnconfirmedDemo(id,openingBalance){
   if(transport.environment!=='demo')throw Error('Auditoría disponible solo en demo');
   return exclusive(async()=>{
    const s=read(),r=find(s,id);
    if(s.orders.length!==1||r.state!=='unknown'||r.orderId)throw Error('Auditoría requiere primer envío sin ID');
    const {snapshot,pages}=require('./kalshi-execution-preflight');
    const market=(await transport.read('/markets/'+encodeURIComponent(r.intent.ticker))).market;
    if(market?.ticker!==r.intent.ticker||!['closed','settled','finalized'].includes(market.status)||!(Date.parse(market.close_time)+60000<clock()))throw Error('Esperar cierre definitivo del mercado');
    const a=await snapshot(transport,clock);
    if(!Number.isSafeInteger(openingBalance)||a.balance!==openingBalance||a.orders.length||a.positions.some(p=>Number(p.position_fp)!==0)||a.settlements.length)throw Error('Cuenta no vacía o saldo modificado');
    for(const shard of Object.keys(a.shardBalances)){
     const fills=await pages(transport.read,'/portfolio/fills?exchange_index='+shard,'fills');if(fills.length)throw Error('Hay ejecuciones; no resolver por ausencia');
    }
    // No resend and no budget release: retain worst-case reservation despite absence.
    r.state='absent_after_close';r.audit={at:clock(),marketClosed:true,allShardsChecked:true,balanceUnchanged:true,reservationRetained:true};delete r.error;write(s);return structuredClone(r);
   });
  },
  async submit(input,{clientId,confirmedFingerprint}={}){
   if(!enabled)throw Error('Ejecutor desactivado');
   const intent=normalize(input),hash=fingerprint(intent);
   if(!/^[a-f0-9-]{36}$/.test(clientId||'')||confirmedFingerprint!==hash)throw Error('Falta confirmación exacta de la orden');
   return exclusive(async()=>{
    const s=read(),existing=s.orders.find(r=>r.clientId===clientId);
    if(existing){if(existing.fingerprint!==hash)throw Error('Identificador reutilizado con otra orden');return structuredClone(existing);}
    if(s.orders.some(r=>['pending','unknown','acknowledged','resting'].includes(r.state)))throw Error('Reconciliación pendiente');
    const started=clock(),v=await preflight(intent),now=clock();
    const c=validateForSave(settings()); // Recheck pause and limits after asynchronous I/O.
    if(c.paused&&intent.action==='buy')throw Error('Entradas en pausa');
    if(intent.expiresAt<=now||intent.expiresAt>now+15000||now-started>10000)throw Error('Orden vencida o ventana no válida');
    if(!v||v.complete!==true||!Number.isFinite(v.checkedAt)||v.checkedAt>now||now-v.checkedAt>5000||v.ticker!==intent.ticker||v.marketActive!==true||!(v.closeTime>now)||v.feesVerified!==true||v.rulesVerified!==true)throw Error('Cuenta, mercado o tarifas sin verificar');
    const fee=units(intent.maxFees),requiredFee=units(v.feeUpperBound);
    if(requiredFee>fee)throw Error('Reserva de comisiones insuficiente');
    const cost=intent.action==='buy'?units(intent.price)*intent.quantity+fee:fee;
    const reserved=s.orders.reduce((sum,r)=>sum+r.reserved,0),external=units(v.externalLiability),loss=units(v.realizedLoss),balance=units(v.balance);
    const daily=Math.floor(c.capital*c.maxDailyLossPct)*10000;
    if(cost>units(c.maxPerTrade??daily/1e6)||cost>balance||reserved+external+loss+cost>Math.min(daily,units(c.capital)))throw Error('Presupuesto insuficiente con comisiones y exposición');
    if(intent.action==='sell'&&(!Number.isFinite(v.heldQuantity)||v.heldQuantity<intent.quantity))throw Error('Venta superior a la posición verificada');
    const r={clientId,fingerprint:hash,intent,state:'pending',reserved:cost,createdAt:now,environment:transport.environment};s.orders.push(r);write(s);
    try{
     const response=await transport.submit(payload(intent,clientId));
     if(!response?.order_id||response.client_order_id!==clientId)throw Error('Respuesta no verificable');
     r.orderId=response.order_id;r.state='acknowledged';write(s);
    }catch(e){r.state='unknown';r.error='Resultado de envío desconocido; no reenviar';r.submissionFailure=failure(e);write(s);return structuredClone(r);}
    return reconcileRecord(s,r);
   });
  },
  reconcile:id=>exclusive(async()=>{const s=read();return reconcileRecord(s,find(s,id));}),
  async cancel(id){
   if(!enabled)throw Error('Ejecutor desactivado');
   return exclusive(async()=>{const s=read(),r=find(s,id);if(!r.orderId)throw Error('Primero reconciliar identidad');
    // Cancellation acknowledgement is not proof that the order had no fills.
    r.state='unknown';write(s);
    try{await transport.cancel(r.orderId,r.intent.ticker);}catch{r.error='Cancelación sin confirmar';}
    return reconcileRecord(s,r);
   });
  }
 };
}
module.exports={create,payload,fingerprint,VERSION};
