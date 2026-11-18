import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { decodeReports } from '../reports.js';
import { temp } from './helpers.js';

const now = 1_900_000_000_000;
const week = (used, resets = now / 1000 + 3600) => ({ seven_day: { used_percentage: used, resets_at: resets } });
const report = (at, payload) => JSON.stringify({ reported_at: at, report: payload });
const file = (name, text) => ({ name: `${name}.json`, text });

test('identical usage in a newer report is fresh', () => {
  const old = decodeReports([file('s', report(1000, { session_id: 's', rate_limits: week(59) }))], now);
  const fresh = decodeReports([file('s', report(2000, { session_id: 's', rate_limits: week(59) }))], now);
  assert.deepEqual(old.limits.windows, fresh.limits.windows);
  assert.equal(old.limits.reportedAt, 1000000);
  assert.equal(fresh.limits.reportedAt, 2000000);
});
test('the same usage reported by two sessions carries the newer report time, whichever file comes first', () => {
  const files = [
    file('a', report(1000, { session_id: 'a', rate_limits: week(59) })),
    file('b', report(2000, { session_id: 'b', rate_limits: week(59) })),
  ];
  assert.equal(decodeReports(files, now).limits.reportedAt, 2000000);
  assert.equal(decodeReports(files.reverse(), now).limits.reportedAt, 2000000);
});
test('the latest window wins across sessions, which keep their transcript and model', () => {
  const { limits } = decodeReports(
    [
      file(
        'a',
        report(now / 1000 - 60, {
          session_id: 'a',
          transcript_path: '/t/a.jsonl',
          model: { display_name: 'Fable' },
          rate_limits: week(40),
        }),
      ),
      file(
        'b',
        report(now / 1000 - 30, {
          session_id: 'b',
          rate_limits: { ...week(41), five_hour: { used_percentage: 120, resets_at: now / 1000 + 60 } },
        }),
      ),
      file('c', report(now / 1000, { rate_limits: {} })),
    ],
    now,
  );
  assert.deepEqual(limits.windows, { seven_day: { used: 41, resets: now / 1000 + 3600 } });
  assert.equal(limits.reportedAt, now - 30000);
  assert.equal(limits.reports, 3);
  assert.deepEqual(limits.sessions.get('a'), { transcript: '/t/a.jsonl', model: 'Fable' });
  assert.deepEqual(limits.sessions.get('c'), { transcript: null, model: null });
});
test('read errors are distinct from no reports', () => {
  const none = decodeReports([], now);
  assert.equal(none.failures, 0);
  assert.equal(none.limits.reportedAt, null);
  const bad = decodeReports([file('bad', '{broken'), file('gone', null)], now);
  assert.equal(bad.failures, 2);
  assert.deepEqual(bad.expired, ['bad.json', 'gone.json']);
});
test('reports saved before they were stamped still show limits, without a report time', () => {
  const { limits, expired } = decodeReports(
    [file('old', JSON.stringify({ session_id: 'old', rate_limits: week(59) }))],
    now,
  );
  assert.deepEqual(limits.windows.seven_day, { used: 59, resets: now / 1000 + 3600 });
  assert.equal(limits.reportedAt, null);
  assert.deepEqual(expired, []);
});
test('only reports with nothing left to show expire', () => {
  const days = n => now / 1000 - n * 86400;
  const { expired } = decodeReports(
    [
      file('recent', report(days(7), { rate_limits: week(10, days(1)) })),
      file('stale', report(days(9), { rate_limits: week(10) })),
      file('undated-reset', JSON.stringify({ rate_limits: week(10, days(1)) })),
      file('unstamped', report(0, { rate_limits: week(10, days(1)) })),
    ],
    now,
  );
  assert.deepEqual(expired, ['stale.json', 'undated-reset.json', 'unstamped.json']);
});

