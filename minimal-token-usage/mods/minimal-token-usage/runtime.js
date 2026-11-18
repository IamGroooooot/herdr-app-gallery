// Generated from src/runtime.ts. Edit the TS source, then run npm run verify.
import { notify, playSound, setShared, shared } from 'herdr';
import { CodexLogs, codexAccountFailure, codexAccountStatus } from './codex.js';
import { auth, clearReports, configDir, connection, lastSessionConfigDir, limits, projectsDir, system, } from './data.js';
import { object } from './json.js';
import { createProviders } from './providers.js';
import { claimAlert, UsageStore } from './store.js';
import { PREFS_KEY, readPrefs, resetLabel } from './usage-model.js';
const IDENTITIES = 'minimal-token-usage.accounts';
let instance = null;
let revision = 0;
async function codexAccount() {
    let result;
    try {
        result = await system.cli('codex', ['login', 'status'], { timeout: 8000 });
    }
    catch (reason) {
        return codexAccountFailure(reason);
    }
    return codexAccountStatus(result.code, `${result.stdout}\n${result.stderr}`);
}
function changed() {
    const store = instance;
    if (store &&
        store.accounts.claude.value?.kind === 'signed-in' &&
        !store.accounts.claude.error &&
        !store.accounts.claude.loading &&
        store.connection.value?.connected &&
        !store.connection.error &&
        !store.connection.loading &&
        !store.usage.claude.error &&
        !store.usage.claude.loading) {
        const settings = readPrefs(shared(PREFS_KEY));
        const report = store.usage.claude.value;
        if (report?.reportedAt && Date.now() - report.reportedAt < 3600000)
            for (const w of report.windows) {
                if (w.resets * 1000 <= Date.now() || w.used < settings.warn)
                    continue;
                const urgent = w.used >= settings.urgent;
                const window = `${store.accounts.claude.value.context?.identity ?? 'claude'}:${w.key}:${w.resets}`;
                const read = () => shared('minimal-token-usage.alerted') ?? [];
                const write = (keys) => setShared('minimal-token-usage.alerted', keys);
                if (!claimAlert(read, write, `${window}:${urgent ? 'urgent' : 'warn'}`))
                    continue;
                claimAlert(read, write, `${window}:warn`);
                notify({
                    title: `${w.label} Claude limit at ${Math.round(w.used)}%`,
                    body: `Resets ${resetLabel(w.resets)}.`,
                    level: urgent ? 'error' : 'warning',
                    timeout: 10000,
                    action: { name: 'minimal-token-usage.settings' },
                });
                if (urgent && settings.sound)
                    playSound('blocked');
            }
    }
    setShared('minimal-token-usage.revision', ++revision);
}
/** Called from init, never at module scope. */
export function usageStore() {
    if (instance)
        return instance;
    const codexLogs = new CodexLogs(known => system.codexTails(known));
    instance = new UsageStore(createProviders({
        claudeUsage: () => limits(projectsDir(instance?.accounts.claude.value?.context ?? {})),
        claudeAccount: auth,
        codexUsage: () => codexLogs.read(),
        codexAccount,
    }), {
        connection: account => connection(configDir(account?.context ?? {})),
        accountChanged: clearReports,
        sessionConfigDir: lastSessionConfigDir,
        claudeIdentity: {
            read: directory => {
                const identity = object(shared(IDENTITIES))?.[directory];
                return typeof identity === 'string' ? identity : null;
            },
            write: (directory, identity) => setShared(IDENTITIES, { ...object(shared(IDENTITIES)), [directory]: identity }),
        },
    }, Date.now, changed);
    return instance;
}
