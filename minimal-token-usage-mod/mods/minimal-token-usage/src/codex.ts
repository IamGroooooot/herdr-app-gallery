/** Never credentials or conversation content. */
import { finite, object, parseJson, text } from './json.js';
import { type LogTails, notInstalled } from './system.js';
import type { AccountState, LoggedSession } from './types.js';

export interface CodexWindow {
  key: string;
  used: number;
  minutes: number;
  resets: number;
}
export interface CodexSample {
  at: number;
  limit_id: string;
  name: string | null;
  windows: CodexWindow[];
}
export interface CodexUsage {
  samples: CodexSample[];
  sessions: LoggedSession[];
  error: string | null;
}
type SessionTotals = Omit<LoggedSession, 'path'>;

const eventOf = (line: string, type: string) => {
  if (!line.includes(`"${type}"`)) return null;
  const event = object(parseJson(line));
  const payload = object(event?.payload);
  const named = event?.type === type || (event?.type === 'event_msg' && payload?.type === type);
  return event && payload && named ? { event, payload } : null;
};

const seconds = (timestamp: unknown) => (typeof timestamp === 'string' ? Date.parse(timestamp) / 1000 : NaN);

/** A session's running totals are in its last usage event; its folder and model in its last turn context.
 *  `lines` are in log order. Codex counts cached input inside input, so the two are told apart here. */
export function sessionTotals(lines: readonly string[]): SessionTotals | null {
  let totals: Pick<SessionTotals, 'at' | 'input' | 'output' | 'cacheRead'> | null = null;
  let context: Record<string, unknown> | null = null;
  for (let i = lines.length - 1; i >= 0 && !(totals && context); i--) {
    context ??= eventOf(lines[i], 'turn_context')?.payload ?? null;
    if (totals) continue;
    const usage = eventOf(lines[i], 'token_count');
    const total = object(object(usage?.payload.info)?.total_token_usage);
    const at = seconds(usage?.event.timestamp) * 1000;
    if (!total || !finite(at)) continue;
    const tokens = (key: string) => (finite(total[key]) && total[key] > 0 ? total[key] : 0);
    const cacheRead = Math.min(tokens('cached_input_tokens'), tokens('input_tokens'));
    totals = { at, cacheRead, input: tokens('input_tokens') - cacheRead, output: tokens('output_tokens') };
  }
  if (!totals) return null;
  return {
    ...totals,
    folder: text(context?.cwd) ?? null,
    model: text(context?.model) ?? null,
  };
}

export function usageEvent(line: string): CodexSample | null {
  const usage = eventOf(line, 'token_count');
  const limits = object(usage?.payload.rate_limits);
  const at = seconds(usage?.event.timestamp);
  if (!limits || !finite(at)) return null;
  const windows: CodexWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = object(limits[key]);
    if (!w) continue;
    const { used_percent: used, window_minutes: minutes, resets_at: resets } = w;
    if (!finite(used) || !finite(minutes) || !finite(resets)) continue;
    if (used < 0 || used > 100 || minutes <= 0 || resets <= 0) continue;
    windows.push({ key, used, minutes, resets });
  }
  if (!windows.length) return null;
  return {
    at,
    windows,
    limit_id: text(limits.limit_id) ?? 'codex',
    name: typeof limits.limit_name === 'string' ? limits.limit_name : null,
  };
}

/** `lines` are in log order. */
export function latestSamples(lines: readonly string[]): CodexSample[] {
  const byLimit = new Map<string, CodexSample>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const sample = usageEvent(lines[i]);
    if (sample && !byLimit.has(sample.limit_id)) byLimit.set(sample.limit_id, sample);
  }
  return [...byLimit.values()];
}

interface LogFile {
  size: number;
  samples: CodexSample[];
  session: SessionTotals | null;
}
export class CodexLogs {
  private files = new Map<string, LogFile>();
  constructor(private readonly tails: (known: ReadonlyMap<string, number>) => Promise<LogTails | null>) {}

  async read(): Promise<CodexUsage> {
    const result = await this.tails(new Map([...this.files].map(([path, file]) => [path, file.size])));
    if (!result) return { samples: [], sessions: [], error: 'No Codex session logs found.' };
    const files = new Map<string, LogFile>();
    const latest = new Map<string, CodexSample>();
    let failures = result.failures;
    for (const tail of result.tails) {
      const file = tail.lines
        ? { size: tail.size, samples: latestSamples(tail.lines), session: sessionTotals(tail.lines) }
        : this.files.get(tail.path);
      if (!file) {
        failures++;
        continue;
      }
      files.set(tail.path, file);
      for (const sample of file.samples) {
        const newest = latest.get(sample.limit_id);
        if (!newest || sample.at > newest.at) latest.set(sample.limit_id, sample);
      }
    }
    this.files = files;
    const rank = (s: CodexSample) => (s.limit_id === 'codex' ? '0' : '1') + s.limit_id;
    const samples = [...latest.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
    const sessions = [...files]
      .flatMap(([path, file]) => (file.session ? [{ path, ...file.session }] : []))
      .sort((a, b) => b.at - a.at);
    return { samples, sessions, error: failures ? `Could not read ${failures} session logs.` : null };
  }
}

const UNDETERMINED = 'Could not check Codex sign-in. Run codex login status in a terminal.';

/** CLI output may contain a key: only the sign-in method leaves this function. */
export function codexAccountStatus(code: number, output: string): AccountState {
  const text = output.toLowerCase();
  if (code === 0 && text.includes('logged in using chatgpt')) return { kind: 'signed-in', method: 'ChatGPT' };
  if (code === 0 && text.includes('logged in using') && text.includes('api key'))
    return { kind: 'signed-in', method: 'API key' };
  if (text.includes('not logged in')) return { kind: 'signed-out' };
  throw new Error(UNDETERMINED);
}

export function codexAccountFailure(reason: unknown): AccountState {
  if (notInstalled(reason)) return { kind: 'unavailable', reason: "Codex is not installed or is not on Herdr's PATH." };
  throw new Error(UNDETERMINED);
}
