/** Never credentials or conversation content. */
import { finite, object, parseJson } from './json.js';
import type { LogTails } from './system.js';
import type { AccountState } from './types.js';

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
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/no such file|not found|cannot find/i.test(message))
    return { kind: 'unavailable', reason: "Codex is not installed or is not on Herdr's PATH." };
  throw new Error(UNDETERMINED);
}
