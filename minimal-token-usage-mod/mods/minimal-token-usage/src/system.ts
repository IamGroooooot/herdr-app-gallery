/**
 * Herdr's mod runtime reads whole files only: no size, byte range, modification order or
 * environment. Each of those is one short system command here, and nowhere else:
 * POSIX sh with standard utilities, or PowerShell on Windows. Parsing stays in the mod.
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (command: string, args?: string[], options?: { timeout?: number }) => Promise<ExecResult>;
export interface Chunk {
  size: number;
  body: string;
}
/** `lines` is null when the log still has the size the caller already knows. */
export interface LogTail {
  path: string;
  size: number;
  lines: string[] | null;
}
export interface LogTails {
  tails: LogTail[];
  failures: number;
}
export interface System {
  sizes(files: string[]): Promise<Map<string, number>>;
  /** The file's size and up to `max` bytes from `offset`; null when it can't be read. */
  readChunk(file: string, offset: number, max: number): Promise<Chunk | null>;
  /** Bytes in the line starting at `offset`, newline included; 0 while it is incomplete. */
  lineLength(file: string, offset: number): Promise<number>;
  /** From the newest Codex session logs, each one's last turn context and usage lines; null when Codex has no sessions folder. */
  codexTails(known: ReadonlyMap<string, number>): Promise<LogTails | null>;
  claudeConfigDir(): Promise<string | null>;
  restrict(dir: string): Promise<void>;
  /** Runs a provider's CLI: the one Herdr finds, or else the one in the newest Node version under nvm. Rejects when there is none. */
  /** `env` is a variable the CLI runs with. */
  cli(name: string, args: string[], options?: { timeout?: number; env?: EnvVar }): Promise<ExecResult>;
  /** The command line that runs `argv` with `env` set, for a terminal tab. */
  withEnv(argv: string[], env?: EnvVar): string[];
}
export type EnvVar = readonly [name: string, value: string];

const TIMEOUT = { timeout: 10000 };
const DAYS = 8;
const LOGS = 24;
const TAIL_BYTES = 2 * 1024 * 1024;
const TAIL_LINES = 32;

// `dd` seeks; busybox `tail -c +N` reads the file from its start. `dd` skips whole
// blocks, so `from` seeks to the block holding the byte offset and drops the bytes before it.
const BLOCK = 65536;
const FROM = `from() { dd if="$1" bs=${BLOCK} skip="$(($2 / ${BLOCK}))" 2>/dev/null | tail -c +"$(($2 % ${BLOCK} + 1))"; }`;

const READ = [
  FROM,
  '[ -r "$1" ] || exit 3',
  'size="$(wc -c < "$1" | tr -d " ")" || exit 3',
  '[ -n "$size" ] || exit 3',
  'printf "%s\\n" "$size"',
  'from "$1" "$2" | head -c "$3"',
].join('\n');

const LINE_END = [
  FROM,
  'n="$(from "$1" "$2" | head -n 1 | wc -c | tr -d " ")" || exit 3',
  '[ -n "$n" ] && [ "$n" -gt 0 ] || exit 3',
  '[ "$(from "$1" "$(($2 + n - 1))" | head -c 1 | wc -l | tr -d " ")" = 1 ] || exit 4',
  'printf "%s\\n" "$n"',
].join('\n');

