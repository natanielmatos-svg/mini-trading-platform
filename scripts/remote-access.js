'use strict';
require('../src/env');
const {config,verifier,createGateway}=require('../src/remote-access');
(async()=>{const c=config();const server=createGateway(c,await verifier(c));server.listen(3002,'127.0.0.1',()=>console.log('Acceso privado preparado en 127.0.0.1:3002 para '+c.host));})().catch(()=>{console.error('Acceso remoto no iniciado: revisa configuración Cloudflare Access.');process.exitCode=1;});
