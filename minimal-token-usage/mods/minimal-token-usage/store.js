// Generated from src/store.ts. Edit the TS source, then run npm run verify.
import { Resource } from './resource.js';
export class UsageStore {
    providers;
    clock;
    accounts;
    usage;
    connection;
    sessionConfigDir;
    /** Keyed by provider and config folder: two folders hold two accounts, and neither replaces the other. */
    lastIdentity = new Map();
    watchUntil = { claude: 0, codex: 0 };
    constructor(providers, io, clock = Date.now, changed = () => { }) {
        this.providers = providers;
        this.clock = clock;
        this.sessionConfigDir = new Resource(async () => (await io.sessionConfigDir?.()) ?? null, clock);
        this.usage = {
            claude: new Resource(providers.claude.readUsage, clock, changed),
            codex: new Resource(providers.codex.readUsage, clock, changed),
        };
        const account = (id) => new Resource(async () => {
            const next = await providers[id].readAccount();
            const previous = this.accounts[id].value;
            const identity = next.kind === 'signed-in' ? next.context?.identity : undefined;
            const directory = next.context?.configDirectory ?? '';
            const key = `${id}:${directory}`;
            const last = this.lastIdentity.get(key) ?? (id === 'claude' ? io.claudeIdentity?.read(directory) : null);
            const switched = Boolean(identity && last && last !== identity);
            if (switched || previous?.kind !== next.kind) {
                this.usage[id].invalidate();
                if (id === 'claude')
                    this.connection.invalidate();
                if (switched && id === 'claude')
                    await io.accountChanged();
            }
            if (identity && identity !== last) {
                this.lastIdentity.set(key, identity);
                if (id === 'claude')
                    io.claudeIdentity?.write(directory, identity);
            }
            return next;
        }, clock, changed);
        this.accounts = { claude: account('claude'), codex: account('codex') };
        this.connection = new Resource(async () => {
            const result = await io.connection(this.accounts.claude.value);
            if (result.error !== undefined)
                throw new Error(result.error);
            return result;
        }, clock, changed);
    }
    async poll() {
        await this.followSession();
        await Promise.all(['claude', 'codex'].map(async (id) => {
            const a = this.accounts[id];
            const fast = a.error || !a.value || a.value.kind === 'signed-out' || this.clock() < this.watchUntil[id];
            await a.refresh(fast ? 10000 : 300000);
            if (id === 'claude' && a.value && a.value.kind !== 'unavailable')
                await this.connection.refresh(10000);
            if (a.value?.kind === 'signed-in')
                await this.usage[id].refresh(id === 'claude' ? 10000 : 15000);
        }));
    }
    /** A reply from a session under another `CLAUDE_CONFIG_DIR` makes that folder's account the one shown. */
    async followSession() {
        const latest = this.sessionConfigDir;
        await latest.refresh(10000);
        const account = this.accounts.claude;
        if (latest.checkedAt === null || latest.error || !account.value || account.loading)
            return;
        if ((account.value.context?.sessionConfigDir ?? null) !== latest.value)
            account.invalidate();
    }
    async refreshAccount(id, force = false) {
        await this.accounts[id].refresh(force ? 0 : 10000);
        if (id === 'claude')
            await this.connection.refresh(force ? 0 : 10000);
    }
    watchAccount(id) {
        this.watchUntil[id] = this.clock() + 120000;
    }
    async connectionChanged() {
        this.connection.invalidate();
        await this.connection.refresh();
    }
}
/** Synchronous read-and-write: a claim is recorded before any notification. */
export function claimAlert(read, write, key) {
    const keys = read();
    if (keys.includes(key))
        return false;
    write([...keys, key].slice(-400));
    return true;
}
