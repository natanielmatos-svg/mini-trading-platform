'use strict';
const fs=require('node:fs'),{StringDecoder}=require('node:string_decoder');
// Replay append-only logs without allocating the entire file and a split copy.
function* readJsonl(file,chunkSize=65536){const fd=fs.openSync(file,'r'),decoder=new StringDecoder('utf8'),buffer=Buffer.alloc(chunkSize);let pending='';try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))){pending+=decoder.write(buffer.subarray(0,n));let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index).trim();pending=pending.slice(index+1);if(line)yield JSON.parse(line);}}pending+=decoder.end();if(pending.trim())yield JSON.parse(pending);}finally{fs.closeSync(fd);}}
module.exports={readJsonl};
