'use strict';
const fs=require('node:fs'),path=require('node:path');
let feed=null,error=null,restFallbacks=0;
function instance(){if(!feed){const {KalshiWebSocket}=require('./kalshi-websocket');const keyId=process.env.KALSHI_API_KEY_ID,keyPath=process.env.KALSHI_PRIVATE_KEY_PATH;if(!keyId||!keyPath)throw Error('Falta configuración de lectura');feed=new KalshiWebSocket({environment:'production',keyId,privateKey:fs.readFileSync(path.resolve(__dirname,'..',keyPath))});}return feed;}
async function obtener(ticker,options={}){
 try{const stream=instance();stream.watch(ticker);const b=stream.current(options);if(b)return b;}catch{error='WebSocket no disponible; se utiliza REST';}
 restFallbacks++;const b=await require('./kalshi-book').obtener(ticker);return {...b,source:'kalshi-rest',environment:'production',ticker,receivedAt:Date.now(),sourceAt:null};
}
function status(){return {...(feed?.status()||{connected:false,bookReady:false}),error:feed?.status().error||error,restFallbacks,mode:'read-only'};}
function close(){feed?.close();feed=null;}
module.exports={obtener,status,close};
