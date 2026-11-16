// Generated from src/runtime.ts. Edit the TS source, then run npm run verify.
import { exec, notify, playSound, setShared, shared } from 'herdr';
import { CodexLogs, codexAccountFailure, codexAccountStatus } from './codex.js';
import { auth, clearReports, configDir, connection, limits, projectsDir, system, upgrade } from './data.js';
import { createProviders } from './providers.js';
import { claimAlert, UsageStore } from './store.js';
import { resetLabel } from './usage-model.js';
let instance = null;
let revision = 0;
async function codexAccount() {
    try {
        const result = await exec('codex', ['login', 'status'], { timeout: 8000 });
        return codexAccountStatus(result.code, `${result.stdout}\n${result.stderr}`);
    }
    catch (reason) {
        return codexAccountFailure(reason);
    }
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
        const settings = { warn: 80, urgent: 95, sound: true, ...(shared('token-usage.prefs') ?? {}) };
        const report = store.usage.claude.value;
        if (report?.reportedAt && Date.now() - report.reportedAt < 3600000)
            for (const w of report.windows) {
                if (w.resets * 1000 <= Date.now() || w.used < settings.warn)
                    continue;
                const urgent = w.used >= settings.urgent;
                const key = `${store.accounts.claude.value.context?.identity ?? 'claude'}:${w.key}:${w.resets}:${urgent ? 'urgent' : 'warn'}`;
                const read = () => shared('token-usage.alerted') ?? [];
                const write = (keys) => setShared('token-usage.alerted', keys);
                if (!claimAlert(read, write, key))
                    continue;
                claimAlert(read, write, `${store.accounts.claude.value.context?.identity ?? 'claude'}:${w.key}:${w.resets}:warn`);
                notify({
                    title: `${w.label} Claude limit at ${Math.round(w.used)}%`,
                    body: `Resets ${resetLabel(w.resets)}.`,
                    level: urgent ? 'error' : 'warning',
                    timeout: 10000,
                    action: { name: 'token-usage.settings' },
                });
                if (urgent && settings.sound)
                    playSound('blocked');
            }
    }
    setShared('token-usage.revision', ++revision);
}
/** Called from init, never at module scope. */
export function usageStore() {
    if (instance)
        return instance;
    let upgradeAt = 0;
    const codexLogs = new CodexLogs(known => system.codexTails(known));
    instance = new UsageStore(createProviders({
        claudeUsage: () => limits(projectsDir(instance?.accounts.claude.value?.context ?? {})),
        claudeAccount: auth,
        codexUsage: () => codexLogs.read(),
        codexAccount,
    }), {
        connection: async (account) => {
            const dir = configDir(account?.context ?? {});
            let result = await connection(dir);
            if (result.legacy && Date.now() - upgradeAt > 300000) {
                upgradeAt = Date.now();
                await upgrade(dir);
                result = await connection(dir);
            }
            return result;
        },
        accountChanged: clearReports,
        claudeIdentity: {
            read: () => shared('token-usage.account'),
            write: identity => setShared('token-usage.account', identity),
        },
    }, Date.now, changed);
    return instance;
}
