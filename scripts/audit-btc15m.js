#!/usr/bin/env node
'use strict';
// No network, no env/credentials, no trading controls. Immutable input receipt.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {audit}=require('../src/pilot-audit');
const root=path.resolve(__dirname,'..'),cutoff=Date.now();
const output=path.join(root,'datos/diagnosticos','btc15m-'+new Date(cutoff).toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(path.join(output,'inputs'),{recursive:true});
const inputs=[];
function capture(relative){
  const bytes=fs.readFileSync(path.join(root,relative));
  const filename=inputs.length+'-'+path.basename(relative);
  fs.writeFileSync(path.join(output,'inputs',filename),bytes);
  inputs.push({source:relative,snapshot:'inputs/'+filename,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  return bytes.toString('utf8');
}
capture('src/pilot-audit.js');
let malformed=0;
function jsonl(s){return s.split(/\r?\n/).filter(x=>x.trim()).flatMap(x=>{try{return [JSON.parse(x)];}catch{malformed++;return [];}});}
const evidence=jsonl(capture('datos/evidencia.jsonl'));
const ledger=jsonl(capture('datos/decisiones.jsonl'));
const state=JSON.parse(capture('datos/aprendizaje/state.json'));
const blocks=[];
for(const name of fs.readdirSync(path.join(root,'datos/aprendizaje')).filter(n=>/^closed-.*\.jsonl$/.test(n)).sort())blocks.push(...jsonl(capture('datos/aprendizaje/'+name)));
const archived=new Set(blocks.map(b=>JSON.stringify([b.group,b.unit,b.closesAt])));
blocks.push(...state.blocks.filter(b=>!archived.has(JSON.stringify([b.group,b.unit,b.closesAt]))));
const result=audit({blocks,evidence,ledger,cutoff});
result.quality.malformedLines=malformed;
result.collection={lastRun:state.lastRun||null,errors:state.errors||[],mode:state.mode};
if(malformed)result.blockers.unshift('Hay líneas JSONL incompletas o dañadas; excluidas y contabilizadas.');
result.inputs=inputs;
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));
const fmt=n=>n==null?'No disponible':n.toFixed(4);
const text=[
 '# Diagnóstico BTC · 15 minutos', '',`Corte UTC: ${result.cutoff}. Estado: NO PREPARADO.`,
 '', '## Resultado económico', '',
 'Beneficio neto: **no disponible**. No se convierte error de precio en beneficio ni se presupone ejecución al punto medio.',
 `Contratos KXBTC15M observados: ${result.coverage.btc15mContracts}; resueltos: ${result.coverage.btc15mResolvedContracts}; cierres simulados de esa serie: ${result.coverage.btc15mPaperCloses}.`,
 `Cierres simulados de todas las series: ${result.coverage.allPaperCloses}. Observaciones por serie: ${JSON.stringify(result.coverage.series)}.`,
 '', '## Errores de cierre emparejados', '',
 'Exploratorio, no prueba de rentabilidad. Mismas filas por fuente, proveedores, moneda, versión, cuarto de emisión y estado de entrenamiento. Cada fila agrupa cierres distintos; no sumar grupos como casos independientes. Menor MAE es mejor; unidades indicadas en la clave.',
 '', '| Grupo | Cierres | MAE neuronal | MAE candidato | MAE último precio |', '|---|---:|---:|---:|---:|',
 ...result.candleComparisons.map(g=>`| ${g.key.replaceAll('|','/')} | ${g.n} | ${fmt(g.rawMae)} | ${fmt(g.candidateMae)} | ${fmt(g.baselineMae)} |`),
 '', '## Comparación con Kalshi', '',
 result.contractComparisons.length?JSON.stringify(result.contractComparisons,null,2):'Sin casos válidos de KXBTC15M. No se reutilizan contratos horarios para cubrir esta ausencia.',
 '', 'La probabilidad estadística guardada no es una probabilidad TimesFM. No existe una comparación triple del mismo objetivo; neuralKalshiPairedCases permanece en cero porque ese enlace no está validado.',
 '', '## Bloqueos', '',...result.blockers.map(b=>'- '+b),
 '', '## Método y reproducción', '',
 'MAE = media de |estimación − cierre observado|. Brier = media de (probabilidad − resultado binario)². Filtrado anterior al cierre y resolución no posterior al corte. Duplicados excluidos; resultados contradictorios excluidos. No se rellenan pronósticos faltantes.',
 'Las fuentes locales se copian exactamente a inputs/ con SHA-256 en report.json. Son capturas secuenciales con un corte común, no una transacción del servidor. No incluyen credenciales. El informe no vuelve a entrenar ni modifica modelos.',
 'Nueva captura: node scripts/audit-btc15m.js. Repetir esta captura: node scripts/replay-btc15m.js "'+output+'". El replay verifica hashes y usa el código congelado. Protocolo siguiente: deploy/PILOTO-BTC15M.md.',
 '',`Calidad: ${JSON.stringify(result.quality)}.`,''];
fs.writeFileSync(path.join(output,'report.md'),text.join('\n'));
console.log(JSON.stringify({output,coverage:result.coverage,quality:result.quality,groups:result.candleComparisons,blockers:result.blockers},null,2));