// Rollouts are append-only, so an unchanged size means unchanged usage. Only usage events
// leave the script; a tail cut mid-line cannot pass for one, because events start with "{".
// One `ls` gives both the newest-first order and the sizes, so an idle poll costs three processes.
// The newest `turn_context` names the session's folder and model; it comes first.
const CODEX_TAILS = [
  'cd "${CODEX_HOME:-$HOME/.codex}/sessions" 2>/dev/null || exit 3',
  `events() { dd if="$1" bs=${BLOCK} skip="$2" 2>/dev/null | LC_ALL=C grep -F "\\"$3\\"" | LC_ALL=C grep '^{'; }`,
  'known="$1"',
  'set -- [0-9]*/[0-9]*/[0-9]*/',
  `[ "$#" -le ${DAYS} ] || shift "$(($# - ${DAYS}))"`,
  'days="$*"',
  'set --',
  'for d in $days; do for f in "$d"*.jsonl; do [ -f "$f" ] && set -- "$@" "$f"; done; done',
  '[ "$#" -gt 0 ] || exit 0',
  `newest="$(LC_ALL=C ls -lnt "$@" 2>/dev/null | head -n ${LOGS})"`,
  '[ -n "$newest" ] || exit 4',
  `printf '%s\\n' "$newest" | while read -r _ _ _ _ size _ _ _ f; do`,
  `  case "$size" in ''|*[!0-9]*) printf '@fail %s\\n' "$f"; continue ;; esac`,
  `  case "$known" in *"|$size $f|"*) printf '@same %s %s\\n' "$size" "$f"; continue ;; esac`,
  `  printf '@file %s %s\\n' "$size" "$f"`,
  '  skip=0',
  `  [ "$size" -le ${TAIL_BYTES} ] || skip="$(((size - ${TAIL_BYTES}) / ${BLOCK}))"`,
  `  events "$f" "$skip" turn_context | tail -n 1`,
  `  events "$f" "$skip" token_count | tail -n ${TAIL_LINES}`,
  'done',
  'exit 0',
].join('\n');

// Herdr runs commands with the login shell's PATH. nvm adds its folder in the interactive shell
// only, so a CLI installed with npm under nvm is on disk but not on that PATH. No shell profile is run to find it.
const NODE_BINS = [
  'for root in "${NVM_DIR:-$HOME/.nvm}" "${XDG_CONFIG_HOME:-$HOME/.config}/nvm"; do',
  '  for f in "$root"/versions/node/*/bin/"$1"; do',
  `    if [ -x "$f" ]; then printf '%s\\n' "\${f%/*}"; fi`,
  '  done',
  'done',
  'exit 0',
].join('\n');

// Such a CLI is a Node script (`#!/usr/bin/env node`): its folder goes first on PATH so it runs with its own node.
const RUN_IN = 'PATH="$1:$PATH"; export PATH; program="$1/$2"; shift 2; exec "$program" "$@"';

// Herdr's exec cannot set a variable for the program it runs, so a shell sets it. `$1` is `NAME=value`.
const IN_ENV = 'export "${1?}"; shift; ';
const RUN = 'exec "$@"';
/** What a shell answers when the program is not there. */
const NOT_FOUND = 127;

/** The POSIX scripts, for scripts/lint.mjs to hand to shellcheck. */
export const POSIX_SCRIPTS = { READ, LINE_END, CODEX_TAILS, NODE_BINS, RUN_IN, IN_ENV: IN_ENV + RUN };

// No double quotes in the PowerShell text: they would need escaping on a Windows command line.
// Output is written as UTF-8 bytes because Windows PowerShell encodes strings with the console code page.
const PS_PRELUDE = [
  "$ErrorActionPreference='Stop';",
  '$o=[Console]::OpenStandardOutput();',
  'function W($s){$b=[Text.Encoding]::UTF8.GetBytes([string]$s);$o.Write($b,0,$b.Length)};',
  'function Open($p){[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)};',
  'function Take($s,$n){$b=New-Object byte[] ([int]$n);$g=0;while($g -lt $b.Length){$k=$s.Read($b,$g,$b.Length-$g);if($k -le 0){break};$g+=$k};',
  '  if($g -lt $b.Length){[Array]::Resize([ref]$b,$g)};,$b};',
].join(' ');

const PS_SIZES = "foreach($p in $args){try{$i=Get-Item -LiteralPath $p -Force;W(''+$i.Length+' '+$p+[char]10)}catch{}}";

const PS_READ = [
  'try{$s=Open $args[0]}catch{exit 3};',
  "$size=$s.Length; $off=[long]($args[1]); W(''+$size+[char]10);",
  'if($off -lt $size){[void]$s.Seek($off,[IO.SeekOrigin]::Begin);$b=Take $s ([Math]::Min($size-$off,[long]($args[2])));$o.Write($b,0,$b.Length)};',
  '$s.Dispose()',
].join(' ');

