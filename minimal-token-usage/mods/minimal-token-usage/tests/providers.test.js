import assert from 'node:assert/strict';
import test from 'node:test';
import { codexReport, createProviders, periodLabel } from '../providers.js';
import { Resource } from '../resource.js';
import {
  commonPeriod,
  litSegments,
  ownColors,
  periodWidth,
  readPrefs,
  remainingPercent,
  remainingValue,
  resetLabel,
  rowNote,
  STRIP,
  stripHeight,
  stripOverflows,
  stripStyle,
  usageProviders,
  usageValue,
} from '../usage-model.js';

const now = 2_000_000_000_000;
const window = { used: 26, resets: now / 1000 + 100 };
const sample = {
  limit_id: 'codex',
  name: null,
  at: now / 1000,
  windows: [{ ...window, key: 'primary', minutes: 10080 }],
};
const raw = { samples: [sample], error: null };
const claudeAuth = { loggedIn: true, authMethod: 'claude.ai', email: 'test@example.test', subscriptionType: 'max' };

function providers(overrides = {}) {
  return createProviders({
    claudeUsage: async () => ({
      windows: { seven_day: { ...window, used: 59 } },
      sessions: new Map(),
      reports: 1,
      reportedAt: now,
    }),
    claudeAccount: async () => claudeAuth,
    codexUsage: async () => raw,
    codexAccount: async () => ({ kind: 'signed-in', method: 'ChatGPT' }),
    ...overrides,
  });
}
const read = (value, error = null) => ({ value, error, loading: false, checkedAt: now });

test('both providers report usage and account in one shape', async () => {
  const p = providers();
  const [claude, codex] = [await p.claude.readUsage(), await p.codex.readUsage()];
  assert.deepEqual(claude.windows, [{ key: 'seven_day', label: 'Week', used: 59, resets: window.resets }]);
  assert.deepEqual(codex.windows, [{ key: 'codex:primary', label: 'Week', used: 26, resets: window.resets }]);
  assert.deepEqual([claude.reportedAt, codex.reportedAt], [now, now]);
  for (const provider of Object.values(p)) assert.equal((await provider.readAccount()).kind, 'signed-in');
});

test('sign-in and sign-out run each provider’s own CLI', () => {
  const p = providers();
  assert.deepEqual(p.claude.login.argv, ['claude', 'auth', 'login']);
  assert.deepEqual(p.claude.logout.argv, ['claude', 'auth', 'logout']);
  assert.deepEqual(p.codex.login.argv, ['codex', 'login']);
  assert.deepEqual(p.codex.logout.argv, ['codex', 'logout']);
});

test('account capabilities remain factual, not fabricated', async () => {
  const p = providers();
  assert.equal((await p.claude.readAccount()).email, 'test@example.test');
  assert.equal((await p.codex.readAccount()).email, undefined);
});

test('a Claude account is told apart by email and organization; a failed or missing CLI is not signed out', async () => {
  const identity = async auth =>
    (await providers({ claudeAccount: async () => auth }).claude.readAccount()).context.identity;
  const work = await identity({ ...claudeAuth, orgId: 'work' });
  assert.notEqual(work, await identity({ ...claudeAuth, orgId: 'personal' }));
  assert.equal(work, await identity({ ...claudeAuth, orgId: 'work' }));
  assert.equal(await identity({ loggedIn: true }), undefined);

  const account = auth => providers({ claudeAccount: async () => auth }).claude.readAccount();
  assert.equal((await account({ missing: true, error: 'spawn claude ENOENT' })).kind, 'unavailable');
  assert.deepEqual(await account({ loggedIn: false, configDirectory: '/c' }), {
    kind: 'signed-out',
    context: { configDirectory: '/c', projectsDirectory: undefined, identity: undefined },
  });
  await assert.rejects(account({ error: 'token expired' }), { message: 'token expired' });
  await assert.rejects(account({}));
});

test('limits are named by their period, and a limit beyond the plan’s own by its name too', async () => {
  assert.deepEqual([10080, 20160, 1440, 300, 90].map(periodLabel), ['Week', '14d', '1d', '5h', '90m']);
  const named = codexReport({ samples: [sample, { ...sample, limit_id: 'spark', name: 'Spark' }], error: null });
  assert.deepEqual(
    named.windows.map(w => [w.key, w.label]),
    [
      ['codex:primary', 'Week'],
      ['spark:primary', 'Spark · Week'],
    ],
  );
  const unnamed = codexReport({ samples: [{ ...sample, limit_id: 'spark' }], error: null });
  assert.equal(unnamed.windows[0].label, 'spark · Week');
  assert.deepEqual(codexReport({ samples: [], error: null }), { windows: [], reportedAt: null, sessions: new Map() });

  const windows = { five_hour: window, seven_day: window, spend_limit: window, monthly: window };
  const claude = await providers({ claudeUsage: async () => ({ windows }) }).claude.readUsage();
  assert.deepEqual(
    claude.windows.map(w => w.label),
    ['5h', 'Week', 'Spend', 'monthly'],
  );
});

