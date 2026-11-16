import { appHome, exec, setShared, shared, notify, playSound } from 'herdr';
import { auth, limits, connection, configDir, clearReports, upgrade } from './data.js';
import { createProviders } from './providers.js';
import { resetLabel } from './usage-model.js';
import type { Prefs } from './types.js';
import { claimAlert, UsageStore } from './store.js';

let instance: UsageStore | null = null;
let revision = 0;
async function helper(file: string): Promise<unknown> {
  const args = [`${appHome()}/mods/token-usage/${file}`];
  if (file === 'read_codex_usage.py') args.push('--cache', `${appHome()}/data/token-usage/codex-cache.json`);
  const result = await exec('python3', args, { timeout: 10000 });
  if (result.code !== 0) throw new Error('Could not read local provider state.');
  return JSON.parse(result.stdout) as unknown;
}
/** Called from init, never at module scope. Reads outlive any individual view. */
function changed(): void {
  const store = instance;
  if (store && store.accounts.claude.value?.kind === 'signed-in' && !store.accounts.claude.error && !store.accounts.claude.loading
      && store.connection.value?.connected && !store.connection.error && !store.connection.loading && !store.usage.claude.error && !store.usage.claude.loading) {
    const settings = { warn: 80, urgent: 95, sound: true, ...(shared('token-usage.prefs') as Partial<Prefs> ?? {}) };
    const report = store.usage.claude.value;
    if (report?.reportedAt && Date.now() - report.reportedAt < 3600000) for (const w of report.windows) {
      if (w.resets * 1000 <= Date.now() || w.used < settings.warn) continue;
      const urgent = w.used >= settings.urgent;
      const key = `${store.accounts.claude.value.context?.identity ?? "claude"}:${w.key}:${w.resets}:${urgent ? 'urgent' : 'warn'}`;
      const read = () => shared('token-usage.alerted') as string[] ?? [];
      const write = (keys: string[]) => setShared('token-usage.alerted', keys);
      if (!claimAlert(read, write, key)) continue;
      claimAlert(read, write, `${store.accounts.claude.value.context?.identity ?? "claude"}:${w.key}:${w.resets}:warn`);
      notify({ title: `${w.label} Claude limit at ${Math.round(w.used)}%`, body: `Resets ${resetLabel(w.resets)}.`,
        level: urgent ? 'error' : 'warning', timeout: 10000, action: { name: 'token-usage.settings' } });
      if (urgent && settings.sound) playSound('blocked');
    }
  }
  setShared('token-usage.revision', ++revision);
}
export function usageStore(): UsageStore {
  if (instance) return instance;
  let upgradeAt = 0;
  instance = new UsageStore(createProviders({
    claudeUsage: limits, claudeAccount: auth,
    codexUsage: () => helper('read_codex_usage.py'), codexAccount: () => helper('read_codex_account.py'),
  }), { connection: async account => {
    const dir = configDir(account?.context ?? {});
    let result = await connection(dir);
    if (result.legacy && Date.now() - upgradeAt > 300000) {
      upgradeAt = Date.now();
      await upgrade(dir);
      result = await connection(dir);
    }
    return result;
  }, accountChanged: clearReports, claudeIdentity: {
    read: () => shared("token-usage.account") as string | null,
    write: identity => setShared("token-usage.account", identity),
  } }, Date.now, changed);
  return instance;
}
