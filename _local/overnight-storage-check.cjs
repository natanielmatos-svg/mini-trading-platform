const fs=require('node:fs'),path=require('node:path');
for(const dir of ['datos/diagnosticos/timing','datos/diagnosticos/kalshi-lag']){const files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')).sort(),file=files.at(-1),s=fs.statSync(path.join(dir,file));console.log(JSON.stringify({dir,file,bytes:s.size,modifiedAt:s.mtime.toISOString()}));}
