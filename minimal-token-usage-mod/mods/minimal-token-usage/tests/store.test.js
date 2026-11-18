import assert from 'node:assert/strict';
import test from 'node:test';
import { claimAlert, UsageStore } from '../store.js';
import { usageProviders } from '../usage-model.js';

const account = identity => ({ kind: 'signed-in', method: 'claude.ai', context: { identity } });

function fixture() {
  let now = 100000;
  let link = { connected: true };
  const counts = { claudeAccount: 0, codexAccount: 0, claudeUsage: 0, codexUsage: 0, connection: 0, cleared: 0 };
  const states = { claude: account('a'), codex: { kind: 'signed-in', method: 'ChatGPT' } };
  const providers = Object.fromEntries(
    ['claude', 'codex'].map(id => [
      id,
      {
        id,
        name: id,
        async readAccount() {
          counts[`${id}Account`]++;
          return states[id];
        },
        async readUsage() {
          counts[`${id}Usage`]++;
          const windows = [{ key: 'week', label: 'Week', used: 59, resets: 99999 }];
          return { windows, reportedAt: now, sessions: new Map() };
        },
        login: { name: 'login', argv: [] },
        logout: { name: 'logout', argv: [] },
      },
    ]),
  );
  const store = new UsageStore(
    providers,
    {
      async connection() {
        counts.connection++;
        return link;
      },
      async accountChanged() {
        counts.cleared++;
      },
    },
    () => now,
  );
  const claude = () =>
    usageProviders(
      [
        {
          provider: providers.claude,
          account: store.accounts.claude,
          usage: store.usage.claude,
          connection: store.connection,
        },
      ],
      now,
    )[0];
  return {
    store,
    counts,
    states,
    claude,
    now: () => now,
    advance: ms => {
      now += ms;
    },
    link: next => {
      link = next;
    },
  };
}

test('many views share one read and one polling cadence', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, () => f.store.poll()));
  assert.deepEqual(f.counts, {
    claudeAccount: 1,
    codexAccount: 1,
    claudeUsage: 1,
    codexUsage: 1,
    connection: 1,
    cleared: 0,
  });
  f.advance(5000);
  await f.store.poll();
  assert.deepEqual([f.counts.claudeUsage, f.counts.codexUsage], [1, 1]);
  f.advance(5000);
  await f.store.poll();
  assert.deepEqual([f.counts.claudeUsage, f.counts.codexUsage], [2, 1]);
  f.advance(5000);
  await f.store.poll();
  assert.equal(f.counts.codexUsage, 2);
});

test('a signed-in account is rechecked after five minutes; a signed-out or watched one every ten seconds', async () => {
  const f = fixture();
  f.states.codex = { kind: 'signed-out' };
  await f.store.poll();
  f.advance(10000);
  await f.store.poll();
  assert.deepEqual([f.counts.claudeAccount, f.counts.codexAccount], [1, 2]);
  assert.equal(f.counts.codexUsage, 0, 'usage is not read for a signed-out account');
  f.advance(290000);
  await f.store.poll();
  assert.equal(f.counts.claudeAccount, 2);

  f.store.watchAccount('claude');
  f.advance(10000);
  await f.store.poll();
  f.advance(10000);
  await f.store.poll();
  assert.equal(f.counts.claudeAccount, 4);
  f.advance(120000);
  await f.store.poll();
  assert.equal(f.counts.claudeAccount, 4);
});

test('settings changes are checked without waiting for auth expiry', async () => {
  const f = fixture();
  await f.store.poll();
  f.advance(10000);
  await f.store.poll();
  assert.equal(f.counts.claudeAccount, 1);
  assert.equal(f.counts.connection, 2);
});

test('account refresh changes the panel and settings source together', async () => {
  const f = fixture();
  await f.store.poll();
  assert.equal(f.claude().status, 'ready');
  f.states.claude = { kind: 'signed-out' };
  await f.store.refreshAccount('claude', true);
  assert.equal(f.store.accounts.claude.value.kind, 'signed-out');
  assert.equal(f.claude().status, 'signedout');
  assert.equal(f.claude().windows.length, 0);
});

test('signing out and back in shows no limits until they are read again', async () => {
  const f = fixture();
  await f.store.poll();
  f.states.claude = { kind: 'signed-out' };
  await f.store.refreshAccount('claude', true);
  f.states.claude = account('a');
  await f.store.refreshAccount('claude', true);
  assert.equal(f.claude().status, 'waiting');
  assert.equal(f.counts.cleared, 0, 'the same account keeps its saved reports');
  await f.store.poll();
  assert.equal(f.claude().status, 'ready');
});

