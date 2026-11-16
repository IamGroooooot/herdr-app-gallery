import assert from 'node:assert/strict';
import test from 'node:test';
import { Resource } from '../resource.js';

test('concurrent callers share one in-flight request', async () => {
  let resolve;
  let calls = 0;
  const resource = new Resource(() => {
    calls++;
    return new Promise(done => {
      resolve = done;
    });
  });
  const callers = [resource.refresh(), resource.refresh()];
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(resource.loading, true);
  resolve(42);
  await Promise.all(callers);
  assert.equal(resource.value, 42);
  assert.equal(resource.loading, false);
});

test('failure preserves last good data; a later success recovers', async () => {
  let fail = false;
  let value = 1;
  const resource = new Resource(
    async () => {
      if (fail) throw new Error('offline');
      return value;
    },
    () => 123,
  );
  await resource.refresh();
  fail = true;
  await resource.refresh();
  assert.equal(resource.value, 1);
  assert.equal(resource.error, 'offline');
  assert.equal(resource.checkedAt, 123);
  fail = false;
  value = 2;
  await resource.refresh();
  assert.equal(resource.value, 2);
  assert.equal(resource.error, null);
});

test('a failure that is not an Error is still flagged', async () => {
  const resource = new Resource(() => Promise.reject('offline'));
  await resource.refresh();
  assert.ok(resource.error);
});

test('views hear when a read starts and when it has settled, so they never show a finished read as loading', async () => {
  let fail = false;
  const heard = [];
  const resource = new Resource(
    async () => {
      if (fail) throw new Error('offline');
      return 42;
    },
    Date.now,
    () => heard.push({ loading: resource.loading, value: resource.value, error: resource.error }),
  );
  await resource.refresh();
  assert.deepEqual(heard[0], { loading: true, value: null, error: null });
  assert.deepEqual(heard.at(-1), { loading: false, value: 42, error: null });
  fail = true;
  await resource.refresh();
  assert.deepEqual(heard.at(-1), { loading: false, value: 42, error: 'offline' });
  resource.invalidate();
  assert.deepEqual(heard.at(-1), { loading: false, value: null, error: null });
});

test('a signed-out result replaces a previously signed-in account', async () => {
  let state = { kind: 'signed-in', method: 'ChatGPT' };
  const resource = new Resource(async () => state);
  await resource.refresh();
  state = { kind: 'signed-out' };
  await resource.refresh();
  assert.deepEqual(resource.value, { kind: 'signed-out' });
});

test('invalidation prevents an older in-flight result from restoring stale data', async () => {
  let resolve;
  const resource = new Resource(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const request = resource.refresh();
  await Promise.resolve();
  resource.invalidate();
  resolve('old account usage');
  await request;
  assert.equal(resource.value, null);
});

test('failed attempts also respect TTL, avoiding a process-spawn storm', async () => {
  let now = 0;
  let calls = 0;
  const resource = new Resource(
    async () => {
      calls++;
      throw new Error('offline');
    },
    () => now,
  );
  await resource.refresh(10000);
  await resource.refresh(10000);
  assert.equal(calls, 1);
  now = 10000;
  await resource.refresh(10000);
  assert.equal(calls, 2);
});
