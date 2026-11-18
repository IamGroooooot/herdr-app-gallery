import { finite, object } from './json.js';
import type { ReadState } from './resource.js';
import type {
  AccountState,
  Connection,
  DisplayProvider,
  LoggedSession,
  Prefs,
  UsageProvider,
  UsageReport,
} from './types.js';

export interface ProviderDisplayInput {
  provider: Pick<UsageProvider, 'id' | 'name'>;
  account: ReadState<AccountState>;
  usage: ReadState<UsageReport>;
  connection?: ReadState<Connection>;
}
export function usageProviders(inputs: readonly ProviderDisplayInput[], now = Date.now()): DisplayProvider[] {
  return inputs.map(({ provider, account, usage, connection }) => {
    const error = account.error || usage.error || connection?.error || null;
    const a = account.value;
    let status: DisplayProvider['status'] = 'ready';
    let message = '';
    if (!a) {
      status = error ? 'error' : 'loading';
      message = error ? "Couldn't refresh" : 'Checking…';
    } else if (a.kind === 'unavailable') {
      status = 'missing';
      message = 'Not installed';
    } else if (a.kind === 'signed-out') {
      status = 'signedout';
      message = 'Signed out';
    } else if (a.method === 'API key') {
      status = 'nolimits';
      message = 'No plan limits';
    } else if (connection && !connection.value) {
      status = error ? 'error' : 'loading';
      message = error ? "Couldn't refresh" : 'Checking…';
    } else if (connection && !connection.value?.connected) {
      status = 'unlinked';
      message = 'Signed in · connect for limits';
    } else if (!usage.value?.windows.length) {
      status = 'waiting';
      message = 'Send a message to see usage';
    }
    const at = usage.value?.reportedAt ?? null;
    return {
      id: provider.id,
      name: provider.name,
      status,
      message,
      error,
      at,
      detail:
        a?.kind === 'unavailable'
          ? a.reason
          : provider.id === 'codex'
            ? 'Local session reports after replies. After switching accounts, old reports may remain until a new reply.'
            : 'Local Claude statusline reports after replies.',
      windows: status === 'ready' ? (usage.value?.windows ?? []) : [],
      stale: at !== null && now - at > 3600000,
    };
  });
}
/** A session in a log is listed for a day after it last used tokens. */
const LISTED_FOR = 86400000;
export const recentSessions = (sessions: readonly LoggedSession[] | undefined, now = Date.now()): LoggedSession[] =>
  (sessions ?? []).filter(s => now - s.at < LISTED_FOR);
/** The last part of a path, POSIX or Windows. */
export const folderName = (path: string | null): string => path?.split(/[\\/]/).filter(Boolean).pop() ?? '';
export type StripStyle = 'gauge' | 'segments' | 'meter';
export const STRIP_STYLES: readonly { id: StripStyle; label: string }[] = [
  { id: 'gauge', label: 'Gauge line' },
  { id: 'segments', label: 'Segments' },
  { id: 'meter', label: 'Meter pill' },
];
export const stripStyle = (value: unknown): StripStyle => STRIP_STYLES.find(s => s.id === value)?.id ?? 'gauge';
export function ownColors(
  all: readonly { name: string; colors: Record<string, string> }[],
  name: string | null,
): Record<string, string> | null {
  return (name && all.find(theme => theme.name === name)?.colors) || null;
}

export const PREFS_KEY = 'minimal-token-usage.prefs';
/** `saved` is whatever Herdr's shared state holds; anything that is not a valid choice takes its default. */
export function readPrefs(saved: unknown): Prefs {
  const s = object(saved) ?? {};
  const percent = (value: unknown, fallback: number) =>
    finite(value) && value >= 0 && value <= 100 ? value : fallback;
  return {
    warn: percent(s.warn, 80),
    urgent: percent(s.urgent, 95),
    sound: typeof s.sound === 'boolean' ? s.sound : true,
    style: stripStyle(s.style),
    theme: typeof s.theme === 'string' ? s.theme : null,
  };
}
/** Strip geometry in px. The strip asks its layout block for the height its rows need, plus
 *  `slack` so that rounding or a block border never leaves a pixel to scroll.
 *  A stacked row (gauge, segments) is a text `line`, `lineGap`, then the `bar`. */
export const STRIP = {
  header: 18,
  gap: 6,
  row: 22,
  noted: 32,
  message: 26,
  meter: 14,
  line: 16,
  lineGap: 4,
  bar: 6,
  stacked: 26,
  pad: 8,
  slack: 6,
  min: 92,
  max: 180,
};
export const rowNote = (p: DisplayProvider): string | null => (p.error ? 'Error' : p.stale ? 'Stale' : null);
function stripContent(providers: readonly DisplayProvider[], style: StripStyle): number {
  const row = (p: DisplayProvider, i: number) =>
    style !== 'meter' ? STRIP.stacked : i === 0 && rowNote(p) ? STRIP.noted : STRIP.row;
  const rows = providers.flatMap(p => (p.windows.length ? p.windows.map((_, i) => row(p, i)) : [STRIP.message]));
  return STRIP.header + rows.reduce((sum, height) => sum + STRIP.gap + height, 0) + STRIP.pad + STRIP.slack;
}
export const stripHeight = (providers: readonly DisplayProvider[], style: StripStyle): number =>
  Math.max(STRIP.min, Math.min(STRIP.max, stripContent(providers, style)));
export const stripOverflows = (providers: readonly DisplayProvider[], style: StripStyle): boolean =>
  stripContent(providers, style) > STRIP.max;
export function periodWidth(providers: readonly DisplayProvider[], limit: number): number {
  const labels = providers.flatMap(p => p.windows.map(w => w.label));
  return commonPeriod(providers) || !labels.length
    ? 0
    : Math.min(limit, Math.max(...labels.map(l => l.length)) * 8 + 4);
}
export function commonPeriod(providers: readonly DisplayProvider[]): string | null {
  const periods = new Set(providers.flatMap(p => p.windows.map(w => w.label)));
  return periods.size === 1 ? [...periods][0] : null;
}
export function usageValue(window: { resets: number; used: number }, now = Date.now()): string {
  return window.resets * 1000 <= now ? '--' : `${Math.round(window.used)}%`;
}
/** Percent of the window still available, 0 once it has reset and no new report has come. */
export function remainingPercent(window: { resets: number; used: number }, now = Date.now()): number {
  return window.resets * 1000 <= now ? 0 : Math.max(0, Math.min(100, 100 - window.used));
}
export function litSegments(percent: number, blocks = 10): number {
  return percent <= 0 ? 0 : Math.max(1, Math.round((percent / 100) * blocks));
}
export function remainingValue(window: { resets: number; used: number }, now = Date.now()): string {
  return window.resets * 1000 <= now ? '--' : `${Math.round(100 - window.used)}%`;
}
export function resetLabel(seconds: number, now = Date.now()): string {
  const left = seconds * 1000 - now;
  if (left <= 0) return 'Awaiting';
  if (left < 3600000) return `in ${Math.ceil(left / 60000)}m`;
  const d = new Date(seconds * 1000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
