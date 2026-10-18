#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
if(!process.argv[2])throw Error('Indica la carpeta de una captura audit-btc15m.');
const dir=path.resolve(process.argv[2]);
const report=JSON.parse(fs.readFileSync(path.join(dir,'report.json'),'utf8'));
const files=new Map();
for(const entry of report.inputs){
 const full=path.resolve(dir,entry.snapshot);
 if(!full.startsWith(dir+path.sep))throw Error('Ruta fuera de la captura');
 const bytes=fs.readFileSync(full);
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256,'Captura modificada: '+entry.source);
 files.set(entry.source,{full,text:bytes.toString('utf8')});
}
const {audit}=require(files.get('src/pilot-audit.js').full);
const read=name=>files.get(name).text;
const jsonl=s=>s.split(/\r?\n/).filter(x=>x.trim()).flatMap(x=>{try{return [JSON.parse(x)];}catch{return [];}});
const state=JSON.parse(read('datos/aprendizaje/state.json'));
const blocks=[...files].filter(([n])=>/^datos\/aprendizaje\/closed-.*\.jsonl$/.test(n)).flatMap(([,v])=>jsonl(v.text));
const archived=new Set(blocks.map(b=>JSON.stringify([b.group,b.unit,b.closesAt])));
blocks.push(...state.blocks.filter(b=>!archived.has(JSON.stringify([b.group,b.unit,b.closesAt]))));
const replay=audit({blocks,evidence:jsonl(read('datos/evidencia.jsonl')),ledger:jsonl(read('datos/decisiones.jsonl')),cutoff:Date.parse(report.cutoff)});
for(const field of ['candleComparisons','contractComparisons','coverage','netProfitUSD','ready'])assert.deepEqual(replay[field],report[field],field+' no coincide');
console.log('Reproducción exacta verificada: hashes, cobertura, comparaciones y resultado económico.');
