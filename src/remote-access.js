'use strict';
const http=require('node:http');
function config(env=process.env){
 const origin=new URL(env.TRADING_PUBLIC_ORIGIN||'https://trading.maroautogroup.com');
 const issuer=new URL(env.CF_ACCESS_ISSUER||'https://unconfigured.cloudflareaccess.com');
 const audience=env.CF_ACCESS_AUD,emails=(env.TRADING_ALLOWED_EMAILS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||issuer.protocol!=='https:'||!issuer.hostname.endsWith('.cloudflareaccess.com')||issuer.pathname!=='/'||issuer.port||issuer.search||issuer.hash||issuer.username||issuer.password||!audience||!emails.length)throw Error('Configura origen HTTPS, emisor Cloudflare Access, AUD y correos autorizados.');
 return {origin:origin.origin,host:origin.host,issuer:issuer.origin,audience,emails};
}
async function verifier(c,testKeys){const {jwtVerify,createRemoteJWKSet}=await import('jose');const keys=testKeys||createRemoteJWKSet(new URL(c.issuer+'/cdn-cgi/access/certs')); return async token=>{const {payload}=await jwtVerify(token,keys,{issuer:c.issuer,audience:c.audience,algorithms:['RS256'],requiredClaims:['exp','iat','email']});if(!c.emails.includes(String(payload.email).toLowerCase()))throw Error('Correo no autorizado');return payload;};}
function createGateway(c,verify,{upstreamPort=3000}={}){
 return http.createServer(async(req,res)=>{
  const deny=(code,msg)=>{res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(msg);};
  if(req.headers.host!==c.host)return deny(403,'Dominio no autorizado');
  if(!['GET','HEAD','POST'].includes(req.method))return deny(405,'Método no permitido');
  if(req.headers.origin&&req.headers.origin!==c.origin)return deny(403,'Origen no autorizado');
  if(req.method==='POST'&&req.headers.origin!==c.origin)return deny(403,'Origen requerido');
  // Access redirects back from another site. Only permit a top-level page GET;
  // the signed identity below remains mandatory, including for this navigation.
  const loginNavigation=req.method==='GET'&&req.url==='/'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  if(req.headers['sec-fetch-site']==='cross-site'&&!loginNavigation)return deny(403,'Solicitud entre sitios bloqueada');
  try{const token=req.headers['cf-access-jwt-assertion'];if(typeof token!=='string'||token.length>16384)throw Error();await verify(token);}catch{return deny(403,'Inicia sesión mediante Cloudflare Access.');}
  // Forward only explicitly selected headers; never trust client forwarding/identity headers.
  const headers={host:'127.0.0.1:3000'};
  for(const k of ['accept','content-type','content-length','if-none-match','if-modified-since','last-event-id'])if(req.headers[k])headers[k]=req.headers[k];
  if(req.method==='POST')headers.origin='http://127.0.0.1:3000';
  const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:req.url,method:req.method,headers},reply=>{
   res.writeHead(reply.statusCode,{...reply.headers,'cache-control':'no-store'});reply.pipe(res);
  });
  upstream.setTimeout(210000,()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)deny(502,'Servicio local no disponible');else res.destroy();});
  res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });
}
module.exports={config,verifier,createGateway};
