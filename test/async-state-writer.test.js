'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWriter}=require('../src/async-state-writer');
test('coalesces before encoding and serializes changes arriving during a write',async()=>{
 let state=1,release,writes=[],renames=0;
 const writer=createWriter({file:'state.json',encode:()=>String(state),io:{mkdir:async()=>{},writeFile:async(f,data)=>{writes.push(data);if(writes.length===1)await new Promise(r=>release=r);},rename:async()=>{renames++;}}});
 writer.request();state=2;writer.request();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.deepEqual(writes,['2']);state=3;writer.request();release();await writer.flush();assert.deepEqual(writes,['2','3']);assert.equal(renames,2);
});
test('failed temporary write never replaces persisted history and flush reports failure',async()=>{
 let renamed=false;const writer=createWriter({file:'state.json',encode:()=>'',io:{mkdir:async()=>{},writeFile:async()=>{throw Error('disk');},rename:async()=>{renamed=true;}}});writer.request();await assert.rejects(writer.flush(),/disk/);assert.equal(renamed,false);
});
