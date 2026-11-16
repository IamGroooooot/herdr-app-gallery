import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const shells = ['sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];

for (const shell of shells) {
  const setup = t => {
    const root = mkdtempSync(join(tmpdir(), 'token usage install '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin'),
      config = join(root, 'herdr app');
    mkdirSync(bin);
    mkdirSync(config);
    writeFileSync(
      join(bin, 'herdr-app'),
      '#!/bin/sh\n[ "$1" = check ] && [ -f "$2/main.js" ] && exit "${CHECK_EXIT:-0}"\nexit 9\n',
    );
    chmodSync(join(bin, 'herdr-app'), 0o755);
    const run = (args, env = {}) =>
      spawnSync(shell, [installer, ...args], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ...env },
      });
    const install = (args = [], env = {}) => run(['--config', config, ...args], env);
    return { root, config, mod: join(config, 'mods/token-usage'), install, run };
  };

  test(`${shell}: installs only what Herdr runs, refuses to overwrite, and backs up on --replace`, t => {
    const { config, mod, install } = setup(t);
    writeFileSync(join(config, 'settings.json'), '{"zoom":1.2}');
    assert.equal(install().status, 0);
    assert.deepEqual(
      readdirSync(mod)
        .filter(name => !name.endsWith('.js'))
        .sort(),
      ['icons', 'mod.json', 'tap.sh'],
    );
    for (const file of ['main.js', 'system.js', 'icons/chart.svg']) assert(existsSync(join(mod, file)), file);
    assert(existsSync(join(config, 'layouts/token-usage.json')) && existsSync(join(config, 'layouts/token-usage.svg')));
    writeFileSync(join(mod, 'personal.txt'), 'keep');
    const refused = install();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already exists\. Use --replace/);
    assert.equal(readFileSync(join(mod, 'personal.txt'), 'utf8'), 'keep');
    const replaced = install(['--replace']);
    assert.equal(replaced.status, 0);
    const backup = /^Backup: (.+)$/m.exec(replaced.stdout)[1];
    assert.equal(readFileSync(join(backup, 'token-usage/personal.txt'), 'utf8'), 'keep');
    assert(existsSync(join(backup, 'token-usage.json')));
    assert(!existsSync(join(mod, 'personal.txt')));
    assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), '{"zoom":1.2}');
  });

  test(`${shell}: a mod Herdr rejects leaves the previous install untouched`, t => {
    const { config, mod, install } = setup(t);
    assert.equal(install([], { CHECK_EXIT: '1' }).status, 1);
    assert(!existsSync(mod) && !existsSync(join(config, 'layouts/token-usage.json')));
    assert.equal(install().status, 0);
    writeFileSync(join(mod, 'personal.txt'), 'keep');
    const failed = install(['--replace'], { CHECK_EXIT: '1' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Nothing was changed/);
    assert.equal(readFileSync(join(mod, 'personal.txt'), 'utf8'), 'keep');
    assert(existsSync(join(config, 'layouts/token-usage.json')));
    assert.deepEqual(readdirSync(join(config, '.token-usage-backups')), []);
  });

  test(`${shell}: needs Herdr and rejects unknown options before touching anything`, t => {
    const { config, install } = setup(t);
    assert.equal(install(['--force']).status, 2);
    const missing = install([], { PATH: '/usr/bin:/bin' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /herdr-app must be on PATH/);
    assert.deepEqual(readdirSync(config), []);
  });

  test(`${shell}: installs into Herdr's own folder unless told another`, t => {
    const { root, run } = setup(t);
    const installed = dir =>
      existsSync(join(dir, 'mods/token-usage/main.js')) && existsSync(join(dir, 'layouts/token-usage.json'));
    assert.equal(run([]).status, 0);
    assert(installed(join(root, '.config/herdr-app')));
    assert.equal(run([], { HERDR_APP_HOME: join(root, 'from env') }).status, 0);
    assert(installed(join(root, 'from env')));
    assert.equal(run([`--config=${join(root, 'by option')}`], { HERDR_APP_HOME: join(root, 'unused') }).status, 0);
    assert(installed(join(root, 'by option')) && !existsSync(join(root, 'unused')));
  });
}

test('the standalone mod package is a copy of the mod', t => {
  const mod = fileURLToPath(new URL('../mods/token-usage', import.meta.url));
  const packaged = fileURLToPath(new URL('../../token-usage-mod', import.meta.url));
  if (!existsSync(packaged)) return t.skip('token-usage-mod is not next to this package');
  const ignored = new Set(['node_modules', 'gpui-kit.d.ts', '.DS_Store']);
  const files = root =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(
        entry =>
          entry.isFile() &&
          !relative(root, join(entry.parentPath, entry.name))
            .split(/[\\/]/)
            .some(part => ignored.has(part)),
      )
      .map(entry => relative(root, join(entry.parentPath, entry.name)))
      .sort();
  assert(!existsSync(join(packaged, 'layouts')), 'a mod package must not contain layouts/');
  const copy = join(packaged, 'mods/token-usage');
  assert.deepEqual(files(copy), files(mod), 'token-usage-mod is out of date; run npm run mirror in mods/token-usage');
  for (const file of files(mod))
    assert(readFileSync(join(copy, file)).equals(readFileSync(join(mod, file))), `${file} differs; run npm run mirror`);
});
