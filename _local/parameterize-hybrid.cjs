const fs=require('node:fs');const file='src/kalshi-hybrid.js';let s=fs.readFileSync(file,'utf8');
const replacements=[
 ['function features(s){','function features(s,config={}){'],
 ['if(!s.fixedWindowEligible||', 'if((!config.midpoint&&!s.fixedWindowEligible)||'],
 ['s.requestedAt-600000)>30000','s.requestedAt-(config.horizonMs??600000))>30000'],
 ['JSON.stringify([VERSION,p.group,p.venues,p.prediction.version,s.operator])','JSON.stringify([config.version||VERSION,p.group,p.venues,p.prediction.version,s.operator,...(config.midpoint?[s.rulesHash]:[])])'],
 ["function propose(s,history,settlements,variant='full'){","function propose(s,history,settlements,variant='full',config={}){"],
 ['const f=features(s),base={version:VERSION','const f=features(s,config),base={version:config.version||VERSION'],
 ['const hf=features(h),r=','const hf=features(h,config),r='],
 ['const artifact={version:VERSION','const artifact={version:config.version||VERSION'],
 ['function summarize(history,settlements){','function summarize(history,settlements,config={}){'],
 ["const p=s.hybridProbability;if(!p||p.version!==VERSION)continue;", "const p=s[config.predictionField||'hybridProbability'];if(!p||p.version!==(config.version||VERSION))continue;"],
 ["const f=features(s);if(p.status", "const f=features(s,config);if(p.status"],
 ['return {version:VERSION,minimum:MINIMUM,latest,pending','return {version:config.version||VERSION,minimum:MINIMUM,latest,pending']
];for(const [a,b] of replacements){if(!s.includes(a))throw Error('Missing marker '+a);s=s.replace(a,b);}fs.writeFileSync(file,s);
