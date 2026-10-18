'use strict';
// Origin timestamps only; summaries never claim to be a settlement average.
function summarize(points, cutoff) {
 const byTime=new Map(),conflicts=new Set();
 for(const p of points)if(Number.isFinite(p.at)&&p.at<=cutoff&&p.at>=cutoff-60000&&Number.isFinite(p.price)&&p.price>0){
  if(byTime.has(p.at)&&byTime.get(p.at)!==p.price)conflicts.add(p.at);
  byTime.set(p.at,p.price);
 }
 const rows=[...byTime].filter(([at])=>!conflicts.has(at)).sort((a,b)=>a[0]-b[0]);
 const last=rows.at(-1);
 function window(seconds){
  const start=cutoff-seconds*1000, a=rows.filter(([at])=>at>=start);
  const gap=a.length>1?Math.max(...a.slice(1).map((p,i)=>p[0]-a[i][0])):null;
  const complete=!!last&&a.length>=2&&a[0][0]-start<=1500&&cutoff-last[0]<=1500&&gap<=1500&&!conflicts.size;
  return {samples:a.length,maxGapMs:gap,complete,returnPct:complete?100*(last[1]/a[0][1]-1):null,rangePct:complete?100*(Math.max(...a.map(p=>p[1]))-Math.min(...a.map(p=>p[1])))/last[1]:null};
 }
 return {version:'brti-observed-motion-v1',cutoff,conflictingTimestamps:conflicts.size,windows:Object.fromEntries([5,15,60].map(s=>[s,window(s)])),settlementAverage:false};
}
module.exports={summarize};
