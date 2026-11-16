import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import './herdr.js';
import { temp } from './helpers.js';
import { host } from './herdr-stub.js';

const data = await import('../data.js');
const payload = JSON.stringify({
  session_id: 's1',
  rate_limits: { seven_day: { used_percentage: 59, resets_at: 2000000000 } },
});

function setup(t, settings) {
  const root = temp(t);
  Object.assign(host, { home: root, appHome: join(root, 'herdr app') });
  mkdirSync(join(host.appHome, 'mods/token-usage'), { recursive: true });
  cpSync(new URL('../tap.sh', import.meta.url), data.tapPath());
  const dir = join(root, "claude's config");
  mkdirSync(dir);
  const path = join(dir, 'settings.json');
  if (settings !== undefined) writeFileSync(path, typeof settings === 'string' ? settings : JSON.stringify(settings));
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  const sessions = join(data.dataDir(), 'sessions');
  return {
    dir,
    path,
    read,
    /** What Claude Code does after each reply: runs the statusline command with the payload on stdin. */
    statusline: () => spawnSync('sh', ['-c', read().statusLine.command], { input: payload, encoding: 'utf8' }),
    reports: () => (existsSync(sessions) ? readdirSync(sessions) : []),
  };
}

test('Connect keeps the existing statusline working and saves each report; Disconnect restores the settings', async t => {
  const own = `printf 'hud %s' "$(cat | wc -c | tr -d ' ')"`;
  const original = { model: 'fable', statusLine: { type: 'command', command: own, padding: 0 } };
  const f = setup(t, original);
  const before = spawnSync('sh', ['-c', own], { input: payload, encoding: 'utf8' }).stdout;
  assert.equal((await data.connection(f.dir)).connected, false);

  await data.connect(f.dir);
  assert.equal((await data.connection(f.dir)).connected, true);
  assert.deepEqual({ ...f.read(), statusLine: { ...f.read().statusLine, command: own } }, original);
  assert.equal(f.statusline().stdout, before);
  assert.deepEqual(f.reports(), ['s1.json']);

  const connected = f.read();
  await data.connect(f.dir);
  assert.deepEqual(f.read(), connected, 'connecting twice wraps the command once');

  rmSync(data.tapPath());
  assert.equal(f.statusline().stdout, before, 'the statusline keeps working after the mod is removed');

  await data.disconnect(f.dir);
  assert.deepEqual(f.read(), original);
  assert.equal((await data.connection(f.dir)).connected, false);
});

test('without a statusline of their own, Connect adds one that only saves reports and Disconnect removes it', async t => {
  for (const settings of [undefined, { model: 'fable' }]) {
    const f = setup(t, settings);
    await data.connect(f.dir);
    const run = f.statusline();
    assert.deepEqual([run.status, run.stdout], [0, '']);
    assert.deepEqual(f.reports(), ['s1.json']);
    await data.disconnect(f.dir);
    assert.deepEqual(f.read(), settings ?? {});
  }
});

test('a statusline edited by hand after Connect is left alone, and so are settings that are not valid', async t => {
  const f = setup(t, { statusLine: { type: 'command', command: 'cat' } });
  await data.connect(f.dir);
  const edited = { statusLine: { type: 'command', command: `${f.read().statusLine.command}; echo mine` } };
  writeFileSync(f.path, JSON.stringify(edited));
  await assert.rejects(data.disconnect(f.dir));
  assert.deepEqual(f.read(), edited);

  for (const text of ['{broken', '[]']) {
    const bad = setup(t, text);
    await assert.rejects(data.connect(bad.dir));
    await assert.rejects(data.disconnect(bad.dir));
    assert.equal(readFileSync(bad.path, 'utf8'), text);
  }
});

test('a statusline connected by an earlier version is moved to the current form and still disconnects', async t => {
  const f = setup(t);
  const legacy = `[ -f '${data.tapPath()}' ] && exec sh '${data.tapPath()}' '${data.backupDir(f.dir)}'; printf hud`;
  writeFileSync(f.path, JSON.stringify({ statusLine: { type: 'command', command: legacy } }));
  assert.deepEqual(
    (({ connected, legacy, command }) => ({ connected, legacy, command }))(await data.connection(f.dir)),
    { connected: true, legacy: true, command: 'printf hud' },
  );
  await data.upgrade(f.dir);
  assert.equal((await data.connection(f.dir)).legacy, false);
  assert.equal(f.statusline().stdout, 'hud');
  assert.deepEqual(f.reports(), ['s1.json']);
  await data.disconnect(f.dir);
  assert.deepEqual(f.read(), { statusLine: { type: 'command', command: 'printf hud' } });
});

test('token totals count each reply once, add subagents and follow a transcript as it grows or is rewritten', async t => {
  const f = setup(t);
  const turn = (id, usage, model = 'claude-fable-5-2') => `${JSON.stringify({ message: { id, model, usage } })}\n`;
  const first = turn('m1', {
    input_tokens: 10,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 100,
    output_tokens: 7,
  });
  const transcript = join(f.dir, 'session.jsonl');
  writeFileSync(
    transcript,
    `${first}${first}${JSON.stringify({ type: 'user', text: 'é' })}\n${turn('m2', { output_tokens: 9 }, '<synthetic>')}`,
  );
  mkdirSync(join(f.dir, 'session/subagents'), { recursive: true });
  writeFileSync(
    join(f.dir, 'session/subagents/agent.jsonl'),
    turn('s1', { input_tokens: 3, output_tokens: 4 }, 'claude-haiku-5-5'),
  );
  const totals = new data.Totals();
  const model = 'claude-fable-5-2';
  assert.deepEqual(await totals.of(transcript), { output: 11, input: 18, cacheRead: 100, model });
  assert.deepEqual(await totals.of(transcript), { output: 11, input: 18, cacheRead: 100, model });

  appendFileSync(
    transcript,
    `${turn('m3', { input_tokens: 2, output_tokens: 1 })}{"message":{"id":"m4","usage":{"output_tokens":50`,
  );
  assert.deepEqual(await totals.of(transcript), { output: 12, input: 20, cacheRead: 100, model });
  appendFileSync(transcript, '}}}\n');
  assert.deepEqual(await totals.of(transcript), { output: 62, input: 20, cacheRead: 100, model });

  writeFileSync(transcript, turn('n1', { input_tokens: 1, output_tokens: 1 }));
  assert.deepEqual(await totals.of(transcript), { output: 5, input: 4, cacheRead: 0, model });
});

test('byte offsets match the file for any text, and model ids read as names', () => {
  for (const text of ['', 'plain', 'é', '한국어', '😀 emoji', 'mixed é한😀\n', '\ud83d']) {
    assert.equal(data.utf8Len(text), Buffer.byteLength(text), JSON.stringify(text));
  }
  assert.equal(data.modelName('claude-fable-5-2'), 'fable 5.2');
  assert.equal(data.modelName('claude-opus-5'), 'opus 5');
  assert.equal(data.modelName(null, 'Fable'), 'fable');
  assert.equal(data.modelName(null), '');
});
