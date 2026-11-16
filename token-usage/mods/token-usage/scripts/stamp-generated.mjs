import { readdir, readFile, writeFile } from 'node:fs/promises';

for (const file of await readdir(new URL('../src/', import.meta.url))) {
  if (!file.endsWith('.ts')) continue;
  const target = new URL(`../${file.replace(/\.ts$/, '.js')}`, import.meta.url);
  const code = await readFile(target, 'utf8');
  await writeFile(target, `// Generated from src/${file}. Edit the TS source, then run npm run verify.\n${code}`);
}
