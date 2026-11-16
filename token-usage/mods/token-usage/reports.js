// Generated from src/reports.ts. Edit the TS source, then run npm run verify.
/** Claude statusline reports saved by tap.sh: `{"reported_at": seconds, "report": payload}`. */
import { finite, object, parseJson } from './json.js';
const KEYS = ['five_hour', 'seven_day', 'spend_limit'];
const KEEP = 8 * 86400000;
const under = (path, folder) => {
    const base = folder.replace(/[\\/]+$/, '');
    return path.startsWith(base) && /[\\/]/.test(path.charAt(base.length));
};
/** `projects`: the signed-in account's transcript folder. Sessions of another account, which
 *  share this folder of reports when they share the statusline command, do not count as its limits. */
export function decodeReports(files, now, projects) {
    const windows = {};
    const stamps = {};
    const sessions = new Map();
    const expired = [];
    let reports = 0, failures = 0;
    for (const { name, text } of files) {
        const document = text == null ? undefined : parseJson(text);
        if (document == null) {
            failures++;
            expired.push(name);
            continue;
        }
        const wrapper = object(document);
        if (!wrapper)
            continue;
        // Reports saved before tap.sh stamped them are the payload itself, with no report time.
        const payload = object(wrapper.report) ?? wrapper;
        const reportedAt = payload !== wrapper && finite(wrapper.reported_at) && wrapper.reported_at > 0 ? wrapper.reported_at * 1000 : 0;
        reports++;
        const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : name.replace(/\.json$/, '');
        const model = object(payload.model)?.display_name;
        const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
        sessions.set(sid, { transcript, model: typeof model === 'string' ? model : null });
        const foreign = Boolean(projects && transcript && !under(transcript, projects));
        let active = false;
        for (const key of foreign ? [] : KEYS) {
            const w = object(object(payload.rate_limits)?.[key]);
            const used = w?.used_percentage, resets = w?.resets_at;
            if (!finite(used) || !finite(resets) || used < 0 || used > 100 || resets <= 0)
                continue;
            if (resets * 1000 > now)
                active = true;
            const candidate = [resets, used, reportedAt];
            const best = stamps[key] ?? [0, 0, 0];
            const order = candidate[0] - best[0] || candidate[1] - best[1] || candidate[2] - best[2];
            if (order > 0) {
                stamps[key] = candidate;
                windows[key] = { used, resets };
            }
        }
        if (reportedAt ? now - reportedAt > KEEP : !active && !foreign)
            expired.push(name);
    }
    const reportedAt = Math.max(0, ...Object.values(stamps).map(s => s[2])) || null;
    return { limits: { windows, sessions, reports, reportedAt }, failures, expired };
}
