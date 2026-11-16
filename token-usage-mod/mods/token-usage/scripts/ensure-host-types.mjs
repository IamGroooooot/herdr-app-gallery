import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (!existsSync(new URL('../gpui-kit.d.ts', import.meta.url))) {
  execFileSync('herdr-app', ['check', '.'], { stdio: 'inherit' });
}