test('another Claude account, with or without a sign-out between, drops the old usage, connection and reports', async () => {
  const afterSignOut = fixture();
  await afterSignOut.store.poll();
  afterSignOut.states.claude = { kind: 'signed-out' };
  await afterSignOut.store.refreshAccount('claude', true);
  afterSignOut.states.claude = account('b');
  await afterSignOut.store.refreshAccount('claude', true);
  assert.equal(afterSignOut.counts.cleared, 1);
  assert.equal(afterSignOut.claude().status, 'waiting');

  const direct = fixture();
  await direct.store.poll();
  direct.states.claude = account('b');
  await direct.store.accounts.claude.refresh();
  assert.equal(direct.counts.cleared, 1);
  assert.equal(direct.claude().status, 'loading', 'the old account’s connection is not shown for the new one');
  await direct.store.poll();
  assert.equal(direct.claude().status, 'ready');
  assert.equal(direct.counts.claudeUsage, 2);
});

test('a remembered identity prevents previous-account reports returning after restart', async () => {
  const f = fixture();
  let remembered = 'previous-account';
  let cleared = 0;
  const store = new UsageStore(f.store.providers, {
    connection: async () => ({ connected: true }),
    accountChanged: async () => {
      cleared++;
    },
    claudeIdentity: {
      read: () => remembered,
      write: (_directory, id) => {
        remembered = id;
      },
    },
  });
  await store.poll();
  assert.equal(cleared, 1);
  assert.equal(remembered, 'a');
});

test('a reply from a session under another config folder shows that folder’s account, and keeps both accounts’ reports', async () => {
  const f = fixture();
  const inFolder = (identity, sessionConfigDir) => ({
    kind: 'signed-in',
    method: 'claude.ai',
    context: { identity, sessionConfigDir, configDirectory: sessionConfigDir ?? '/home/.claude' },
  });
  let sessionConfigDir = null;
  let cleared = 0;
  const remembered = {};
  const accounts = { '/home/.claude': 'own', '/accounts/work': 'work' };
  f.store.providers.claude.readAccount = async () =>
    inFolder(accounts[sessionConfigDir ?? '/home/.claude'], sessionConfigDir);
  const store = new UsageStore(
    f.store.providers,
    {
      connection: async () => ({ connected: true }),
      accountChanged: async () => {
        cleared++;
      },
      sessionConfigDir: async () => sessionConfigDir,
      claudeIdentity: {
        read: directory => remembered[directory] ?? null,
        write: (directory, identity) => {
          remembered[directory] = identity;
        },
      },
    },
    f.now,
  );
  await store.poll();
  assert.equal(store.accounts.claude.value.context.identity, 'own');
  sessionConfigDir = '/accounts/work';
  f.advance(10000);
  await store.poll();
  assert.equal(store.accounts.claude.value.context.identity, 'work');
  assert.equal(store.usage.claude.value.windows.length, 1, 'its limits are read at once');
  sessionConfigDir = null;
  f.advance(10000);
  await store.poll();
  assert.equal(store.accounts.claude.value.context.identity, 'own');
  assert.equal(cleared, 0, 'two folders are two accounts, not one account that changed');
  assert.deepEqual(remembered, { '/home/.claude': 'own', '/accounts/work': 'work' });

  accounts['/home/.claude'] = 'someone else';
  await store.refreshAccount('claude', true);
  assert.equal(cleared, 1, 'another sign-in in the same folder still drops its old reports');
});

test('Connect and Disconnect show at once; settings that cannot be read are an error, not a missing connection', async () => {
  const f = fixture();
  await f.store.poll();
  f.link({ connected: false });
  await f.store.connectionChanged();
  assert.equal(f.claude().status, 'unlinked');
  f.link({ error: 'settings.json is not valid JSON' });
  await f.store.connectionChanged();
  assert.equal(f.claude().status, 'error');
  assert.equal(f.claude().error, 'settings.json is not valid JSON');
  f.link({ connected: true });
  await f.store.connectionChanged();
  assert.equal(f.claude().status, 'ready');
});

test('alert claims coordinate views, preserve keys and separate limit periods', () => {
  let keys = [];
  const read = () => keys;
  const write = value => {
    keys = value;
  };
  assert.equal(claimAlert(read, write, 'week:1:urgent'), true);
  assert.equal(claimAlert(read, write, 'week:1:urgent'), false);
  assert.equal(claimAlert(read, write, 'week:2:warn'), true);
  assert.deepEqual(keys, ['week:1:urgent', 'week:2:warn']);
});