test('tap.sh stamps each report, passes the statusline input through and survives any payload', t => {
  const home = temp(t),
    mod = join(home, 'mods/minimal-token-usage');
  mkdirSync(mod, { recursive: true });
  cpSync(new URL('../tap.sh', import.meta.url), join(mod, 'tap.sh'));
  const payload = JSON.stringify({ session_id: 'abc-123', note: 'it\'s 100% \\n "quoted"', rate_limits: week(59) });
  const before = Date.now() / 1000 - 1;
  const configDir = '/tmp/a "b" \\ c';
  const run = (input, env = { CLAUDE_CONFIG_DIR: configDir }) =>
    spawnSync('sh', [join(mod, 'tap.sh')], { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  assert.equal(run(payload).stdout, payload);
  assert.equal(run('not json').stdout, 'not json');
  const sessions = join(home, 'data/minimal-token-usage/sessions');
  assert.deepEqual(readdirSync(sessions), ['abc-123.json']);
  const saved = JSON.parse(readFileSync(join(sessions, 'abc-123.json'), 'utf8'));
  assert.deepEqual(saved.report, JSON.parse(payload));
  assert(saved.reported_at >= before && saved.reported_at <= Date.now() / 1000 + 1);
  const { limits } = decodeReports([{ name: 'abc-123.json', text: JSON.stringify(saved) }], Date.now());
  assert.equal(limits.reportedAt, saved.reported_at * 1000);
  // The session's own config folder says which account replied; none means Claude's default.
  assert.equal(limits.sessionConfigDir, configDir);
  run(payload, {});
  assert.equal(JSON.parse(readFileSync(join(sessions, 'abc-123.json'), 'utf8')).config_dir, '');
  // Reports name the account's projects and sessions: only the user may read them.
  if (process.platform !== 'win32') {
    for (const path of [
      'data/minimal-token-usage',
      'data/minimal-token-usage/sessions',
      'data/minimal-token-usage/sessions/abc-123.json',
    ]) {
      assert.equal(statSync(join(home, path)).mode & 0o077, 0, path);
    }
  }

  // A session id becomes a file name, so one that would leave the folder is not saved at all.
  const escaping = JSON.stringify({ session_id: '/../evil' });
  assert.equal(run(escaping).stdout, escaping);
  assert.deepEqual(readdirSync(sessions), ['abc-123.json']);
  assert.deepEqual(readdirSync(join(home, 'data/minimal-token-usage')), ['sessions']);
});

test('the config folder to follow is that of the session that reported last', () => {
  const under = (at, config_dir) => JSON.stringify({ reported_at: at, config_dir, report: { rate_limits: week(1) } });
  const sessionConfigDir = files => decodeReports(files, now).limits.sessionConfigDir;
  assert.equal(
    sessionConfigDir([file('old', report(3000, { rate_limits: week(1) }))]),
    null,
    'no report names a folder',
  );
  const files = [file('work', under(2000, '/accounts/work')), file('own', under(1000, ''))];
  assert.equal(sessionConfigDir(files), '/accounts/work');
  assert.equal(sessionConfigDir(files.reverse()), '/accounts/work');
  assert.equal(
    sessionConfigDir([...files, file('later', under(2500, ''))]),
    null,
    'a session with no CLAUDE_CONFIG_DIR',
  );
});

test("sessions of another Claude account do not count as the signed-in account's limits", () => {
  const files = [
    file(
      'work',
      report(now / 1000 - 60, {
        session_id: 'work',
        transcript_path: '/home/u/work/projects/p/work.jsonl',
        rate_limits: week(2),
      }),
    ),
    file(
      'personal',
      report(now / 1000, {
        session_id: 'personal',
        transcript_path: '/home/u/.claude/projects/p/personal.jsonl',
        rate_limits: week(61, now / 1000 + 7200),
      }),
    ),
    file(
      'sibling',
      report(now / 1000, {
        transcript_path: '/home/u/work/projects-old/p/x.jsonl',
        rate_limits: week(99, now / 1000 + 9000),
      }),
    ),
    file('unknown', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 8, resets_at: now / 1000 + 60 } } })),
    // Saved before reports were stamped, by the other account: not this account's to prune.
    file(
      'personal-old',
      JSON.stringify({
        transcript_path: '/home/u/.claude/projects/p/old.jsonl',
        rate_limits: week(5, now / 1000 - 60),
      }),
    ),
  ];
  assert.equal(decodeReports(files, now).limits.windows.seven_day.used, 99);
  for (const projects of ['/home/u/work/projects', '/home/u/work/projects/']) {
    const { limits, expired } = decodeReports(files, now, projects);
    assert.deepEqual(limits.windows, {
      seven_day: { used: 2, resets: now / 1000 + 3600 },
      five_hour: { used: 8, resets: now / 1000 + 60 },
    });
    assert.equal(limits.sessions.get('personal').transcript, '/home/u/.claude/projects/p/personal.jsonl');
    assert.deepEqual(expired, []);
  }
  assert.equal(decodeReports(files, now, 'C:\\Users\\u\\.claude\\projects').limits.windows.seven_day, undefined);
});
