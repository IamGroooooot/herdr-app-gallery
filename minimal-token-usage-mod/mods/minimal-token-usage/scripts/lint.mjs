import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mod = fileURLToPath(new URL('..', import.meta.url));
const has = command => spawnSync(command, ['--version']).status === 0;
const write = process.argv.includes('--write');
let failed = false;
const run = (command, args) => {
  if (spawnSync(command, args, { cwd: mod, stdio: 'inherit' }).status !== 0) failed = true;
};

const packageTests = existsSync(join(mod, '../../tests')) ? ['../../tests'] : [];
run(join(mod, 'node_modules/.bin/biome'), [
  'check',
  ...(write ? ['--write'] : []),
  'src',
  'tests',
  'scripts',
  ...packageTests,
]);

const scripts = ['tap.sh', ...(existsSync(join(mod, '../../install.sh')) ? ['../../install.sh'] : [])];
if (has('shellcheck')) {
  run('shellcheck', ['-s', 'sh', '-S', 'style', ...scripts]);
  const dir = mkdtempSync(join(tmpdir(), 'minimal-token-usage-lint-'));
  try {
    const { POSIX_SCRIPTS } = await import('../system.js');
    const files = Object.entries(POSIX_SCRIPTS).map(([name, text]) => {
      const file = join(dir, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\n${text}\n`);
      return file;
    });
    // SC2012: the `ls -lnt` in CODEX_TAILS is deliberate; system.ts says why.
    run('shellcheck', ['-s', 'sh', '-S', 'style', '-e', 'SC2012', ...files]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else console.log('shellcheck is not installed: shell scripts were not linted.');
if (has('shfmt')) run('shfmt', ['-i', '2', '-ci', write ? '-w' : '-d', ...scripts]);
else console.log('shfmt is not installed: shell formatting was not checked.');

process.exit(failed ? 1 : 0);
