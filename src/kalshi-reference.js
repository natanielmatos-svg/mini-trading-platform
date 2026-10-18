'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {fetchJson}=require('./http');
const {TtlCache}=require('./cache');
const cache=new TtlCache({ttlMs:2000,maxEntries:32});
const COINS=['AAVE','ADA','BCH','BNB','DOGE','DOT','ETH','HBAR','HYPE','LINK','LTC','NEAR','SHIB','SOL','SUI','VVV','WLD','XLM','XRP','ZEC'];
const INDICES={BTC:'BRTI',...Object.fromEntries(COINS.map(c=>[c,c+'USD_RTI']))};
function indexFor(symbol){return INDICES[String(symbol).replace(/(USDT|USDC|USD)$/,'')] || null;}
function signedHeaders(keyId,privateKey,url,now=Date.now()) {
  const timestamp=String(now);
  const signature=crypto.sign('sha256',Buffer.from(timestamp+'GET'+new URL(url).pathname),
    {key:privateKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST}).toString('base64');
  return {'KALSHI-ACCESS-KEY':keyId,'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature};
}
function parseValue(raw,index,now=Date.now(),{scoped=false}={}) {
  const payload=raw?.data?.payload;
  const rows=Array.isArray(payload)?payload:payload && typeof payload==='object' ? (payload.value!==undefined?[payload]:Object.values(payload)) : [];
  // /values?id= devuelve un histórico sin id en cada fila. Solo aceptar
  // filas anónimas cuando la petición estuvo acotada a ese único índice.
  const candidates=rows.filter(v=>v && ((v.id ?? v.index_id)===index || (scoped && v.id==null && v.index_id==null))).map(v=>{
    const stamp=v.time ?? v.timestamp;
    const number=typeof stamp==='number' || /^\d+(\.\d+)?$/.test(String(stamp)) ? Number(stamp) : NaN;
    const at=Number.isFinite(number)?(number<1e12?number*1000:number):Date.parse(stamp);
    if(!Number.isFinite(at))throw new Error('Índice con fecha inválida.');
    return {price:Number(v.value),at};
  });
  const entry=candidates.reduce((latest,v)=>!latest || v.at>latest.at?v:latest,null);
  const price=entry?.price, at=entry?.at;
  if(!Number.isFinite(price)||price<=0||!Number.isFinite(at))throw new Error('Índice sin precio o fecha de origen válidos.');
  if(now-at>15000 || at-now>5000)throw new Error('Índice atrasado o con fecha de origen incoherente.');
  const movement=require('./brti-movement').summarize(candidates,Math.min(at,now));
  const observedSeconds=candidates.filter(p=>p.at<=now&&p.at>=now-60000&&Number.isFinite(p.price)&&p.price>0).sort((a,b)=>b.at-a.at).slice(0,120);
  return {ok:true,price,at,observedAt:now,movement,observedSeconds,ageMs:Math.max(0,now-at),index,currency:'USD',source:'CF Benchmarks vía Kalshi',
    settlementPrice:null,note:'Valor instantáneo del índice. La liquidación cripto utiliza el promedio de 60 segundos indicado en las reglas del contrato.'};
}
async function getReference({symbol,demo=false,collect=false}={}) {
  const index=indexFor(symbol);
  if(!index)return {ok:false,reason:'No hay índice mapeado para este activo.',symbol};
  if(demo)return {ok:false,reason:'Modo demo: no se presentan datos simulados como referencia de Kalshi.',symbol,index};
  const keyId=process.env.KALSHI_API_KEY_ID;
  const keyPath=process.env.KALSHI_PRIVATE_KEY_PATH;
  if(!keyId || !keyPath)return {ok:false,reason:'Falta configurar la clave API de Kalshi y la ruta de su archivo privado en el servidor.',symbol,index,needsCredentials:true};
  return cache.wrap(index+':'+collect,async()=>{
    try{
      const privateKey=fs.readFileSync(path.resolve(__dirname,'..',keyPath));
      const url='https://external-api.kalshi.com/trade-api/v2/cfbenchmarks/values?id='+encodeURIComponent(index);
      const raw=await fetchJson(url,{headers:signedHeaders(keyId,privateKey,url),retries:0,timeoutMs:6000});
      const value = parseValue(raw,index,Date.now(),{scoped:true});
      if (collect) require('./reference-history').guardar(index,raw);
      return {...value,symbol};
    }catch(err){
      return {ok:false,symbol,index,reason:err.status ? `Kalshi no permitió obtener el índice (HTTP ${err.status}). Comprueba acceso y credenciales.` : 'No se pudo leer un índice reciente de Kalshi. Comprueba la clave y la conexión.'};
    }
  });
}
module.exports={getReference,parseValue,signedHeaders,indexFor};
