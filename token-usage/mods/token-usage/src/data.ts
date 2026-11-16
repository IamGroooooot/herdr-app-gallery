import * as fs from 'fs/promises';
import { appHome, exec, hc, home, readTextFile, writeTextFile } from 'herdr';
import { decodeReports } from './reports.js';
import { createSystem } from './system.js';
import type { ClaudeAuth, ClaudeLimits, ConnectionResult, Tokens } from './types.js';

export const system = createSystem(exec, process.platform);

export const dataDir = () => `${appHome()}/data/token-usage`;
export const tapPath = () => `${appHome()}/mods/token-usage/tap.sh`;
const CHUNK = 4 * 1024 * 1024;

const parse = (text: string | null) => {
  if (text == null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function utf8Len(s: string) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export async function ensureDataDir() {
  await fs.mkdir(`${dataDir()}/sessions`, { recursive: true });
  await system.restrict(dataDir());
}

export async function auth(): Promise<ClaudeAuth> {
  try {
    const r = await exec('claude', ['auth', 'status', '--json']);
    const s = parse(r.stdout.trim());
    if (s && typeof s === 'object') {
      if (!s.configDirectory) s.configDirectory = (await system.claudeConfigDir()) ?? undefined;
      return s;
    }
    return { error: (r.stderr || r.stdout).trim().split('\n').pop() || `claude exited ${r.code}` };
  } catch (e) {
    return { missing: true, error: String(e instanceof Error ? e.message : e) };
  }
}

export const configDir = (a: ClaudeAuth) => a?.configDirectory || `${home()}/.claude`;
export const projectsDir = (a: ClaudeAuth) => a?.projectsDirectory || `${configDir(a)}/projects`;

const tee = () => `{ [ -f ${shq(tapPath())} ] && sh ${shq(tapPath())} --tee || cat; }`;
const opening = () => `${tee()} | {\n`;
const CLOSING = '\n}';
const tapOnly = () => `${tee()} >/dev/null`;
const legacyOpening = () => `[ -f ${shq(tapPath())} ] && exec sh ${shq(tapPath())}`;

const wrap = (command: string) => (command ? `${opening()}${command}${CLOSING}` : tapOnly());

function unwrap(command: string, dir: string): string | null {
  if (typeof command !== 'string') return null;
  const text = command.trimEnd();
  if (text === tapOnly()) return '';
  if (text.startsWith(opening()) && text.endsWith(CLOSING) && text.length > opening().length + CLOSING.length) {
    return text.slice(opening().length, -CLOSING.length);
  }
  if (text.startsWith(legacyOpening())) {
    let rest = text.slice(legacyOpening().length);
    const arg = ` ${shq(backupDir(dir))}`;
    if (rest.startsWith(arg)) rest = rest.slice(arg.length);
    if (rest.startsWith('; ')) return rest.slice(2);
  }
  return null;
}

async function legacySaved(dir: string) {
  const text =
    (await readTextFile(`${backupDir(dir)}/original-statusline.json`)) ??
    (await readTextFile(`${dataDir()}/original-statusline.json`));
  return parse(text);
}

export async function connection(dir: string): Promise<ConnectionResult> {
  const path = `${dir}/settings.json`;
  const text = await readTextFile(path);
  const settings = text == null ? {} : parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return { path, error: `${path} is not valid JSON` };
  const command = settings.statusLine?.command;
  const connected = typeof command === 'string' && command.includes('/mods/token-usage/tap.sh');
  let own = connected ? unwrap(command, dir) : null;
  const legacy = own != null && command.trimEnd() !== tapOnly() && !command.startsWith(opening());
  if (legacy && own === 'true' && (await legacySaved(dir))?.command !== 'true') own = '';
  return { path, text, settings, connected, command: own, legacy };
}

/** Herdr's write keeps the file's mode and symlink. */
async function writeThrough(path: string, before: string | null, text: string) {
  try {
    await writeTextFile(path, text, before);
  } catch (e) {
    const reason = String(e instanceof Error ? e.message : e);
    throw new Error(
      /changed outside/i.test(reason)
        ? "Claude Code's settings changed while this ran. Try again."
        : reason || `Couldn't write ${path}`,
    );
  }
}

const pretty = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

export const backupDir = (dir: string) => `${dataDir()}/configs/${String(dir).replace(/[^A-Za-z0-9_-]/g, '_')}`;

async function forgetLegacy(dir: string) {
  const b = backupDir(dir);
  for (const name of ['original-command', 'original-statusline.json'])
    await fs.unlink(`${b}/${name}`).catch((): null => null);
  await fs.rmdir(b).catch((): null => null);
}

export async function connect(dir: string) {
  const c = await connection(dir);
  if (c.error !== undefined) throw new Error(c.error);
  if (c.connected) return;
  const original = c.settings.statusLine ?? null;
  const command = original?.type === 'command' && typeof original.command === 'string' ? original.command : '';
  const statusLine = { ...(original ?? {}), type: 'command', command: wrap(original ? command || 'true' : '') };
  await writeThrough(c.path, c.text, pretty({ ...c.settings, statusLine }));
}

export async function upgrade(dir: string) {
  const c = await connection(dir);
  if (c.error !== undefined || !c.legacy || c.command == null) return;
  await writeThrough(
    c.path,
    c.text,
    pretty({ ...c.settings, statusLine: { ...c.settings.statusLine, command: wrap(c.command) } }),
  );
  await forgetLegacy(dir);
}

export async function disconnect(dir: string) {
  const c = await connection(dir);
  if (c.error !== undefined) throw new Error(c.error);
  if (!c.connected) return;
  if (c.command == null)
    throw new Error(
      `Your statusline command in ${c.path} no longer has the shape Connect wrote. Remove tap.sh from it by hand.`,
    );
  const next = { ...c.settings };
  if (c.command) next.statusLine = { ...c.settings.statusLine, command: c.command };
  else delete next.statusLine;
  await writeThrough(c.path, c.text, pretty(next));
  await forgetLegacy(dir);
}

const reportsDir = () => `${dataDir()}/sessions`;

async function readReports(projects?: string) {
  const names = (await fs.readdir(reportsDir()).catch((): string[] => [])).filter(
    n => n.endsWith('.json') && !n.startsWith('.'),
  );
  const files = await Promise.all(
    names.map(async name => ({ name, text: await readTextFile(`${reportsDir()}/${name}`).catch((): null => null) })),
  );
  return { names, ...decodeReports(files, Date.now(), projects) };
}

const removeReports = (names: string[]) =>
  Promise.all(names.map(name => fs.unlink(`${reportsDir()}/${name}`).catch((): null => null)));

export async function clearReports() {
  await removeReports((await readReports()).names);
}

export async function prune() {
  await removeReports((await readReports()).expired);
}

export async function limits(projects?: string): Promise<ClaudeLimits> {
  const { limits, failures } = await readReports(projects);
  if (failures) throw new Error(`Could not read ${failures} Claude reports.`);
  return limits;
}

export async function sessionOf(address: string, dir: string) {
  const r = await hc(['get', address, '--json']);
  const pid = parse(r.stdout)?.foreground?.pid;
  if (!pid) return null;
  return parse(await readTextFile(`${dir}/sessions/${pid}.json`).catch((): null => null))?.sessionId ?? null;
}

export async function findTranscript(dir: string, sid: string) {
  let folders = [];
  try {
    folders = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const f of folders) {
    const path = `${dir}/${f}/${sid}.jsonl`;
    if (await fs.exists(path)) return path;
  }
  return null;
}

interface FileTotals extends Tokens {
  offset: number;
  seen: Set<string>;
}
const fresh = (): FileTotals => ({ offset: 0, seen: new Set(), output: 0, input: 0, cacheRead: 0, model: null });

export class Totals {
  files: Map<string, FileTotals>;
  constructor() {
    this.files = new Map<string, FileTotals>();
  }

  async of(transcript: string): Promise<Tokens> {
    const base = transcript.replace(/\.jsonl$/, '');
    let subs: string[] = [];
    try {
      subs = (await fs.readdir(`${base}/subagents`))
        .filter(n => n.endsWith('.jsonl'))
        .map(n => `${base}/subagents/${n}`);
    } catch {
      subs = [];
    }
    const files = [transcript, ...subs];
    const sizes = await system.sizes(files);
    const sum: Tokens = { output: 0, input: 0, cacheRead: 0, model: null };
    for (const file of files) {
      const known = this.files.get(file);
      const s = known && sizes.get(file) === known.offset ? known : await this.read(file);
      sum.output += s.output;
      sum.input += s.input;
      sum.cacheRead += s.cacheRead;
      if (file === transcript) sum.model = s.model;
    }
    return sum;
  }

  async read(file: string) {
    let s = this.files.get(file);
    if (!s) {
      s = fresh();
      this.files.set(file, s);
    }
    for (let i = 0; i < 8; i++) {
      const chunk = await system.readChunk(file, s.offset, CHUNK);
      if (!chunk) break;
      const { size, body } = chunk;
      if (size < s.offset) {
        Object.assign(s, fresh());
        continue;
      }
      if (!body) break;
      const end = body.lastIndexOf('\n');
      if (end < 0) {
        if (size - s.offset <= CHUNK) break;
        const n = await system.lineLength(file, s.offset);
        if (!n) break;
        s.offset += n;
        continue;
      }
      const text = body.slice(0, end + 1);
      s.offset += utf8Len(text);
      for (const line of text.split('\n')) this.take(s, line);
      if (s.offset >= size) break;
    }
    return s;
  }

  take(s: FileTotals, line: string) {
    if (!line.includes('"usage"')) return;
    const r = parse(line);
    const m = r?.message;
    if (!m?.usage || m.model === '<synthetic>') return;
    const key = m.id ?? r.requestId ?? r.uuid;
    if (key) {
      if (s.seen.has(key)) return;
      s.seen.add(key);
    }
    const u = m.usage;
    s.output += u.output_tokens ?? 0;
    s.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    s.cacheRead += u.cache_read_input_tokens ?? 0;
    if (m.model) s.model = m.model;
  }
}

export function modelName(id: string | null, fallback?: string | null) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? '');
  if (m) return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`;
  return (fallback ?? id ?? '').toLowerCase();
}
