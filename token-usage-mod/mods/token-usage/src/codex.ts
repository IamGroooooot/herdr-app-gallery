/** Never credentials or conversation content. */
import { finite, object, parseJson } from './json.js';
import type { LogTails } from './system.js';

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
  error: string | null;
}

export function usageEvent(line: string): CodexSample | null {
  if (!line.includes('"token_count"')) return null;
  const event = object(parseJson(line));
  const payload = object(event?.payload);
  if (event?.type !== 'event_msg' || payload?.type !== 'token_count') return null;
  const limits = object(payload.rate_limits);
  const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) / 1000 : NaN;
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
    limit_id: typeof limits.limit_id === 'string' && limits.limit_id ? limits.limit_id : 'codex',
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

export class CodexLogs {
  private files = new Map<string, { size: number; samples: CodexSample[] }>();
  constructor(private readonly tails: (known: ReadonlyMap<string, number>) => Promise<LogTails | null>) {}

  async read(): Promise<CodexUsage> {
    const result = await this.tails(new Map([...this.files].map(([path, file]) => [path, file.size])));
    if (!result) return { samples: [], error: 'No Codex session logs found.' };
    const files = new Map<string, { size: number; samples: CodexSample[] }>();
    const latest = new Map<string, CodexSample>();
    let failures = result.failures;
    for (const tail of result.tails) {
      const samples = tail.lines ? latestSamples(tail.lines) : this.files.get(tail.path)?.samples;
      if (!samples) {
        failures++;
        continue;
      }
      files.set(tail.path, { size: tail.size, samples });
      for (const sample of samples) {
        const newest = latest.get(sample.limit_id);
        if (!newest || sample.at > newest.at) latest.set(sample.limit_id, sample);
      }
    }
    this.files = files;
    const rank = (s: CodexSample) => (s.limit_id === 'codex' ? '0' : '1') + s.limit_id;
    const samples = [...latest.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
    return { samples, error: failures ? `Could not read ${failures} session logs.` : null };
  }
}

/** CLI output may contain a key: only the sign-in method leaves this function. */
export function codexAccountStatus(code: number, output: string): Record<string, unknown> {
  const text = output.toLowerCase();
  if (code === 0 && text.includes('logged in using chatgpt')) return { loggedIn: true, method: 'ChatGPT' };
  if (code === 0 && text.includes('logged in using') && text.includes('api key'))
    return { loggedIn: true, method: 'API key' };
  if (text.includes('not logged in')) return { loggedIn: false };
  return { error: 'Could not determine Codex login status. Try codex login status in a terminal.' };
}

export function codexAccountFailure(reason: unknown): Record<string, unknown> {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/no such file|not found|cannot find/i.test(message))
    return { missing: true, error: "Codex is not installed or is not on Herdr's PATH." };
  return { error: 'Could not run codex login status. Try again.' };
}
