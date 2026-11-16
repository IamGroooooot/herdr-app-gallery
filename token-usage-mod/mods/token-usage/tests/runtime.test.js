import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import './herdr.js';
import { temp } from './helpers.js';
import { host } from './herdr-stub.js';

const data = await import('../data.js');
let loads = 0;

async function claude(t, prefs) {
  const root = temp(t);
  const dir = join(root, 'claude');
  mkdirSync(dir);
  Object.assign(host, {
    home: root,
    appHome: join(root, 'herdr'),
    notices: [],
    sounds: [],
    shared: new Map(prefs ? [['token-usage.prefs', prefs]] : []),
    programs: {
      claude: () => ({
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'a@example.test',
          configDirectory: dir,
        }),
        stderr: '',
      }),
      codex: () => ({ code: 1, stdout: 'Not logged in', stderr: '' }),
    },
  });
  await data.connect(dir);
  const sessions = join(data.dataDir(), 'sessions');
  mkdirSync(sessions, { recursive: true });
  // One store per load of the module, as in Herdr.
  const { usageStore } = await import(`../runtime.js?${++loads}`);
  const store = usageStore();
  const started = Date.now() / 1000;
  return {
    store,
    async reply(used, { age = 0, resetsIn = 86400 } = {}) {
      const limit = { used_percentage: used, resets_at: started + resetsIn };
      const report = { session_id: 's', rate_limits: { seven_day: limit } };
      writeFileSync(join(sessions, 's.json'), JSON.stringify({ reported_at: Date.now() / 1000 - age, report }));
      await store.usage.claude.refresh();
      await store.poll();
    },
  };
}
const levels = () => host.notices.map(notice => notice.level);

test('an urgent limit alerts once, with a sound, however often the views refresh', async t => {
  const f = await claude(t);
  await f.store.poll();
  assert.deepEqual(levels(), []);
  await f.reply(96);
  await f.reply(96);
  await f.store.poll();
  assert.deepEqual(levels(), ['error']);
  assert.match(host.notices[0].title, /96%/);
  assert.deepEqual(host.sounds, ['blocked']);
});

test('a warning is silent, and the same limit alerts again only when it turns urgent', async t => {
  const f = await claude(t);
  await f.reply(79);
  assert.deepEqual(levels(), []);
  await f.reply(85);
  await f.reply(88);
  assert.deepEqual(levels(), ['warning']);
  await f.reply(96);
  assert.deepEqual(levels(), ['warning', 'error']);
  assert.deepEqual(host.sounds, ['blocked']);
});

test('alerts follow the thresholds and the sound choice in Usage settings', async t => {
  const quiet = await claude(t, { warn: 90, urgent: 99, sound: false });
  await quiet.reply(85);
  assert.deepEqual(levels(), []);
  await quiet.reply(92);
  assert.deepEqual(levels(), ['warning']);
  await quiet.reply(99);
  assert.deepEqual(levels(), ['warning', 'error']);
  assert.deepEqual(host.sounds, []);
});

test('an old report or a limit that has already reset does not alert', async t => {
  const old = await claude(t);
  await old.reply(96, { age: 2 * 3600 });
  assert.deepEqual(levels(), []);
  const reset = await claude(t);
  await reset.reply(96, { resetsIn: -60 });
  assert.deepEqual(levels(), []);
});
