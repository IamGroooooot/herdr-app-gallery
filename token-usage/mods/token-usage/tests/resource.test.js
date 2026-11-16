import test from 'node:test';
import assert from 'node:assert/strict';
import { Resource } from '../resource.js';
test('concurrent callers share one in-flight request', async () => {
  let resolve, calls = 0;
  const resource = new Resource(() => { calls++; return new Promise(r => { resolve=r; }); });
  const a = resource.refresh(), b=resource.refresh();
  await Promise.resolve();
  assert.equal(calls,1); assert.equal(a,b); assert.equal(resource.loading,true);
  resolve(42); await a;
  assert.equal(resource.value,42); assert.equal(resource.loading,false);
});
test('failure preserves last good data; a later success recovers', async () => {
  let fail = false, value = 1;
  const resource = new Resource(async () => { if(fail) throw new Error('offline'); return value; },()=>123);
  await resource.refresh(); fail=true; await resource.refresh();
  assert.equal(resource.value,1); assert.equal(resource.error,'offline'); assert.equal(resource.checkedAt,123);
  fail=false; value=2; await resource.refresh();
  assert.equal(resource.value,2); assert.equal(resource.error,null);
});
test('a signed-out result replaces a previously signed-in account', async () => {
  let state = {kind:'signed-in', method:'ChatGPT'};
  const resource = new Resource(async()=>state); await resource.refresh();
  state = {kind:'signed-out'}; await resource.refresh();
  assert.deepEqual(resource.value,{kind:'signed-out'});
});