test('display compares same periods; mixed and expired windows are distinct', async () => {
  const p = providers();
  const codex = new Resource(p.codex.readUsage, () => now);
  await codex.refresh();
  const claude = new Resource(p.claude.readUsage, () => now);
  await claude.refresh();
  const signedIn = read({ kind: 'signed-in', method: 'test' });
  const rows = usageProviders(
    [
      { provider: p.claude, account: signedIn, usage: claude },
      { provider: p.codex, account: signedIn, usage: codex },
    ],
    now,
  );
  assert.equal(commonPeriod(rows), 'Week');
  assert.deepEqual(
    rows.map(row => usageValue(row.windows[0], now)),
    ['59%', '26%'],
  );
  rows[1].windows.push({ ...window, key: 'extra', label: '5h' });
  assert.equal(commonPeriod(rows), null);
  assert.equal(usageValue({ ...window, resets: now / 1000 - 1 }, now), '--');
});

test('each provider row says why it has no limits to show', () => {
  const usage = read({ windows: [{ ...window, key: 'w', label: 'Week' }], reportedAt: now, sessions: new Map() });
  const row = input =>
    usageProviders(
      [
        {
          provider: { id: 'claude', name: 'Claude' },
          account: read({ kind: 'signed-in', method: 'claude.ai' }),
          usage,
          ...input,
        },
      ],
      now,
    )[0];
  const missing = read({ kind: 'unavailable', reason: 'Claude Code is not installed.' });
  const cases = [
    ['ready', {}],
    ['loading', { account: read(null) }],
    ['error', { account: read(null, 'offline') }],
    ['missing', { account: missing }],
    ['signedout', { account: read({ kind: 'signed-out' }) }],
    ['nolimits', { account: read({ kind: 'signed-in', method: 'API key' }) }],
    ['loading', { connection: read(null) }],
    ['error', { connection: read(null, 'settings.json is not valid JSON') }],
    ['unlinked', { connection: read({ connected: false }) }],
    ['ready', { connection: read({ connected: true }) }],
    ['waiting', { usage: read(null) }],
    ['waiting', { usage: read({ windows: [], reportedAt: null, sessions: new Map() }) }],
  ];
  for (const [status, input] of cases) {
    const shown = row(input);
    assert.equal(shown.status, status, JSON.stringify(input));
    assert.equal(shown.windows.length, status === 'ready' ? 1 : 0, status);
    assert.equal(Boolean(shown.message), status !== 'ready', status);
  }
  assert.equal(row({ account: missing }).detail, 'Claude Code is not installed.');
  // Not connected is not "not signed in": the row says the sign-in was seen.
  assert.match(row({ connection: read({ connected: false }) }).message, /^Signed in/);
});

test('a failed refresh keeps the last limits and flags them; an hour-old report is marked stale', () => {
  const report = { windows: [{ ...window, key: 'w', label: 'Week' }], sessions: new Map() };
  const row = usage =>
    usageProviders(
      [{ provider: { id: 'codex', name: 'Codex' }, account: read({ kind: 'signed-in', method: 'ChatGPT' }), usage }],
      now,
    )[0];
  const fresh = row(read({ ...report, reportedAt: now - 3600000 }));
  assert.deepEqual([fresh.stale, rowNote(fresh)], [false, null]);
  const failed = row(read({ ...report, reportedAt: now }, 'offline'));
  assert.deepEqual([failed.status, failed.windows.length, rowNote(failed)], ['ready', 1, 'Error']);
  const old = row(read({ ...report, reportedAt: now - 3600001 }));
  assert.deepEqual([old.stale, rowNote(old)], [true, 'Stale']);
  assert.equal(rowNote(row(read({ ...report, reportedAt: now - 3600001 }, 'offline'))), 'Error');
});

test('API-key sign-in cannot display plan snapshots from an earlier ChatGPT login', async () => {
  const p = providers();
  const usage = new Resource(p.codex.readUsage);
  await usage.refresh();
  const display = usageProviders(
    [{ provider: p.codex, account: read({ kind: 'signed-in', method: 'API key' }), usage }],
    now,
  )[0];
  assert.equal(display.status, 'nolimits');
  assert.equal(display.windows.length, 0);
});

test('a remaining allowance never looks renewed after its window has passed', () => {
  assert.equal(remainingValue({ ...window, used: 59 }, now), '41%');
  assert.equal(remainingValue({ ...window, used: 28 }, now), '72%');
  assert.equal(remainingValue({ ...window, used: 100 }, now), '0%');
  assert.equal(remainingValue({ ...window, resets: now / 1000 - 1 }, now), '--');
  assert.equal(remainingPercent({ used: 14, resets: now / 1000 + 60 }, now), 86);
  assert.equal(remainingPercent({ used: 14, resets: now / 1000 - 60 }, now), 0);
  assert.equal(remainingPercent({ used: 120, resets: now / 1000 + 60 }, now), 0);
});

