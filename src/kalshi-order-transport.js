'use strict';
const crypto=require('node:crypto');
const BASES={demo:'https://demo-api.kalshi.co/trade-api/v2',production:'https://external-api.kalshi.com/trade-api/v2'};
// Dormant adapter. No environment flag or module import enables writes.
function create({environment='demo',keyId,privateKey,allowWrites=false,role='observer',fetchImpl=fetch,clock=Date.now}={}){
 if(!Object.hasOwn(BASES,environment))throw Error('Entorno no permitido');
 async function request(method,route,body){
  if(method!=='GET'&&(!allowWrites||role!=='bot'))throw Error('Envío de órdenes desactivado');
  if(!keyId||!privateKey)throw Error('Credenciales no configuradas');
  const url=new URL(BASES[environment]+route),timestamp=String(clock());
  const signature=crypto.sign('sha256',Buffer.from(timestamp+method+url.pathname),{key:privateKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST}).toString('base64');
  // Never retry a mutation, follow redirects, or return provider bodies containing account details.
  const response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','KALSHI-ACCESS-KEY':keyId,'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){
   const error=Error('Kalshi HTTP '+response.status+'; reconciliar antes de repetir');
   error.httpStatus=response.status;
   try{const data=await response.json(),code=data.error?.code??data.code;
    if(typeof code==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(code))error.providerCode=code;
   }catch{}
   throw error;
  }
  return response.json();
 }
 return {
  environment,
  fundDemoShard:({destination,amountUSD})=>{
   if(environment!=='demo'||!Number.isInteger(destination)||destination<=0||destination>100||typeof amountUSD!=='number'||amountUSD<=0||amountUSD>1||!Number.isInteger(amountUSD*10000))throw Error('Solo financiación demo de hasta 1 USD ficticio');
   return request('POST','/portfolio/intra_exchange_instance_transfer',{source:'event_contract',destination:'event_contract',amount:amountUSD*10000,source_exchange_shard:0,destination_exchange_shard:destination,source_subaccount:0,destination_subaccount:0});
  },
  read:route=>{if(typeof route!=='string'||!/^\/[a-z]/.test(route)||route.includes('..')||route.includes('\\'))throw Error('Ruta no permitida');return request('GET',route);},
  submit:body=>request('POST','/portfolio/events/orders',body),
  async get(id,ticker){
   let query='';if(ticker){const m=(await request('GET','/markets/'+encodeURIComponent(ticker))).market;if(!Number.isInteger(m?.exchange_index))throw Error('Sección de mercado no verificada');query='?exchange_index='+m.exchange_index;}
   return (await request('GET','/portfolio/orders/'+encodeURIComponent(id)+query)).order;
  },
  cancel:(id,ticker)=>request('DELETE','/portfolio/events/orders/'+encodeURIComponent(id)+'?market_ticker='+encodeURIComponent(ticker)),
  async find(clientId,ticker){
   let shard='';
   if(ticker){const m=(await request('GET','/markets/'+encodeURIComponent(ticker))).market;if(!Number.isInteger(m?.exchange_index))throw Error('Sección de mercado no verificada');shard='&exchange_index='+m.exchange_index;}
   let cursor='';const seen=new Set();
   for(let i=0;i<100;i++){
    const r=await request('GET','/portfolio/orders?limit=100'+shard+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if(!Array.isArray(r.orders))throw Error('Respuesta de órdenes incompleta');
    const matches=r.orders.filter(o=>o.client_order_id===clientId);
    if(matches.length>1)throw Error('Identificador duplicado en Kalshi');
    if(matches.length)return matches[0];
    if(!r.cursor)return null;
    if(seen.has(r.cursor))throw Error('Paginación repetida');
    seen.add(r.cursor);cursor=r.cursor;
   }
   throw Error('Histórico incompleto');
  }
 };
}
module.exports={create};
