import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync(new URL('../gpui-kit.d.ts', import.meta.url))) {
  execFileSync('herdr-app', ['check', '.'], { stdio: 'inherit' });
}
