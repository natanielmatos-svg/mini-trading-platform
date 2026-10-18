'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../datos/trading-settings.json');
const defaults = { capital: 50, maxDailyLossPct: 5, maxPerTrade: null, paused: false };
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!Object.hasOwn(defaults,k))) throw new Error('Configuración no válida');
  const value = { ...defaults, ...input };
  for(const k of ['capital','maxDailyLossPct','maxPerTrade']) {
    if(k==='maxPerTrade' && value[k]===null)continue;
    if(typeof value[k]!=='number'||!Number.isFinite(value[k])||value[k]<=0||value[k]>1000000||Math.abs(value[k]*100-Math.round(value[k]*100))>1e-6) throw new Error('Los importes deben ser positivos, con un máximo de dos decimales');
  }
  if(value.maxDailyLossPct>100||value.maxPerTrade>value.capital)throw new Error('Porcentaje o importe superior al límite permitido');
  if(typeof value.paused!=='boolean')throw new Error('Pausa no válida');
  return value;
}
function read() {
  try{return validate(JSON.parse(fs.readFileSync(file,'utf8')));}
  catch(e){if(e.code==='ENOENT')return {...defaults};throw new Error('No se pudo leer la configuración de riesgo');}
}
function validateForSave(input) {
  const value=validate(input);
  const dailyBudget=Math.floor(value.capital*value.maxDailyLossPct)/100;
  if(value.maxPerTrade!==null&&value.maxPerTrade>dailyBudget)throw new Error(`El máximo por operación, incluidas las comisiones, no puede superar el presupuesto diario de pérdida de ${dailyBudget.toFixed(2)} USD`);
  return value;
}
function save(input) {
  const value=validateForSave(input);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);
  return value;
}
function blockers(config=read()) {
  const reasons=['Módulo de ejecución implementado con pruebas locales; desactivado y pendiente de validación con Kalshi. El bot continúa en simulación.'];
  if(!process.env.KALSHI_API_KEY_ID||!process.env.KALSHI_PRIVATE_KEY_PATH)reasons.push('Faltan credenciales de Kalshi.');
  reasons.push('Cobertura actual del bot: Bitcoin. Otros activos requieren mapeo, datos y reglas de liquidación verificados.');
  return reasons;
}
module.exports={read,save,validate,validateForSave,blockers};
