import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CodexLogs } from '../codex.js';
import { createSystem } from '../system.js';
import { event, execWith, missingShells, shells, temp } from './helpers.js';

for (const shell of missingShells) test(`${shell}: not on this machine`, { skip: true }, () => {});

for (const [shell, platform, remap] of shells) {
  const codex = (home, env = { CODEX_HOME: home }) => {
    const system = createSystem(execWith(env, remap), platform);
    return { system, logs: new CodexLogs(known => system.codexTails(known)) };
  };
  const day = (home, name = '2026/11/16') => {
    const dir = join(home, 'sessions', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const used = usage => usage.samples.map(s => s.windows[0].used);

  test(`${shell}: the newest usage event wins; partial and foreign lines are ignored`, async t => {
    const home = temp(t),
      dir = day(home);
    writeFileSync(join(dir, 'old.jsonl'), event('2026-11-16T00:00:00Z', 90));
    writeFileSync(
      join(dir, 'new.jsonl'),
      `{"type":"message","text":"\\"token_count\\" is not usage"}\n${event('2026-11-16T01:00:00Z', 26)}{partial`,
    );
    writeFileSync(join(dir, 'notes.txt'), event('2026-11-16T02:00:00Z', 99));
    const usage = await codex(home).logs.read();
    assert.deepEqual(used(usage), [26]);
    assert.equal(usage.error, null);
  });

  test(`${shell}: a log is read again only after it has grown`, async t => {
    const home = temp(t),
      log = join(day(home), 'session.jsonl');
    writeFileSync(log, event('2026-11-16T00:00:00Z', 26));
    const { system, logs } = codex(home);
    assert.deepEqual(used(await logs.read()), [26]);
    // Codex only appends, so the same size means the same content: this rewrite must go unseen.
    writeFileSync(log, event('2026-11-16T00:00:00Z', 27));
    assert.deepEqual(used(await logs.read()), [26]);
    appendFileSync(log, event('2026-11-16T01:00:00Z', 28));
    assert.deepEqual(used(await logs.read()), [28]);

    const first = await system.codexTails(new Map());
    assert.deepEqual(
      first.tails.map(tail => tail.lines.length),
      [2],
    );
    const known = new Map(first.tails.map(tail => [tail.path, tail.size]));
    assert.deepEqual((await system.codexTails(known)).tails, [{ ...first.tails[0], lines: null }]);
    appendFileSync(log, event('2026-11-16T02:00:00Z', 29));
    assert.deepEqual(
      (await system.codexTails(known)).tails.map(tail => tail.lines.length),
      [3],
    );
  });

  test(`${shell}: only the end of a large log is read, and a cut line is not usage`, async t => {
    const home = temp(t),
      log = join(day(home), 'big.jsonl');
    const filler = `${JSON.stringify({ type: 'message', text: 'é'.repeat(4000) })}\n`;
    writeFileSync(
      log,
      event('2026-11-16T00:00:00Z', 11) + filler.repeat(300) + event('2026-11-16T01:00:00Z', 42) + filler,
    );
    assert.deepEqual(used(await codex(home).logs.read()), [42]);
    writeFileSync(log, event('2026-11-16T00:00:00Z', 11) + filler.repeat(300));
    assert.deepEqual(used(await codex(home).logs.read()), []);
  });

  test(`${shell}: at most eight days and the 24 most recently written logs are considered`, async t => {
    const home = temp(t);
    for (let d = 1; d <= 9; d++)
      writeFileSync(
        join(day(home, `2026/11/0${d}`), 'a.jsonl'),
        event(`2026-11-0${d}T00:00:00Z`, d, { limit_id: `day${d}` }),
      );
    const busy = day(home, '2026/11/10');
    for (let i = 0; i < 30; i++) {
      const log = join(busy, `rollout-${String(i).padStart(2, '0')}.jsonl`);
      writeFileSync(log, event('2026-11-10T00:00:00Z', i, { limit_id: `log${i}` }));
      utimesSync(log, 1000 + i, 1000 + i);
    }
    const { system, logs } = codex(home);
    const ids = (await logs.read()).samples.map(s => s.limit_id);
    // Ten day folders: the newest eight are 03 to 10. Their seven single logs were written last,
    // which leaves 17 of the 24 places to the busy day's newest logs, 13 to 29.
    assert(!ids.includes('day2') && ids.includes('day3') && ids.includes('day9'), 'only the newest eight days');
    assert(!ids.includes('log12') && ids.includes('log13') && ids.includes('log29'), 'only the newest 24 logs');
    assert.equal((await system.codexTails(new Map())).tails.length, 24);
  });

  test(`${shell}: no sessions folder is reported, not treated as zero usage`, async t => {
    const home = temp(t);
    assert.equal(await codex(home).system.codexTails(new Map()), null);
    assert.match((await codex(home).logs.read()).error, /No Codex session logs/);
  });

  test(`${shell}: without CODEX_HOME, logs come from ~/.codex`, async t => {
    const home = temp(t);
    writeFileSync(join(day(join(home, '.codex')), 'a.jsonl'), event('2026-11-16T00:00:00Z', 33));
    assert.deepEqual(used(await codex(home, { CODEX_HOME: null, HOME: home, USERPROFILE: home }).logs.read()), [33]);
  });

  test(`${shell}: sizes, byte ranges and line lengths of a growing transcript`, async t => {
    const dir = temp(t),
      file = join(dir, "it's a transcript.jsonl");
    writeFileSync(file, 'first é\nsecond\nthird without end');
    const { system } = codex(dir);
    assert.deepEqual([...(await system.sizes([file, join(dir, 'missing')]))], [[file, 33]]);
    assert.deepEqual(await system.readChunk(file, 0, 9), { size: 33, body: 'first é\n' });
    assert.deepEqual(await system.readChunk(file, 9, 100), { size: 33, body: 'second\nthird without end' });
    assert.deepEqual(await system.readChunk(file, 33, 100), { size: 33, body: '' });
    assert.equal(await system.readChunk(join(dir, 'missing'), 0, 10), null);
    assert.equal(await system.lineLength(file, 0), 9);
    assert.equal(await system.lineLength(file, 9), 7);
    assert.equal(await system.lineLength(file, 16), 0);
    const long = join(dir, 'long.jsonl'),
      start = 3 * 65536 + 17;
    writeFileSync(long, `${'x'.repeat(start - 1)}\nfourth\nfifth`);
    assert.deepEqual(await system.readChunk(long, start, 9), { size: start + 12, body: 'fourth\nfi' });
    assert.equal(await system.lineLength(long, start), 7);
    assert.equal(await system.lineLength(long, 0), start);
  });

  test(`${shell}: Claude's config folder comes from the user's environment`, async () => {
    assert.equal(await codex('', { CLAUDE_CONFIG_DIR: '/tmp/a b' }).system.claudeConfigDir(), '/tmp/a b');
    assert.equal(await codex('', { CLAUDE_CONFIG_DIR: null }).system.claudeConfigDir(), null);
  });
}
