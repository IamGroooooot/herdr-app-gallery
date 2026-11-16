// Generated from src/system.ts. Edit the TS source, then run npm run verify.
const TIMEOUT = { timeout: 10000 };
const DAYS = 8;
const LOGS = 24;
const TAIL_BYTES = 2 * 1024 * 1024;
const TAIL_LINES = 32;
// `dd` seeks; whether `tail -c +N` does depends on the implementation. `dd` skips whole
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
const CODEX_TAILS = [
    'cd "${CODEX_HOME:-$HOME/.codex}/sessions" 2>/dev/null || exit 3',
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
    `  dd if="$f" bs=${BLOCK} skip="$skip" 2>/dev/null | LC_ALL=C grep -F '"token_count"' | LC_ALL=C grep '^{' | tail -n ${TAIL_LINES}`,
    'done',
    'exit 0',
].join('\n');
/** The POSIX scripts, for scripts/lint.mjs to hand to shellcheck. */
export const POSIX_SCRIPTS = { READ, LINE_END, CODEX_TAILS };
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
    "$known=[string]($args[0]); $needle=[char]34+'token_count'+[char]34;",
    'function Sub($d){Get-ChildItem -LiteralPath $d.FullName -Directory};',
    `$days=@(Get-ChildItem -LiteralPath $r -Directory | ForEach-Object {Sub $_} | ForEach-Object {Sub $_} | Sort-Object FullName -Descending | Select-Object -First ${DAYS});`,
    `$files=@($days | ForEach-Object {Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.jsonl'} | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First ${LOGS});`,
    "foreach($f in $files){$p=$f.FullName; try{$s=Open $p}catch{W('@fail '+$p+[char]10);continue};",
    "  $size=$s.Length; if($known.Contains('|'+$size+' '+$p+'|')){$s.Dispose();W('@same '+$size+' '+$p+[char]10);continue};",
    `  $n=[Math]::Min($size,${TAIL_BYTES}); [void]$s.Seek(-$n,[IO.SeekOrigin]::End); $b=Take $s $n; $s.Dispose();`,
    "  W('@file '+$size+' '+$p+[char]10);",
    `  [Text.Encoding]::UTF8.GetString($b).Split([char]10) | Where-Object {$_.StartsWith('{') -and $_.Contains($needle)} | Select-Object -Last ${TAIL_LINES} | ForEach-Object {W($_.TrimEnd([char]13)+[char]10)}}`,
].join(' ');
const PS_CLAUDE_CONFIG_DIR = "$v=[Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR'); if($v){W($v)}";
export function parseSizes(stdout, files) {
    const out = new Map();
    for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\r?$/.exec(line);
        if (m && files.includes(m[2]))
            out.set(m[2], Number(m[1]));
    }
    return out;
}
export function parseChunk(stdout) {
    const cut = stdout.indexOf('\n');
    if (cut < 1 || !/^\d+$/.test(stdout.slice(0, cut)))
        return null;
    return { size: Number(stdout.slice(0, cut)), body: stdout.slice(cut + 1) };
}
export function parseTails(stdout) {
    const tails = [];
    let failures = 0;
    let lines = null;
    for (const line of stdout.split('\n')) {
        const m = /^@(file|same) (\d+) (.+)$/.exec(line);
        if (m) {
            lines = m[1] === 'file' ? [] : null;
            tails.push({ path: m[3], size: Number(m[2]), lines });
        }
        else if (line.startsWith('@fail ')) {
            failures++;
            lines = null;
        }
        else if (line && lines)
            lines.push(line);
    }
    return { tails, failures };
}
const knownText = (known) => `|${[...known].map(([path, size]) => `${size} ${path}`).join('|')}|`;
const isWindows = (platform) => /^win/i.test(platform);
export function createSystem(exec, platform) {
    const psq = (s) => `'${s.replace(/'/g, "''")}'`;
    const sh = (script, args = []) => exec('/bin/sh', ['-c', script, 'sh', ...args], TIMEOUT);
    const ps = (script, args = []) => exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', `& { ${PS_PRELUDE} ${script} } ${args.map(psq).join(' ')}`], TIMEOUT);
    const windows = isWindows(platform);
    const run = (posix, win, args = []) => (windows ? ps(win, args) : sh(posix, args));
    return {
        async sizes(files) {
            if (!files.length)
                return new Map();
            const r = await (windows ? ps(PS_SIZES, files) : exec('wc', ['-c', '--', ...files], TIMEOUT)).catch(() => null);
            return parseSizes(r?.stdout ?? '', files);
        },
        async readChunk(file, offset, max) {
            const r = await run(READ, PS_READ, [file, String(offset), String(max)]).catch(() => null);
            return r && r.code === 0 ? parseChunk(r.stdout) : null;
        },
        async lineLength(file, offset) {
            const r = await run(LINE_END, PS_LINE_END, [file, String(offset)]).catch(() => null);
            const n = r?.code === 0 ? Number(r.stdout.trim()) : 0;
            return Number.isInteger(n) && n > 0 ? n : 0;
        },
        async codexTails(known) {
            const r = await run(CODEX_TAILS, PS_CODEX_TAILS, [knownText(known)]);
            if (r.code === 3)
                return null;
            if (r.code !== 0)
                throw new Error('Could not read Codex session logs.');
            return parseTails(r.stdout);
        },
        async claudeConfigDir() {
            const r = await run('printf %s "$CLAUDE_CONFIG_DIR"', PS_CLAUDE_CONFIG_DIR).catch(() => null);
            return r?.code === 0 && r.stdout ? r.stdout : null;
        },
        async restrict(dir) {
            if (!windows)
                await exec('chmod', ['700', dir], TIMEOUT).catch(() => null);
        },
    };
}
