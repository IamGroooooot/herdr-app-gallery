import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = new Set(['node_modules', 'gpui-kit.d.ts', '.DS_Store']);
const mod = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layoutPackage = resolve(mod, '../..');
const copy = resolve(layoutPackage, '../token-usage-mod/mods', basename(mod));
// Only the copy inside the layout package is a source; the standalone copy never mirrors itself.
if (
  basename(layoutPackage) === 'token-usage' &&
  copy !== mod &&
  existsSync(resolve(layoutPackage, '../token-usage-mod'))
) {
  mkdirSync(copy, { recursive: true });
  for (const name of readdirSync(copy)) if (!KEEP.has(name)) rmSync(join(copy, name), { recursive: true, force: true });
  cpSync(mod, copy, { recursive: true, filter: source => !KEEP.has(basename(source)) });
}
