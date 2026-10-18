'use strict';
// Closed blocks are immutable in the learner. Reuse their encoding instead of
// traversing every historical observation on each new live sample.
function createEncoder(){
 const closed=new WeakMap();
 return state=>{
  const {blocks,...metadata}=state;
  const rows=blocks.map(block=>{
   if(block.actual==null)return JSON.stringify(block);
   let encoded=closed.get(block);
   if(encoded===undefined){encoded=JSON.stringify(block);closed.set(block,encoded);}
   return encoded;
  });
  return JSON.stringify(metadata).slice(0,-1)+',"blocks":['+rows.join(',')+']}';
 };
}
module.exports={createEncoder};
