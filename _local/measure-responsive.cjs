const {performance}=require('node:perf_hooks');
(async()=>{const rows=[];for(let i=0;i<20;i++){const t=performance.now();await fetch('http://127.0.0.1:3000/api/kalshi-lag').then(r=>r.text());rows.push(Math.round(performance.now()-t));await new Promise(r=>setTimeout(r,500));}console.log(JSON.stringify({ms:rows,max:Math.max(...rows),mean:rows.reduce((a,b)=>a+b)/rows.length}));})();
