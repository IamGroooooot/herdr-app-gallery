import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Herdr's exec contract, on the real programs: resolves with the exit code, rejects when it cannot start. */
export const execWith =
  (env = {}, remap = {}) =>
  (command, args = [], options = {}) =>
    new Promise((resolve, reject) => {
      const merged = { ...process.env, ...env };
      for (const key of Object.keys(merged)) if (merged[key] == null) delete merged[key];
      execFile(
        remap[command] ?? command,
        args,
        { env: merged, timeout: options.timeout, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') reject(error);
          else resolve({ code: error ? error.code : 0, stdout, stderr });
        },
      );
    });

const has = command => spawnSync(command, ['-c', 'exit 0']).status === 0;
const optional = [
  ['dash', 'linux', { '/bin/sh': '/bin/dash' }, existsSync('/bin/dash')],
  ['PowerShell', 'windows', { powershell: 'pwsh' }, has('pwsh')],
];
export const shells = [['sh', 'macos', {}], ...optional.filter(shell => shell[3])];
/** Shells whose tests did not run here: reported as skipped, so a run never passes on fewer shells unnoticed. */
export const missingShells = optional.filter(shell => !shell[3]).map(shell => shell[0]);

export function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'token usage '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A Codex usage event carrying the session's running token totals. */
export const totals = (at, input, cached, output) =>
  `${JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      rate_limits: null,
    },
  })}\n`;
export const turn = (cwd, model) =>
  `${JSON.stringify({ timestamp: '2026-11-16T00:00:00Z', type: 'turn_context', payload: { cwd, model } })}\n`;

export const event = (at, used, limits = {}) =>
  `${JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: used, window_minutes: 10080, resets_at: 2000000000 },
        ...limits,
      },
    },
  })}\n`;
