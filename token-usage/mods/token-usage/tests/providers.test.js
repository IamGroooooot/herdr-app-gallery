import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, decodeCodexUsage, decodeCodexAccount } from '../providers.js';
import { usageProviders, commonPeriod, usageValue } from '../usage-model.js';
import { Resource } from '../resource.js';
const now = 2_000_000_000_000;
const window = { used: 26, resets: now / 1000 + 100 };
const raw = { samples: [{ limit_id: 'codex', at: now / 1000, windows: [{ ...window, key: 'primary', minutes: 10080 }] }], error: null };
function providers(overrides = {}) {
  return createProviders({
    claudeUsage: async () => ({ windows: { seven_day: { ...window, used: 59 } }, sessions: new Map(), reports: 1 }),
    claudeAccount: async () => ({ loggedIn: true, authMethod: 'claude.ai', email: 'test@example.test', subscriptionType: 'max' }),
    codexUsage: async () => raw,
    codexAccount: async () => ({ loggedIn: true, method: 'ChatGPT' }),
    ...overrides,
  });
}
test('both providers satisfy the same usage and account contract', async () => {
  for (const provider of Object.values(providers())) {
    const usage = await provider.readUsage();
    assert.equal(usage.windows[0].label, 'Week');
    assert(usage.sessions instanceof Map);
    assert.equal((await provider.readAccount()).kind, 'signed-in');
    assert(Array.isArray(provider.login.argv));
    assert(Array.isArray(provider.logout.argv));
  }
});
test('account capabilities remain factual, not fabricated', async () => {
  const p = providers();
  assert.equal((await p.claude.readAccount()).email, 'test@example.test');
  assert.equal((await p.codex.readAccount()).email, undefined);
  assert.deepEqual(p.codex.logout.argv, ['codex','logout']);
});
test('unknown account statuses are errors, not signed in', async () => {
  assert.throws(() => decodeCodexAccount({ loggedIn: true, method: 'unknown' }));
  assert.throws(() => decodeCodexAccount({ error: 'sk-secret' }), error => !error.message.includes('sk-secret'));
  assert.deepEqual(decodeCodexAccount({ loggedIn: false }), { kind: 'signed-out' });
  assert.equal(decodeCodexAccount({ missing: true }).kind, 'unavailable');
  await assert.rejects(providers({ claudeAccount: async () => ({}) }).claude.readAccount());
});
test('malformed reports and impossible percentages never reach UI', () => {
  for (const bad of [null, {}, { samples: null }, { samples: [null] }]) assert.throws(() => decodeCodexUsage(bad));
  for (const used of [NaN, Infinity, -1, 101, '26']) {
    assert.throws(() => decodeCodexUsage({ samples: [{ ...raw.samples[0], windows: [{ ...raw.samples[0].windows[0], used }] }] }));
  }
});
test('unknown periods are retained; absent windows are not invented', () => {
  const report = decodeCodexUsage(raw);
  assert.equal(report.windows.length, 1);
  const custom = decodeCodexUsage({ samples: [{ ...raw.samples[0], windows: [{ ...raw.samples[0].windows[0], minutes: 90 }] }] });
  assert.equal(custom.windows[0].label, '90m');
});
test('display compares same periods; mixed and expired windows are distinct', async () => {
  const p = providers();
  const codex = new Resource(p.codex.readUsage, () => now); await codex.refresh();
  const claude = { state: { kind: 'ok' }, report: await p.claude.readUsage(), at: now, error: null };
  const rows = usageProviders(claude, codex, now);
  assert.equal(commonPeriod(rows), 'Week');
  assert.deepEqual(rows.map(p => usageValue(p.windows[0],now)), ['59%','26%']);
  rows[1].windows.push({ ...window, key: 'extra', label: '5h' });
  assert.equal(commonPeriod(rows), null);
  assert.equal(usageValue({ ...window, resets: now/1000-1 },now), '--');
  assert.equal(usageProviders({ ...claude, state: { kind: 'signedout' } },codex,now)[0].windows.length,0);
});
