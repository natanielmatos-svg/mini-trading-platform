const test=require('node:test'),assert=require('node:assert/strict');const {bucket}=require('../src/request-bucket');
test('polling cannot exhaust analysis or snapshot quotas',()=>{assert.equal(bucket('GET','/price'),'quotes');assert.equal(bucket('GET','/learning'),'status');assert.equal(bucket('GET','/forecast'),'analysis');assert.equal(bucket('GET','/stream'),'stream');});
test('writes and unknown paths retain general protection',()=>{assert.equal(bucket('POST','/learning'),'analysis');assert.equal(bucket('POST','/bot-control'),'analysis');assert.equal(bucket('GET','/other'),'analysis');});
