'use strict';
// Separate high-frequency quotes and local snapshots from expensive analysis.
function bucket(method,path){
 if(method==='GET'&&path==='/stream')return 'stream';
 if(method==='GET'&&['/price','/reference','/kalshi-threshold'].includes(path))return 'quotes';
 if(method==='GET'&&['/learning','/system-status','/evidence','/price-timing'].includes(path))return 'status';
 return 'analysis';
}
module.exports={bucket};
