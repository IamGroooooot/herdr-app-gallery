// Generated from src/providers.ts. Edit the TS source, then run npm run verify.
import { finite, object } from './json.js';
export function periodLabel(minutes) {
    if (minutes === 10080)
        return 'Week';
    if (minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}
function limit(raw) {
    const w = object(raw);
    if (!w || !finite(w.used) || w.used < 0 || w.used > 100 || !finite(w.resets) || w.resets <= 0)
        return null;
    return { used: w.used, resets: w.resets };
}
export function decodeCodexUsage(raw) {
    const data = object(raw);
    if (!data || !Array.isArray(data.samples))
        throw new Error('Unsupported Codex usage report.');
    if (typeof data.error === 'string' && data.error)
        throw new Error(data.error);
    const windows = [];
    let reportedAt = null;
    for (const item of data.samples) {
        const s = object(item);
        if (!s || !Array.isArray(s.windows) || !finite(s.at))
            throw new Error('Invalid Codex usage sample.');
        reportedAt = Math.max(reportedAt ?? 0, s.at * 1000);
        for (const rawWindow of s.windows) {
            const w = object(rawWindow);
            const value = limit(w);
            if (!w || !value || !finite(w.minutes) || w.minutes <= 0 || typeof w.key !== 'string')
                throw new Error('Invalid Codex usage window.');
            const label = periodLabel(w.minutes);
            windows.push({
                ...value,
                key: `${String(s.limit_id ?? 'codex')}:${w.key}`,
                label: s.limit_id && s.limit_id !== 'codex' ? `${String(s.name ?? s.limit_id)} · ${label}` : label,
            });
        }
    }
    return { windows, reportedAt, sessions: new Map() };
}
export function decodeCodexAccount(raw) {
    const a = object(raw);
    if (!a)
        throw new Error('Unsupported Codex account response.');
    if (a.missing === true)
        return { kind: 'unavailable', reason: "Codex is not installed or is not on Herdr's PATH." };
    if (a.error)
        throw new Error('Could not check Codex sign-in. Run codex login status in a terminal.');
    if (a.loggedIn === false)
        return { kind: 'signed-out' };
    if (a.loggedIn === true && (a.method === 'ChatGPT' || a.method === 'API key'))
        return { kind: 'signed-in', method: a.method };
    throw new Error('Unsupported Codex login status.');
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
                const labels = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' };
                const windows = Object.entries(r.windows).map(([key, w]) => {
                    const value = limit(w);
                    if (!value)
                        throw new Error('Invalid Claude usage window.');
                    return { ...value, key, label: labels[key] ?? key };
                });
                return { windows, reportedAt: r.reportedAt, sessions: r.sessions };
            },
            async readAccount() {
                const a = await source.claudeAccount();
                if (a.missing)
                    return { kind: 'unavailable', reason: "Claude Code is not installed or is not on Herdr's PATH." };
                if (a.error)
                    throw new Error(a.error);
                const context = {
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
                return decodeCodexUsage(await source.codexUsage());
            },
            async readAccount() {
                return decodeCodexAccount(await source.codexAccount());
            },
        },
    };
}
