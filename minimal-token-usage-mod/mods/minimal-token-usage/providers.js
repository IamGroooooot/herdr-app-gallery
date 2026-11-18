// Generated from src/providers.ts. Edit the TS source, then run npm run verify.
import { CLAUDE_WINDOWS } from './reports.js';
export function periodLabel(minutes) {
    if (minutes === 10080)
        return 'Week';
    if (minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}
export function codexReport(usage) {
    if (usage.error)
        throw new Error(usage.error);
    const windows = usage.samples.flatMap(sample => sample.windows.map(w => {
        const period = periodLabel(w.minutes);
        const named = sample.limit_id !== 'codex';
        return {
            used: w.used,
            resets: w.resets,
            key: `${sample.limit_id}:${w.key}`,
            label: named ? `${sample.name ?? sample.limit_id} · ${period}` : period,
        };
    }));
    const reportedAt = usage.samples.length ? Math.max(...usage.samples.map(sample => sample.at * 1000)) : null;
    return { windows, reportedAt, sessions: new Map() };
}
export function createProviders(source) {
    return {
        claude: {
            id: 'claude',
            name: 'Claude',
            login: { name: 'Claude login', argv: ['claude', 'auth', 'login'] },
            logout: { name: 'Claude logout', argv: ['claude', 'auth', 'logout'] },
            async readUsage() {
                const r = await source.claudeUsage();
                const windows = Object.entries(r.windows).map(([key, w]) => ({ ...w, key, label: CLAUDE_WINDOWS[key] ?? key }));
                return { windows, reportedAt: r.reportedAt, sessions: r.sessions };
            },
            async readAccount() {
                const a = await source.claudeAccount();
                const sessionConfigDir = a.sessionConfigDir ?? null;
                if (a.missing)
                    return {
                        kind: 'unavailable',
                        reason: "Claude Code is not installed or is not on Herdr's PATH.",
                        context: { sessionConfigDir },
                    };
                if (a.error)
                    throw new Error(a.error);
                const context = {
                    sessionConfigDir,
                    configDirectory: a.configDirectory,
                    projectsDirectory: a.projectsDirectory,
                    identity: a.email ? `${a.email}|${a.orgId ?? ''}` : undefined,
                };
                if (a.loggedIn === false)
                    return { kind: 'signed-out', context };
                if (a.loggedIn !== true)
                    throw new Error('Unsupported Claude login status.');
                return {
                    kind: 'signed-in',
                    context,
                    method: a.authMethod ?? 'Claude',
                    email: a.email,
                    plan: a.subscriptionType,
                    expiresAt: a.loginExpiresAt,
                };
            },
        },
        codex: {
            id: 'codex',
            name: 'Codex',
            login: { name: 'Codex login', argv: ['codex', 'login'] },
            logout: { name: 'Codex logout', argv: ['codex', 'logout'] },
            async readUsage() {
                return codexReport(await source.codexUsage());
            },
            readAccount: source.codexAccount,
        },
    };
}
