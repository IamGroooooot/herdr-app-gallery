import type { AccountState, Connection, DisplayProvider, UsageProvider, UsageReport } from './types.js';
import type { ReadState } from './resource.js';
export { periodLabel } from './providers.js';
export interface ProviderDisplayInput {
  provider: Pick<UsageProvider, 'id' | 'name'>;
  account: ReadState<AccountState>;
  usage: ReadState<UsageReport>;
  connection?: ReadState<Connection>;
}
/** Both views derive from the same account and usage snapshots. */
export function usageProviders(inputs: readonly ProviderDisplayInput[], now = Date.now()): DisplayProvider[] {
  return inputs.map(({ provider, account, usage, connection }) => {
    const error = account.error || usage.error || connection?.error || null;
    const a = account.value;
    let status: DisplayProvider['status'] = 'ready';
    let message = '';
    if (!a) { status = error ? 'error' : 'loading'; message = error ? "Couldn't refresh" : 'Checking…'; }
    else if (a.kind === 'unavailable') { status = 'missing'; message = 'Not installed'; }
    else if (a.kind === 'signed-out') { status = 'signedout'; message = 'Signed out'; }
    else if (a.method === 'API key') { status = 'nolimits'; message = 'No plan limits'; }
    else if (connection && !connection.value) { status = error ? 'error' : 'loading'; message = error ? "Couldn't refresh" : 'Checking…'; }
    else if (connection && !connection.value?.connected) { status = 'unlinked'; message = 'Connect in settings'; }
    else if (!usage.value?.windows.length) { status = 'waiting'; message = 'Awaiting reply'; }
    const at = usage.value?.reportedAt ?? null;
    return { id: provider.id, name: provider.name, status, message, error, at,
      detail: a?.kind === 'unavailable' ? a.reason : provider.id === 'codex'
        ? 'Local session reports after replies. After switching accounts, old reports may remain until a new reply.'
        : 'Local Claude statusline reports after replies.',
      windows: status === 'ready' ? usage.value?.windows ?? [] : [],
      stale: at !== null && now - at > 3600000 };
  });
}
export function commonPeriod(providers: DisplayProvider[]): string | null {
  const periods = new Set(providers.flatMap(p => p.windows.map(w => w.label)));
  return periods.size === 1 ? [...periods][0] : null;
}
export function usageValue(window: { resets: number; used: number }, now = Date.now()): string {
  return window.resets * 1000 <= now ? '--' : `${Math.round(window.used)}%`;
}
export function remainingValue(window: { resets: number; used: number }, now = Date.now()): string {
  return window.resets * 1000 <= now ? '--' : `${Math.round(100 - window.used)}%`;
}
export function resetLabel(seconds: number, now = Date.now()): string {
  const left = seconds * 1000 - now;
  if (left <= 0) return 'Awaiting';
  if (left < 3600000) return `in ${Math.ceil(left / 60000)}m`;
  const d = new Date(seconds * 1000);
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return `${day} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
