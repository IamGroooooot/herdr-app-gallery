// Generated from src/data.ts. Edit the TS source, then run npm run verify.
import * as fs from 'fs/promises';
import { appHome, exec, hc, home, readTextFile, writeTextFile } from 'herdr';
import { finite, object, parseJson } from './json.js';
import { decodeReports } from './reports.js';
import { createSystem } from './system.js';
export const system = createSystem(exec, process.platform);
export const dataDir = () => `${appHome()}/data/minimal-token-usage`;
export const tapPath = () => `${appHome()}/mods/minimal-token-usage/tap.sh`;
const CHUNK = 4 * 1024 * 1024;
/** The JSON object in `text`; null for anything else. */
const parseObject = (text) => (text ? object(parseJson(text)) : null);
const text = (value) => (typeof value === 'string' && value ? value : undefined);
const count = (value) => (finite(value) ? value : 0);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80)
            n += 1;
        else if (c < 0x800)
            n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            n += 4;
            i++;
        }
        else
            n += 3;
    }
    return n;
}
export async function ensureDataDir() {
    await fs.mkdir(`${dataDir()}/sessions`, { recursive: true });
    await system.restrict(dataDir());
}
/** The variable a Claude CLI needs to act on the account of `sessionConfigDir`; none for Herdr's own account. */
export const claudeEnv = (sessionConfigDir) => sessionConfigDir ? ['CLAUDE_CONFIG_DIR', sessionConfigDir] : undefined;
/** `claude auth status --json`, keeping only the fields of the right type. */
function decodeAuth(status) {
    return {
        loggedIn: typeof status.loggedIn === 'boolean' ? status.loggedIn : undefined,
        configDirectory: text(status.configDirectory),
        projectsDirectory: text(status.projectsDirectory),
        email: text(status.email),
        orgId: text(status.orgId),
        authMethod: text(status.authMethod),
        subscriptionType: text(status.subscriptionType),
        loginExpiresAt: text(status.loginExpiresAt),
    };
}
/** The account of the session that reported last, which need not be the one Herdr's own environment names. */
export async function auth() {
    const sessionConfigDir = await lastSessionConfigDir();
    try {
        const r = await system.cli('claude', ['auth', 'status', '--json'], { env: claudeEnv(sessionConfigDir) });
        const status = parseObject(r.stdout.trim());
        if (!status)
            return { error: (r.stderr || r.stdout).trim().split('\n').pop() || `claude exited ${r.code}`, sessionConfigDir };
        const decoded = decodeAuth(status);
        const configDirectory = decoded.configDirectory ?? sessionConfigDir ?? (await system.claudeConfigDir()) ?? undefined;
        return { ...decoded, configDirectory, sessionConfigDir };
    }
    catch (e) {
        return { missing: true, error: String(e instanceof Error ? e.message : e), sessionConfigDir };
    }
}
export const configDir = (a) => a?.configDirectory || `${home()}/.claude`;
export const projectsDir = (a) => a?.projectsDirectory || `${configDir(a)}/projects`;
const tee = () => `{ [ -f ${shq(tapPath())} ] && sh ${shq(tapPath())} || cat; }`;
const opening = () => `${tee()} | {\n`;
const CLOSING = '\n}';
const tapOnly = () => `${tee()} >/dev/null`;
const wrap = (command) => (command ? `${opening()}${command}${CLOSING}` : tapOnly());
function unwrap(command) {
    const text = command.trimEnd();
    if (text === tapOnly())
        return '';
    if (text.startsWith(opening()) && text.endsWith(CLOSING) && text.length > opening().length + CLOSING.length) {
        return text.slice(opening().length, -CLOSING.length);
    }
    return null;
}
export async function connection(dir) {
    const path = `${dir}/settings.json`;
    const saved = await readTextFile(path);
    const settings = saved == null ? {} : parseObject(saved);
    if (!settings)
        return { path, error: `${path} is not valid JSON` };
    const command = object(settings.statusLine)?.command;
    const connected = typeof command === 'string' && command.includes('/mods/minimal-token-usage/tap.sh');
    return { path, text: saved, settings, connected, command: connected ? unwrap(command) : null };
}
/** Herdr's write keeps the file's mode and symlink. */
async function writeThrough(path, before, text) {
    try {
        await writeTextFile(path, text, before);
    }
    catch (e) {
        const reason = String(e instanceof Error ? e.message : e);
        throw new Error(/changed outside/i.test(reason)
            ? "Claude Code's settings changed while this ran. Try again."
            : reason || `Couldn't write ${path}`);
    }
}
const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;
export async function connect(dir) {
    const c = await connection(dir);
    if (c.error !== undefined)
        throw new Error(c.error);
    if (c.connected)
        return;
    const original = c.settings.statusLine ?? null;
    const command = original?.type === 'command' && typeof original.command === 'string' ? original.command : '';
    const statusLine = { ...(original ?? {}), type: 'command', command: wrap(original ? command || 'true' : '') };
    await writeThrough(c.path, c.text, pretty({ ...c.settings, statusLine }));
}
export async function disconnect(dir) {
    const c = await connection(dir);
    if (c.error !== undefined)
        throw new Error(c.error);
    if (!c.connected)
        return;
    if (c.command == null)
        throw new Error(`Your statusline command in ${c.path} no longer has the shape Connect wrote. Remove tap.sh from it by hand.`);
    const next = { ...c.settings };
    if (c.command)
        next.statusLine = { ...c.settings.statusLine, command: c.command };
    else
        delete next.statusLine;
    await writeThrough(c.path, c.text, pretty(next));
}
const reportsDir = () => `${dataDir()}/sessions`;
async function readReports(projects) {
    const names = (await fs.readdir(reportsDir()).catch(() => [])).filter(n => n.endsWith('.json') && !n.startsWith('.'));
    const files = await Promise.all(names.map(async (name) => ({ name, text: await readTextFile(`${reportsDir()}/${name}`).catch(() => null) })));
    return { names, ...decodeReports(files, Date.now(), projects) };
}
const removeReports = (names) => Promise.all(names.map(name => fs.unlink(`${reportsDir()}/${name}`).catch(() => null)));
export const lastSessionConfigDir = async () => (await readReports()).limits.sessionConfigDir;
export async function clearReports() {
    await removeReports((await readReports()).names);
}
export async function prune() {
    await removeReports((await readReports()).expired);
}
export async function limits(projects) {
    const { limits, failures } = await readReports(projects);
    if (failures)
        throw new Error(`Could not read ${failures} Claude reports.`);
    return limits;
}
export async function sessionOf(address, dir) {
    const r = await hc(['get', address, '--json']);
    const pid = object(parseObject(r.stdout)?.foreground)?.pid;
    if (!finite(pid) && !text(pid))
        return null;
    const session = parseObject(await readTextFile(`${dir}/sessions/${pid}.json`).catch(() => null));
    return text(session?.sessionId) ?? null;
}
export async function findTranscript(dir, sid) {
    let folders = [];
    try {
        folders = await fs.readdir(dir);
    }
    catch {
        return null;
    }
    for (const f of folders) {
        const path = `${dir}/${f}/${sid}.jsonl`;
        if (await fs.exists(path))
            return path;
    }
    return null;
}
const fresh = () => ({ offset: 0, seen: new Set(), output: 0, input: 0, cacheRead: 0, model: null });
export class Totals {
    files;
    constructor() {
        this.files = new Map();
    }
    async of(transcript) {
        const base = transcript.replace(/\.jsonl$/, '');
        let subs = [];
        try {
            subs = (await fs.readdir(`${base}/subagents`))
                .filter(n => n.endsWith('.jsonl'))
                .map(n => `${base}/subagents/${n}`);
        }
        catch {
            subs = [];
        }
        const files = [transcript, ...subs];
        const sizes = await system.sizes(files);
        const sum = { output: 0, input: 0, cacheRead: 0, model: null };
        for (const file of files) {
            const known = this.files.get(file);
            const s = known && sizes.get(file) === known.offset ? known : await this.read(file);
            sum.output += s.output;
            sum.input += s.input;
            sum.cacheRead += s.cacheRead;
            if (file === transcript)
                sum.model = s.model;
        }
        return sum;
    }
    async read(file) {
        let s = this.files.get(file);
        if (!s) {
            s = fresh();
            this.files.set(file, s);
        }
        for (let i = 0; i < 8; i++) {
            const chunk = await system.readChunk(file, s.offset, CHUNK);
            if (!chunk)
                break;
            const { size, body } = chunk;
            if (size < s.offset) {
                Object.assign(s, fresh());
                continue;
            }
            if (!body)
                break;
            const end = body.lastIndexOf('\n');
            if (end < 0) {
                if (size - s.offset <= CHUNK)
                    break;
                const n = await system.lineLength(file, s.offset);
                if (!n)
                    break;
                s.offset += n;
                continue;
            }
            const text = body.slice(0, end + 1);
            s.offset += utf8Len(text);
            for (const line of text.split('\n'))
                this.take(s, line);
            if (s.offset >= size)
                break;
        }
        return s;
    }
    take(s, line) {
        if (!line.includes('"usage"'))
            return;
        const r = parseObject(line);
        const m = object(r?.message);
        const u = object(m?.usage);
        if (!r || !m || !u || m.model === '<synthetic>')
            return;
        const key = text(m.id) ?? text(r.requestId) ?? text(r.uuid);
        if (key) {
            if (s.seen.has(key))
                return;
            s.seen.add(key);
        }
        s.output += count(u.output_tokens);
        s.input += count(u.input_tokens) + count(u.cache_creation_input_tokens);
        s.cacheRead += count(u.cache_read_input_tokens);
        s.model = text(m.model) ?? s.model;
    }
}
export function modelName(id, fallback) {
    const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? '');
    if (m)
        return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`;
    return (fallback ?? id ?? '').toLowerCase();
}
