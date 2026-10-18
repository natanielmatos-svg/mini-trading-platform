'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),report=JSON.parse(fs.readFileSync(path.join(root,'datos/neural/brti-cost-audit.json')));
const rows=report.groups.find(g=>g.summary.contracts===553&&g.summary.correct===406)?.rows;
if(!rows)throw Error('No se encontró el grupo exacto solicitado');
if(rows.some(r=>r.cost===null)||new Set(rows.map(r=>r.ticker)).size!==rows.length)throw Error('Datos incompletos o duplicados');
const dateNY=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
function metrics(rs,extra=.02){let total=0,peak=0,drawdown=0,minimum=0,streak=0,maxStreak=0;for(const r of rs){const net=Number(r.won)-r.cost-extra;total+=net;minimum=Math.min(minimum,total);peak=Math.max(peak,total);drawdown=Math.max(drawdown,peak-total);streak=net<0?streak+1:0;maxStreak=Math.max(streak,maxStreak);}return {cases:rs.length,wins:rs.filter(r=>r.won).length,cost:rs.reduce((n,r)=>n+r.cost,0),meanNet:rs.length?total/rs.length:null,total,drawdown,minimum,maxStreak};}
// A chronological sensitivity check; not an untouched holdout because the strategy
// was selected after inspecting model rankings on this same history.
const daily=[...new Set(rows.map(r=>dateNY(r.closesAt)))].map(date=>({date,...metrics(rows.filter(r=>dateNY(r.closesAt)===date))}));
const scenarios=[0,.01,.02,.03,.04].map(extra=>({assumedExtraCostPerContract:extra,...metrics(rows,extra)}));
const half=Math.floor(rows.length/2),halves=[metrics(rows.slice(0,half)),metrics(rows.slice(half))];
// Cluster bootstrap by NY day, including partial boundary days. Descriptive only:
// seven days cannot establish long-term independence or future market regimes.
let seed=123456789;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
const bootstrap=Array.from({length:10000},()=>{let net=0,n=0;for(let i=0;i<daily.length;i++){const d=daily[Math.floor(random()*daily.length)];net+=d.total;n+=d.cases;}return net/n;}).sort((a,b)=>a-b);
const output={at:new Date().toISOString(),source:report.generatedAt,policy:report.policy,assumption:'One contract per signal, hold to settlement; extra costs are hypothetical, not verified fees. Prices are recorded asks, not fills.',scenarios,daily,chronologicalHalvesAtTwoCents:halves,dayClusterBootstrap:{replicates:10000,seed:123456789,days:daily.length,lowerMeanPerContract:bootstrap[250],upperMeanPerContract:bootstrap[9750],method:'Percentile 95%, resample NY days; small number of days, descriptive sensitivity, not a validated confidence guarantee'},quoteAgreement:{withinOneCent:metrics(rows.filter(r=>Math.abs(r.quoteDifference)<=.010001)),outsideOneCent:metrics(rows.filter(r=>Math.abs(r.quoteDifference)>.010001))},outcome:'Historical gross edge only. No independent net execution validation; not ready for real-money promotion.'};
fs.writeFileSync(path.join(root,'datos/neural/brti-economics-review.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
