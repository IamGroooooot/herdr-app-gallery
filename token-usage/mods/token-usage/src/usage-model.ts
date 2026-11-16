import type { DisplayProvider, UsageReport } from './types.js';
import type { Resource } from './resource.js';
export { periodLabel } from './providers.js';
export interface ClaudeDisplayInput {
  state: { kind: string; text?: string }; report: UsageReport | null; at: number | null; error: string | null;
}
export function usageProviders(claude: ClaudeDisplayInput, codex: Resource<UsageReport>, now = Date.now()): DisplayProvider[] {
  const messages: Record<string,string> = { loading: 'Checking…', missing: 'Not installed', signedout: 'Signed out',
    unlinked: 'Connect in settings', nolimits: 'No plan limits', waiting: 'Awaiting reply', error: "Couldn't refresh" };
  return [{
    id: 'claude', name: 'Claude', at: claude.at, error: claude.error,
    message: messages[claude.state.kind] ?? claude.state.text, detail: claude.state.text,
    windows: claude.state.kind === 'ok' ? claude.report?.windows ?? [] : [],
  }, {
    id: 'codex', name: 'Codex', at: codex.value?.reportedAt ?? null, error: codex.error,
    message: codex.error ? "Couldn't refresh" : codex.loading ? 'Checking…' : 'Awaiting reply',
    detail: "Local Codex session logs, checked every 15 seconds. After switching accounts, the previous report may remain until a new reply.",
    windows: codex.value?.windows ?? [],
  }].map(p => ({ ...p, stale: Boolean(p.at && now - p.at > 3600000) }));
}
export function commonPeriod(providers: DisplayProvider[]): string | null {
  const periods = new Set(providers.flatMap(p => p.windows.map(w => w.label)));
  return periods.size === 1 ? [...periods][0] : null;
}
export function usageValue(window: { resets: number; used: number }, now = Date.now()): string {
  return window.resets * 1000 <= now ? '--' : `${Math.round(window.used)}%`;
}