const PS_LINE_END = [
  'try{$s=Open $args[0]}catch{exit 3};',
  '[void]$s.Seek([long]($args[1]),[IO.SeekOrigin]::Begin); $b=New-Object byte[] 65536; $n=0; $hit=$false;',
  'while(($k=$s.Read($b,0,$b.Length)) -gt 0){$i=[Array]::IndexOf($b,[byte]10,0,$k);if($i -ge 0){$n+=$i+1;$hit=$true;break};$n+=$k};',
  "$s.Dispose(); if(-not $hit){exit 4}; W(''+$n+[char]10)",
].join(' ');

const PS_CODEX_TAILS = [
  "$r=$env:CODEX_HOME; if(-not $r){$r=Join-Path $HOME '.codex'}; $r=Join-Path $r 'sessions';",
  'if(-not (Test-Path -LiteralPath $r -PathType Container)){exit 3};',
  "$known=[string]($args[0]); $needle=[char]34+'token_count'+[char]34; $context=[char]34+'turn_context'+[char]34;",
  'function Sub($d){Get-ChildItem -LiteralPath $d.FullName -Directory};',
  `$days=@(Get-ChildItem -LiteralPath $r -Directory | ForEach-Object {Sub $_} | ForEach-Object {Sub $_} | Sort-Object FullName -Descending | Select-Object -First ${DAYS});`,
  `$files=@($days | ForEach-Object {Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.jsonl'} | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First ${LOGS});`,
  "foreach($f in $files){$p=$f.FullName; try{$s=Open $p}catch{W('@fail '+$p+[char]10);continue};",
  "  $size=$s.Length; if($known.Contains('|'+$size+' '+$p+'|')){$s.Dispose();W('@same '+$size+' '+$p+[char]10);continue};",
  `  $n=[Math]::Min($size,${TAIL_BYTES}); [void]$s.Seek(-$n,[IO.SeekOrigin]::End); $b=Take $s $n; $s.Dispose();`,
  "  W('@file '+$size+' '+$p+[char]10);",
  "  $l=@([Text.Encoding]::UTF8.GetString($b).Split([char]10) | Where-Object {$_.StartsWith('{')});",
  `  @($l | Where-Object {$_.Contains($context)} | Select-Object -Last 1)+@($l | Where-Object {$_.Contains($needle)} | Select-Object -Last ${TAIL_LINES}) | ForEach-Object {W($_.TrimEnd([char]13)+[char]10)}}`,
].join(' ');

const PS_IN_ENV = [
  "$pair=([string]$args[0]).Split([char]61,2); Set-Item -LiteralPath ('Env:'+$pair[0]) -Value $pair[1];",
  '$rest=@($args | Select-Object -Skip 2);',
  `try{& $args[1] @rest}catch [System.Management.Automation.CommandNotFoundException]{exit ${NOT_FOUND}};`,
  'exit $LASTEXITCODE',
].join(' ');
const PS_CLAUDE_CONFIG_DIR = "$v=[Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR'); if($v){W($v)}";

function parseSizes(stdout: string, files: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\r?$/.exec(line);
    if (m && files.includes(m[2])) out.set(m[2], Number(m[1]));
  }
  return out;
}

function parseChunk(stdout: string): Chunk | null {
  const cut = stdout.indexOf('\n');
  if (cut < 1 || !/^\d+$/.test(stdout.slice(0, cut))) return null;
  return { size: Number(stdout.slice(0, cut)), body: stdout.slice(cut + 1) };
}

function parseTails(stdout: string): LogTails {
  const tails: LogTail[] = [];
  let failures = 0;
  let lines: string[] | null = null;
  for (const line of stdout.split('\n')) {
    const m = /^@(file|same) (\d+) (.+)$/.exec(line);
    if (m) {
      lines = m[1] === 'file' ? [] : null;
      tails.push({ path: m[3], size: Number(m[2]), lines });
    } else if (line.startsWith('@fail ')) {
      failures++;
      lines = null;
    } else if (line && lines) lines.push(line);
  }
  return { tails, failures };
}

/** Whether an exec rejection says the program is not there, rather than that it was slow or refused. */
export function notInstalled(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /no such file|not found|cannot find|ENOENT/i.test(message);
}

