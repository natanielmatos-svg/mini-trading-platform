'use strict';
const {EventEmitter}=require('node:events');
const {signedHeaders}=require('./kalshi-reference');
const URLS=Object.freeze({production:'wss://external-api-ws.kalshi.com/trade-api/ws/v2',demo:'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2'});
function fixed(value,scale){
 if(typeof value!=='string'||!/^[-]?\d+(\.\d+)?$/.test(value))throw Error('Decimal inválido');
 const n=Number(value)*scale,r=Math.round(n);if(!Number.isSafeInteger(r)||Math.abs(n-r)>1e-6)throw Error('Precisión inválida');return r;
}
// Read-only, one market per connection. Discard state on any discontinuity.
class KalshiWebSocket extends EventEmitter{
 constructor({environment='demo',keyId,privateKey,WebSocketImpl,clock=Date.now,random=Math.random}={}){
  super();if(!Object.hasOwn(URLS,environment))throw Error('Entorno WebSocket inválido');
  this.environment=environment;this.keyId=keyId;this.privateKey=privateKey;this.Impl=WebSocketImpl;this.clock=clock;this.random=random;
  this.ws=null;this.ticker=null;this.stopped=true;this.reconnect=null;this.heartbeat=null;this.command=0;this.attempts=0;this.connected=false;this.lastError=null;this.lastActivity=0;this.book=null;this.sid=null;this.seq=null;this.gaps=0;this.received=0;
 }
 watch(ticker){if(typeof ticker!=='string'||!/^[A-Za-z0-9_.-]{1,160}$/.test(ticker))throw Error('Contrato inválido');if(ticker===this.ticker&&!this.stopped)return;
  this.close();this.ticker=ticker;this.stopped=false;this.attempts=0;this.connect();
 }
 connect(){
  if(this.stopped||this.ws)return;clearTimeout(this.reconnect);this.reconnect=null;
  try{
   const WS=this.Impl||require('ws'),url=URLS[this.environment];
   const socket=new WS(url,{headers:signedHeaders(this.keyId,this.privateKey,url,this.clock()),handshakeTimeout:8000,followRedirects:false,perMessageDeflate:false,maxPayload:4*1024*1024,autoPong:true});
   this.ws=socket;this.lastActivity=this.clock();
   socket.on('open',()=>{if(this.ws!==socket||this.stopped)return;this.connected=true;this.lastActivity=this.clock();this.pendingId=++this.command;
    socket.send(JSON.stringify({id:this.pendingId,cmd:'subscribe',params:{channels:['orderbook_delta'],market_ticker:this.ticker}}));
    this.heartbeat=setInterval(()=>{if(this.clock()-this.lastActivity>30000||(!this.book&&this.clock()-this.openedAt>20000))this.fail('Sin respuesta reciente o snapshot');else if(socket.readyState===1)socket.ping();},10000);this.heartbeat.unref?.();this.openedAt=this.clock();
   });
   for(const event of ['ping','pong'])socket.on(event,()=>{if(this.ws===socket)this.lastActivity=this.clock();});
   socket.on('message',data=>{if(this.ws!==socket||this.stopped)return;try{this.handle(JSON.parse(data.toString()));}catch{this.fail('Mensaje inválido; libro descartado');}});
   socket.on('error',()=>{if(this.ws===socket)this.fail('Error de conexión WebSocket');});
   socket.on('close',()=>{if(this.ws===socket){this.clearSocket();this.schedule();}});
  }catch{this.fail('No se pudo establecer WebSocket autenticado');}
 }
 clearSocket(){const socket=this.ws;this.ws=null;this.connected=false;this.book=null;this.sid=null;this.seq=null;clearInterval(this.heartbeat);this.heartbeat=null;if(socket){socket.removeAllListeners();socket.on('error',()=>{});socket.terminate();}}
 fail(reason){this.lastError=reason;this.clearSocket();this.emit('status',this.status());this.schedule();}
 schedule(){if(this.stopped||this.reconnect)return;const delay=Math.min(60000,1000*2**Math.min(this.attempts++,6))*(.8+.4*this.random());this.reconnect=setTimeout(()=>{this.reconnect=null;this.connect();},delay);this.reconnect.unref?.();}
 handle(message){
  const now=this.clock();this.lastActivity=now;
  if(message.type==='error')throw Error('Suscripción rechazada');
  if(message.type==='subscribed'){
   if(message.id!==this.pendingId||message.msg?.channel!=='orderbook_delta'||!Number.isInteger(message.msg.sid))throw Error('Suscripción no confirmada');this.sid=message.msg.sid;return;
  }
  if(!['orderbook_snapshot','orderbook_delta'].includes(message.type))return;
  if(message.sid!==this.sid||!Number.isInteger(message.seq)||message.msg?.market_ticker!==this.ticker)throw Error('Libro ajeno a suscripción');
  if(this.seq!==null&&message.seq!==this.seq+1){this.gaps++;throw Error('Secuencia incompleta');}
  const payload=message.msg,snapshot=message.type==='orderbook_snapshot';
  if(!snapshot&&!this.book)throw Error('Delta sin snapshot');
  const sourceAt=message.sending_ts_ms;
  if(!Number.isFinite(sourceAt)||sourceAt>now+1000||now-sourceAt>5000)throw Error('Marca de envío inválida o atrasada');
  const book=snapshot?{yes:new Map(),no:new Map()}:this.book;
  if(snapshot){for(const side of ['yes','no']){const rows=payload[side+'_dollars_fp'];if(!Array.isArray(rows))throw Error('Snapshot incompleto');for(const row of rows){if(!Array.isArray(row)||row.length!==2)throw Error();const p=fixed(row[0],10000),q=fixed(row[1],100);if(p<=0||p>=10000||q<0||book[side].has(p))throw Error('Nivel inválido');if(q)book[side].set(p,q);}}}
  else{if(!['yes','no'].includes(payload.side))throw Error('Lado inválido');const p=fixed(payload.price_dollars,10000),delta=fixed(payload.delta_fp,100),q=(book[payload.side].get(p)||0)+delta;if(p<=0||p>=10000||q<0||!Number.isSafeInteger(q))throw Error('Delta inválido');if(q)book[payload.side].set(p,q);else book[payload.side].delete(p);}
  const best=side=>Math.max(0,...book[side].keys());if(best('yes')+best('no')>10000)throw Error('Libro cruzado');
  Object.assign(book,{at:now,sourceAt,eventAt:Number.isFinite(payload.ts_ms)?payload.ts_ms:null});this.book=book;this.seq=message.seq;this.received++;this.attempts=0;this.lastError=null;if(this.listenerCount('book'))this.emit('book',this.current());
 }
 current({notBefore=0,maxAgeMs=2000}={}){const b=this.book,now=this.clock();if(!this.connected||!b||b.at<notBefore||now-b.at>maxAgeMs||b.at>now)return null;
  const rows=side=>[...b[side]].sort((a,b)=>b[0]-a[0]).map(([p,q])=>({precio:p/10000,cantidad:q/100}));
  return {at:b.at,sourceAt:b.sourceAt,eventAt:b.eventAt,receivedAt:b.at,source:'kalshi-websocket',environment:this.environment,ticker:this.ticker,seq:this.seq,sid:this.sid,yes:rows('yes'),no:rows('no')};
 }
 status(){return {environment:this.environment,ticker:this.ticker,connected:this.connected,bookReady:!!this.current(),lastBookAt:this.book?.at??null,messages:this.received,sequenceGaps:this.gaps,error:this.lastError,stopped:this.stopped};}
 close(){this.stopped=true;clearTimeout(this.reconnect);this.reconnect=null;this.clearSocket();}
}
module.exports={KalshiWebSocket,URLS};
