'use strict';
// Fictitious demo limits only. Never imports or falls back to live configuration.
const fs=require('node:fs'),path=require('node:path');
const {validateForSave}=require('./trading-settings');
const file=path.join(__dirname,'../datos/executor-demo/settings.json');
function read(configFile=file){
 const raw=JSON.parse(fs.readFileSync(configFile,'utf8'));
 if(raw.environment!=='demo'||raw.version!==1)throw Error('Configuración demo no verificable');
 return validateForSave(raw.limits);
}
module.exports={read};