test('a reset reads as minutes within the hour, else as a local weekday and 24-hour time', () => {
  assert.equal(resetLabel(now / 1000 - 1, now), 'Awaiting');
  assert.equal(resetLabel(now / 1000 + 120, now), 'in 2m');
  assert.equal(resetLabel(now / 1000 + 30, now), 'in 1m');
  const local = (day, hour, minute) => new Date(2026, 10, day, hour, minute).getTime();
  const noon = local(16, 12, 0);
  assert.equal(resetLabel(local(16, 13, 30) / 1000, noon), 'Mon 13:30');
  assert.equal(resetLabel(local(18, 9, 5) / 1000, noon), 'Wed 09:05');
  assert.equal(resetLabel(local(21, 23, 59) / 1000, noon), 'Sat 23:59');
  assert.equal(resetLabel(local(22, 0, 0) / 1000, noon), 'Sun 00:00');
});

const shown = (windows, extra = {}) => ({
  id: 'p',
  name: 'P',
  status: 'ready',
  at: now,
  error: null,
  stale: false,
  windows: windows.map(label => ({ ...window, key: label, label })),
  ...extra,
});
const styles = ['gauge', 'segments', 'meter'];

test('the strip asks for room for every row, between the 92 and 180 px its layout block allows', () => {
  for (const style of styles) {
    assert.equal(stripHeight([], style), 92);
    const rows = Array.from({ length: 12 }, (_, i) => Array.from({ length: i + 1 }, () => shown(['Week'])));
    const heights = rows.map(providers => stripHeight(providers, style));
    assert(
      heights.every(height => height >= 92 && height <= 180),
      `${style}: ${heights}`,
    );
    const growing = heights.filter(height => height > 92 && height < 180);
    const steps = growing.slice(1).map((height, i) => height - growing[i]);
    assert(steps.length >= 1 && steps.every(step => step > 0 && step === steps[0]), `${style}: ${heights}`);
    assert.equal(heights.at(-1), 180);
    rows.forEach((providers, i) => {
      if (heights[i] < 180) assert.equal(stripOverflows(providers, style), false, `${style}: ${i + 1} rows`);
    });
    assert.equal(stripOverflows(rows.at(-1), style), true);

    const three = [shown(['Week']), shown(['Week']), shown(['Week'])];
    assert.equal(stripHeight([shown(['5h', 'Week']), shown(['Week'])], style), stripHeight(three, style));
    const signedOut = shown([], { status: 'signedout', message: 'Signed out' });
    assert(stripHeight([...three, signedOut], style) > stripHeight(three, style), `${style}: a message takes a row`);
  }
});

test('a Stale or Error note needs a taller row only in the meter style, where it sits under the name', () => {
  const plain = [shown(['Week']), shown(['Week']), shown(['Week'])];
  const noted = [shown(['Week'], { stale: true }), shown(['Week']), shown(['Week'])];
  assert(stripHeight(noted, 'meter') > stripHeight(plain, 'meter'));
  for (const style of ['gauge', 'segments']) assert.equal(stripHeight(noted, style), stripHeight(plain, style));
  assert.equal(STRIP.stacked, STRIP.line + STRIP.lineGap + STRIP.bar);
});

test('periods get a column only when rows differ, wide enough for the longest and never past its limit', () => {
  assert.equal(periodWidth([shown(['Week']), shown(['Week'])], 72), 0);
  assert.equal(periodWidth([shown([])], 72), 0);
  const mixed = periodWidth([shown(['5h', 'Week'])], 72);
  const longer = periodWidth([shown(['5h', 'Monthly'])], 72);
  assert(mixed > 0 && longer > mixed && longer <= 72, `${mixed} ${longer}`);
  assert.equal(periodWidth([shown(['A very long limit name · Week', '5h'])], 72), 72);
});

test('display style falls back to the gauge line, and segments never hide a remaining allowance', () => {
  assert.equal(stripStyle('segments'), 'segments');
  assert.equal(stripStyle('meter'), 'meter');
  for (const unknown of [undefined, null, 'pie', 3]) assert.equal(stripStyle(unknown), 'gauge');
  assert.deepEqual(
    [0, 0.4, 3, 14, 15, 86, 97, 100].map(percent => litSegments(percent)),
    [0, 1, 1, 1, 2, 9, 10, 10],
  );
});

test('a theme picked for the mod supplies its colors; a missing one falls back to the app', () => {
  const all = [
    { name: 'ink', light: false, colors: { accent: '#88aaff' } },
    { name: 'paper', light: true, colors: { accent: '#2255cc' } },
  ];
  assert.deepEqual(ownColors(all, 'paper'), { accent: '#2255cc' });
  for (const name of [null, '', 'deleted-theme']) assert.equal(ownColors(all, name), null);
});

test('a saved preference that is not a valid choice takes its default', () => {
  const defaults = { warn: 80, urgent: 95, sound: true, style: 'gauge', theme: null };
  for (const saved of [null, undefined, 'x', [], {}]) assert.deepEqual(readPrefs(saved), defaults);
  const chosen = { warn: 90, urgent: 100, sound: false, style: 'meter', theme: 'paper' };
  assert.deepEqual(readPrefs(chosen), chosen);
  assert.deepEqual(readPrefs({ warn: '90', urgent: 140, sound: 'no', style: 'pie', theme: 3 }), defaults);
});
