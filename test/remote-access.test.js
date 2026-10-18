'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {config,verifier,createGateway}=require('../src/remote-access');
const env={TRADING_PUBLIC_ORIGIN:'https://trading.example.com',CF_ACCESS_ISSUER:'https://test.cloudflareaccess.com',CF_ACCESS_AUD:'test-audience',TRADING_ALLOWED_EMAILS:'owner@example.com'};
test('Access return navigation requires a valid identity and never allows cross-site APIs or writes',async()=>{
 const http=require('node:http');
 const {generateKeyPair,SignJWT}=await import('jose');
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const token=await new SignJWT({email:'owner@example.com'}).setProtectedHeader({alg:'RS256'}).setIssuedAt().setIssuer(env.CF_ACCESS_ISSUER).setAudience(env.CF_ACCESS_AUD).setExpirationTime('5m').sign(privateKey);
 let forwarded=0;
 const origin=http.createServer((req,res)=>{forwarded++;res.end('app');});
 origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const server=createGateway(config(env),await verifier(config(env),publicKey),{upstreamPort:origin.address().port});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const headers={host:'trading.example.com','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document','cf-access-jwt-assertion':token};
 const request=(path='/',extra={},method='GET')=>new Promise((resolve,reject)=>{
  const r=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{...headers,...extra}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});r.on('error',reject);r.end();
 });
 try{
  assert.deepEqual(await request(),{status:200,body:'app'});
  for(const result of [
   await request('/',{'cf-access-jwt-assertion':''}),
   await request('/',{'cf-access-jwt-assertion':'forged'}),
   await request('/api/learning'),
   await request('/',{'sec-fetch-mode':'cors','sec-fetch-dest':'empty'}),
   await request('/',{'sec-fetch-dest':'iframe'}),
   await request('/',{origin:env.TRADING_PUBLIC_ORIGIN},'POST'),
   await request('/',{origin:'https://attacker.example'})
  ])assert.equal(result.status,403);
  assert.equal(forwarded,1);
 }finally{await new Promise(r=>server.close(r));await new Promise(r=>origin.close(r));}
});
test('remote configuration fails closed',()=>{assert.throws(()=>config({}));assert.throws(()=>config({...env,CF_ACCESS_ISSUER:'https://attacker.example'}));assert.throws(()=>config({...env,TRADING_PUBLIC_ORIGIN:'http://trading.example.com'}));});
test('validates signed identity, audience, issuer and expiry',async()=>{const {generateKeyPair,SignJWT}=await import('jose');const {publicKey,privateKey}=await generateKeyPair('RS256');const verify=await verifier(config(env),publicKey);const make=extra=>new SignJWT({email:'owner@example.com',...extra}).setProtectedHeader({alg:'RS256'}).setIssuedAt().setIssuer(env.CF_ACCESS_ISSUER).setAudience(env.CF_ACCESS_AUD).setExpirationTime('5m').sign(privateKey);assert.equal((await verify(await make({}))).email,'owner@example.com');await assert.rejects(verify(await make({email:'stranger@example.com'})));await assert.rejects(verify('fake.token.signature'));const expired=await new SignJWT({email:'owner@example.com'}).setProtectedHeader({alg:'RS256'}).setIssuedAt().setIssuer(env.CF_ACCESS_ISSUER).setAudience('wrong').setExpirationTime(1).sign(privateKey);await assert.rejects(verify(expired));});
test('gateway rejects anonymous requests, wrong hosts and cross-origin mutations',async()=>{let checked=0;const server=createGateway(config(env),async()=>{checked++;throw Error('invalid');});server.listen(0,'127.0.0.1');await once(server,'listening');try{const url='http://127.0.0.1:'+server.address().port;const request=(url,options)=>new Promise((resolve,reject)=>{const r=require('node:http').request(url,options,res=>{res.resume();resolve({status:res.statusCode});});r.on('error',reject);r.end();});for(const headers of [{host:'trading.example.com'},{host:'wrong.example'},{host:'trading.example.com',origin:'https://attacker.example','cf-access-jwt-assertion':'fake'}])assert.equal((await request(url,{method:'POST',headers})).status,403);assert.equal(checked,0);assert.equal((await request(url,{headers:{host:'trading.example.com','cf-access-jwt-assertion':'fake'}})).status,403);assert.equal(checked,1);}finally{await new Promise(r=>server.close(r));}});
