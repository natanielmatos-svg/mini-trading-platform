'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {officialResult}=require('../src/kalshi-settlement');
test('admite finalized y settled conservando trazabilidad oficial',()=>{for(const status of ['finalized','settled'])assert.deepEqual(officialResult({ticker:'X',status,result:'no',settlement_ts:'2026-09-25T01:02:48Z'},'X'),{resultado:'no',status,settlementAt:'2026-09-25T01:02:48Z'});});
test('rechaza liquidación provisional, pendiente, no binaria o de otro contrato',()=>{for(const patch of [{status:'closed'},{status:'determined'},{status:'disputed'},{is_provisional:true},{result:'scalar'},{ticker:'Y'}])assert.equal(officialResult({ticker:'X',status:'finalized',result:'yes',...patch},'X'),null);});
