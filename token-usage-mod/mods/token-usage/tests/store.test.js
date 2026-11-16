import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageStore, claimAlert } from '../store.js';
import { usageProviders } from '../usage-model.js';

function fixture() {
  let now = 100000;
  const counts = { claudeAccount: 0, codexAccount: 0, claudeUsage: 0, codexUsage: 0, connection: 0, cleared: 0 };
  const states = { claude: { kind: 'signed-in', method: 'claude.ai', context: { identity: 'a' } }, codex: { kind: 'signed-in', method: 'ChatGPT' } };
  const providers = Object.fromEntries(['claude','codex'].map(id => [id, {
    id, name: id,
    async readAccount() { counts[`${id}Account`]++; return states[id]; },
    async readUsage() { counts[`${id}Usage`]++; return { windows: [{ key:'week',label:'Week',used:59,resets:99999 }], reportedAt:now, sessions:new Map() }; },
    login: { name:'login',argv:[] }, logout: { name:'logout',argv:[] },
  }]));
  const store = new UsageStore(providers, {
    async connection() { counts.connection++; return { connected:true }; },
    async accountChanged() { counts.cleared++; },
  }, () => now);
  const display = () => usageProviders(Object.values(providers).map(provider => ({ provider, account:store.accounts[provider.id], usage:store.usage[provider.id] })), now);
  return { store, counts, states, display, advance: ms => { now+=ms; } };
}
test('many views share one read and one polling cadence', async () => {
  const f=fixture();
  await Promise.all(Array.from({length:8},()=>f.store.poll()));
  assert.deepEqual(f.counts,{claudeAccount:1,codexAccount:1,claudeUsage:1,codexUsage:1,connection:1,cleared:0});
  f.advance(5000); await f.store.poll();
  assert.equal(f.counts.claudeUsage,1); assert.equal(f.counts.codexUsage,1);
  f.advance(5000); await f.store.poll();
  assert.equal(f.counts.claudeUsage,2); assert.equal(f.counts.codexUsage,1);
  f.advance(5000); await f.store.poll(); assert.equal(f.counts.codexUsage,2);
});
test('account refresh changes the panel and settings source together', async () => {
  const f=fixture(); await f.store.poll();
  assert.equal(f.display()[0].status,'ready');
  f.states.claude={kind:'signed-out'};
  await f.store.refreshAccount('claude',true);
  assert.equal(f.store.accounts.claude.value.kind,'signed-out');
  assert.equal(f.display()[0].status,'signedout');
  assert.equal(f.display()[0].windows.length,0);
});
test('a different Claude identity after sign-out invalidates old usage and reports', async () => {
  const f=fixture(); await f.store.poll();
  f.states.claude={kind:'signed-out'}; await f.store.refreshAccount('claude',true);
  f.states.claude={kind:'signed-in',method:'claude.ai',context:{identity:'b'}};
  await f.store.refreshAccount('claude',true);
  assert.equal(f.counts.cleared,1); assert.equal(f.store.usage.claude.value,null);
});
test('settings changes are checked without waiting for auth expiry', async () => {
  const f=fixture(); await f.store.poll(); f.advance(10000); await f.store.poll();
  assert.equal(f.counts.claudeAccount,1); assert.equal(f.counts.connection,2);
});
test('alert claims coordinate views, preserve keys and separate limit periods', () => {
  let keys=[]; const read=()=>keys, write=value=>{keys=value;};
  assert.equal(claimAlert(read,write,'week:1:urgent'),true);
  assert.equal(claimAlert(read,write,'week:1:urgent'),false);
  assert.equal(claimAlert(read,write,'week:2:warn'),true);
  assert.deepEqual(keys,['week:1:urgent','week:2:warn']);
});
test('a remembered identity prevents previous-account reports returning after restart', async () => {
  const f=fixture();let remembered='previous-account',cleared=0;
  const store=new UsageStore(f.store.providers,{connection:async()=>({connected:true}),accountChanged:async()=>{cleared++;},
    claudeIdentity:{read:()=>remembered,write:id=>{remembered=id;}}});
  await store.poll();assert.equal(cleared,1);assert.equal(remembered,'a');
});
