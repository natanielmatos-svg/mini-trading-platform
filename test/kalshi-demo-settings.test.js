'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const settings=require('../src/kalshi-demo-settings');
test('demo settings require an explicit demo file, never live defaults',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-limits-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'settings.json');
 assert.throws(()=>settings.read(file));
 const data={version:1,environment:'demo',limits:{capital:100,maxDailyLossPct:20,maxPerTrade:1.03,paused:false}};
 fs.writeFileSync(file,JSON.stringify(data));assert.equal(settings.read(file).maxPerTrade,1.03);
 data.environment='production';fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>settings.read(file),/demo/);
 data.environment='demo';data.limits.maxPerTrade=21;fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>settings.read(file),/presupuesto/);
});
test('both demo entry points use isolated settings',()=>{
 for(const p of ['validate-kalshi-demo.js','kalshi-demo-strategy.js']){const s=fs.readFileSync(path.join(__dirname,'../scripts',p),'utf8');assert.ok(s.includes("require('../src/kalshi-demo-settings').read()"));assert.ok(!s.includes("require('../src/trading-settings').read()"));}
});