/** Version order, not text order: v10 is newer than v9. */
function newestNodeBin(dirs: readonly string[]): string | null {
  const versioned = dirs.flatMap(dir => {
    const m = /\/v(\d+)\.(\d+)\.(\d+)\/bin$/.exec(dir);
    return m ? [{ dir, v: m.slice(1).map(Number) }] : [];
  });
  versioned.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return versioned[0]?.dir ?? null;
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psCommand = (script: string, args: string[]) => `& { ${PS_PRELUDE} ${script} } ${args.map(psq).join(' ')}`;
const knownText = (known: ReadonlyMap<string, number>) =>
  `|${[...known].map(([path, size]) => `${size} ${path}`).join('|')}|`;
const isWindows = (platform: string) => /^win/i.test(platform);

export function createSystem(exec: Exec, platform: string): System {
  const sh = (script: string, args: string[] = []) => exec('/bin/sh', ['-c', script, 'sh', ...args], TIMEOUT);
  const ps = (script: string, args: string[] = []) =>
    exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand(script, args)], TIMEOUT);
  const windows = isWindows(platform);
  const run = (posix: string, win: string, args: string[] = []) => (windows ? ps(win, args) : sh(posix, args));

  return {
    async sizes(files) {
      if (!files.length) return new Map();
      const r = await (windows ? ps(PS_SIZES, files) : exec('wc', ['-c', '--', ...files], TIMEOUT)).catch(
        (): null => null,
      );
      return parseSizes(r?.stdout ?? '', files);
    },
    async readChunk(file, offset, max) {
      const r = await run(READ, PS_READ, [file, String(offset), String(max)]).catch((): null => null);
      return r && r.code === 0 ? parseChunk(r.stdout) : null;
    },
    async lineLength(file, offset) {
      const r = await run(LINE_END, PS_LINE_END, [file, String(offset)]).catch((): null => null);
      const n = r?.code === 0 ? Number(r.stdout.trim()) : 0;
      return Number.isInteger(n) && n > 0 ? n : 0;
    },
    async codexTails(known) {
      const r = await run(CODEX_TAILS, PS_CODEX_TAILS, [knownText(known)]);
      if (r.code === 3) return null;
      if (r.code !== 0) throw new Error('Could not read Codex session logs.');
      return parseTails(r.stdout);
    },
    async claudeConfigDir() {
      const r = await run('printf %s "$CLAUDE_CONFIG_DIR"', PS_CLAUDE_CONFIG_DIR).catch((): null => null);
      return r?.code === 0 && r.stdout ? r.stdout : null;
    },
    async restrict(dir) {
      if (!windows) await exec('chmod', ['700', dir], TIMEOUT).catch((): null => null);
    },
    async cli(name, args, options) {
      const { env, ...rest } = options ?? {};
      const pair = env ? [`${env[0]}=${env[1]}`] : [];
      const posix = (script: string, argv: string[]) =>
        exec('/bin/sh', ['-c', (env ? IN_ENV : '') + script, 'sh', ...pair, ...argv], rest);
      try {
        if (!env) return await exec(name, args, rest);
        const r = await (windows
          ? exec(
              'powershell',
              ['-NoProfile', '-NonInteractive', '-Command', psCommand(PS_IN_ENV, [...pair, name, ...args])],
              rest,
            )
          : posix(RUN, [name, ...args]));
        if (r.code !== NOT_FOUND) return r;
        throw new Error(`ENOENT: ${name} not found`);
      } catch (reason) {
        // A CLI Herdr did find but that was slow or refused is not looked for elsewhere.
        if (!notInstalled(reason)) throw reason;
        const found = windows ? null : await sh(NODE_BINS, [name]).catch((): null => null);
        const dir = newestNodeBin((found?.stdout ?? '').split('\n'));
        if (!dir) throw reason;
        return posix(RUN_IN, [dir, name, ...args]);
      }
    },
    withEnv(argv, env) {
      if (!env) return argv;
      const pair = `${env[0]}=${env[1]}`;
      return windows
        ? ['powershell', '-NoProfile', '-Command', psCommand(PS_IN_ENV, [pair, ...argv])]
        : ['/usr/bin/env', pair, ...argv];
    },
  };
}
