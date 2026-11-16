import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexLogs, codexAccountFailure, codexAccountStatus, latestSamples, usageEvent } from '../codex.js';
import { codexReport } from '../providers.js';
import { event } from './helpers.js';

test('login status never carries CLI output, which may hold a key', () => {
  assert.deepEqual(codexAccountStatus(0, 'Logged in using an API key - sk-test-secret'), {
    kind: 'signed-in',
    method: 'API key',
  });
  assert.deepEqual(codexAccountStatus(0, 'Logged in using ChatGPT'), { kind: 'signed-in', method: 'ChatGPT' });
  assert.deepEqual(codexAccountStatus(1, 'Not logged in'), { kind: 'signed-out' });
  const undetermined = [
    [1, 'unexpected sk-test-secret'],
    [0, 'Logged in using sk-test-secret'],
    [1, 'Logged in using ChatGPT'],
  ];
  for (const [code, output] of undetermined) {
    assert.throws(
      () => codexAccountStatus(code, output),
      error => !error.message.includes('sk-test-secret'),
    );
  }
});
test('a missing CLI is unavailable; a slow or failing one is an error', () => {
  const missing = new Error('`herdr.exec`: cannot run codex: No such file or directory (os error 2)');
  assert.equal(codexAccountFailure(missing).kind, 'unavailable');
  for (const reason of [
    '`herdr.exec`: codex took longer than 8 s and was stopped',
    'permission denied sk-test-secret',
  ]) {
    assert.throws(
      () => codexAccountFailure(new Error(reason)),
      error => !error.message.includes('sk-test-secret'),
    );
  }
});
test('invalid values do not become usage', () => {
  assert.equal(usageEvent('{bad'), null);
  assert.equal(usageEvent(event('2026-11-16T00:00:00Z', 101)), null);
  assert.equal(usageEvent(event('2026-11-16T00:00:00Z', -1)), null);
  assert.equal(usageEvent(event('2026-11-16T00:00:00Z', '26')), null);
  assert.equal(usageEvent(event('not a time', 26)), null);
  assert.equal(usageEvent(event('2026-11-16T00:00:00Z', 26).replace('token_count', 'other')), null);
  assert.equal(
    usageEvent(
      '{"timestamp":"2026-11-16T00:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":null}}',
    ),
    null,
  );
});
test('a usage event keeps its time, limit and valid windows', () => {
  const sample = usageEvent(
    event('2026-11-16T00:00:00Z', 26, {
      limit_id: 'spark',
      limit_name: 'Spark',
      secondary: { used_percent: 5, window_minutes: 300, resets_at: -1 },
    }),
  );
  assert.deepEqual(sample, {
    at: 1794787200,
    limit_id: 'spark',
    name: 'Spark',
    windows: [{ key: 'primary', used: 26, minutes: 10080, resets: 2000000000 }],
  });
  const both = usageEvent(
    event('2026-11-16T00:00:00Z', 26, { secondary: { used_percent: 5, window_minutes: 300, resets_at: 1900000000 } }),
  );
  assert.deepEqual(
    both.windows.map(w => [w.key, w.used, w.minutes]),
    [
      ['primary', 26, 10080],
      ['secondary', 5, 300],
    ],
  );
  assert.deepEqual(
    codexReport({ samples: [both], error: null }).windows.map(w => w.label),
    ['Week', '5h'],
  );
  assert.deepEqual(
    latestSamples([event('2026-11-16T00:00:00Z', 1), event('2026-11-16T01:00:00Z', 2)]).map(s => s.windows[0].used),
    [2],
  );
});
test('logs combine into one report, codex first; a log that could not be read fails the report', async () => {
  const tails = [
    {
      path: 'a',
      size: 1,
      lines: [event('2026-11-16T00:00:00Z', 10), event('2026-11-16T00:30:00Z', 70, { limit_id: 'alpha' })],
    },
    { path: 'b', size: 1, lines: [event('2026-11-16T01:00:00Z', 20)] },
  ];
  const usage = await new CodexLogs(async () => ({ tails, failures: 0 })).read();
  assert.deepEqual(
    usage.samples.map(s => [s.limit_id, s.windows[0].used]),
    [
      ['codex', 20],
      ['alpha', 70],
    ],
  );
  assert.equal(codexReport(usage).windows.length, 2);
  const failed = await new CodexLogs(async () => ({ tails, failures: 2 })).read();
  assert.throws(() => codexReport(failed), /2 session logs/);
});
