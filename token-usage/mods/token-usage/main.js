// Generated from src/main.ts. Edit the TS source, then run npm run verify.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, theme, run, props, agents, spaces, home, openOverlay, closeOverlay, nextCommand, notify, shared, setShared } from "herdr";
import { tapPath, configDir, projectsDir, connect, disconnect, prune, ensureDataDir, sessionOf, findTranscript, Totals, modelName } from "./data.js";
import { usageProviders, commonPeriod, usageValue, remainingValue, resetLabel } from "./usage-model.js";
import { usageStore } from "./runtime.js";
const ICON = (name) => `mods/token-usage/icons/${name}.svg`;
const SESSIONS_EVERY = 5000;
const PREFS = "token-usage.prefs";
const DEFAULTS = { warn: 80, urgent: 95, sound: true };
const PLANS = { pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise", ultra: "Claude Ultra" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prefs = () => ({ ...DEFAULTS, ...(shared(PREFS) ?? {}) });
function clock(d, long = false) {
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const ap = h < 12 ? "am" : "pm";
    if (long)
        return `${h % 12 || 12}:${m} ${ap}`;
    return `${h % 12 || 12}${m === "00" ? "" : `:${m}`}${ap}`;
}
function resetText(sec, long = false) {
    const at = sec * 1000;
    const left = at - Date.now();
    if (left <= 0)
        return `reset at ${clock(new Date(at), long)}`;
    if (left < 3600000)
        return `resets in ${Math.max(1, Math.round(left / 60000))}m`;
    const d = new Date(at);
    return `resets ${d.toDateString() === new Date().toDateString() ? "" : `${DAYS[d.getDay()]} `}${clock(d, long)}`;
}
function ago(ms) {
    const m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 1)
        return "just now";
    if (m < 60)
        return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
function count(n) {
    if (n >= 999950)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 999.5)
        return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}
const monthDay = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
export default class ClaudeUsage extends View {
    overlay;
    page;
    rows;
    rowsError;
    totals;
    transcripts;
    busy;
    error;
    pending;
    pendingAction;
    narrow = false;
    store;
    init(_props, cx) {
        this.overlay = props()?.overlay ?? null;
        const requestedPage = props()?.page;
        this.page = requestedPage === "account" || requestedPage === "codex-account" ? requestedPage : "usage";
        this.store = usageStore();
        this.rows = null;
        this.rowsError = null;
        this.totals = new Totals();
        this.transcripts = new Map();
        this.busy = {};
        this.error = null;
        this.pending = null;
        if (checking())
            return;
        cx.timer.every(5000, cx => this.refresh(cx));
        if (this.overlay)
            cx.timer.every(SESSIONS_EVERY, cx => this.refreshSessions(cx));
        else {
            ensureDataDir().then(() => prune()).catch(() => null);
            cx.timer.every(3600000, () => prune());
        }
        this.refresh(cx);
        if (this.overlay && this.page !== "usage")
            this.refreshAccount(cx, this.page === "account" ? "claude" : "codex");
        cx.timer.every(10000, cx => {
            if (this.overlay && this.page !== "usage")
                this.refreshAccount(cx, this.page === "account" ? "claude" : "codex");
        });
        cx.spawn(async (cx) => {
            for (;;) {
                const c = await nextCommand();
                if (c === "settings" || c === "account" || c === "codex-account" || c === "codexaccount") {
                    if (!this.overlay)
                        this.openSettings(c === "settings" ? "usage" : c === "codexaccount" ? "codex-account" : c);
                }
                else if (this.pending && c === this.pending)
                    await this.act(this.pendingAction, cx);
                cx.notify();
            }
        });
    }
    get data() { return this.store.usage.claude.value; }
    get link() { return this.store.connection.value; }
    get original() { return this.link?.command ?? this.link?.settings?.statusLine?.command ?? ""; }
    claudeContext() { return this.store.accounts.claude.value?.context ?? {}; }
    refresh(cx) {
        const store = this.store;
        cx.spawn(async () => { await store.poll(); }, { owner: null });
    }
    refreshSessions(cx) {
        if (this.busy.sessions || this.page !== "usage" || this.store.accounts.claude.value?.kind !== "signed-in")
            return;
        this.busy.sessions = true;
        cx.spawn(async (cx) => {
            try {
                const dir = configDir(this.claudeContext());
                const prev = new Map((this.rows ?? []).map((r) => [r.address, r]));
                const rows = [];
                let failed = 0;
                for (const a of agents().filter((a) => a.app === "claude-code" && !a.address.includes("/"))) {
                    try {
                        const sid = await sessionOf(a.address, dir);
                        if (!sid)
                            continue;
                        let transcript = this.data?.sessions.get(sid)?.transcript ?? this.transcripts.get(sid);
                        if (!transcript) {
                            transcript = await findTranscript(projectsDir(this.claudeContext()), sid);
                            if (transcript)
                                this.transcripts.set(sid, transcript);
                        }
                        if (!transcript)
                            continue;
                        const t = await this.totals.of(transcript);
                        rows.push({ address: a.address, name: a.tab_name, space: a.space_name, status: a.status, ...t, model: modelName(t.model, this.data?.sessions.get(sid)?.model) });
                    }
                    catch {
                        failed++;
                        const old = prev.get(a.address);
                        if (old)
                            rows.push({ ...old, name: a.tab_name, space: a.space_name, status: a.status });
                    }
                }
                this.rows = rows;
                this.rowsError = failed ? `Couldn't read ${failed === 1 ? "1 session" : `${failed} sessions`}. Trying again.` : null;
            }
            finally {
                this.busy.sessions = false;
                cx.notify();
            }
        });
    }
    openSettings(page) {
        openOverlay({ mod: "token-usage", kind: "dialog", width: 720, height: 560, props: { page } });
    }
    ask(action, title, detail) {
        this.pendingAction = action;
        this.pending = `${action}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 200, props: { title, detail, command: { name: `token-usage.${this.pending}` } } });
    }
    async act(action, cx) {
        this.pending = null;
        this.pendingAction = null;
        if (action === "codexlogout") {
            this.startAgent(this.store.providers.codex.logout.name, this.store.providers.codex.logout.argv);
            return;
        }
        if (action === "logout") {
            this.startClaude(this.store.providers.claude.logout.name, this.store.providers.claude.logout.argv);
            return;
        }
        this.busy.link = true;
        cx.notify();
        try {
            const dir = configDir(this.claudeContext());
            if (action === "connect")
                await connect(dir);
            else if (action === "disconnect")
                await disconnect(dir);
            else
                throw new Error("Unsupported account action.");
            this.error = null;
            notify({
                title: action === "connect" ? "Connected to Claude Code" : "Disconnected from Claude Code",
                body: action === "connect" ? "Your plan limits arrive with your next Claude reply." : "Your statusline runs your own command again.",
                level: "success",
                timeout: 6000,
            });
        }
        catch (e) {
            this.error = String(e instanceof Error ? e.message : e);
            notify({ title: action === "connect" ? "Couldn't connect" : "Couldn't disconnect", body: this.error, level: "error" });
        }
        finally {
            this.busy.link = false;
            await this.store.connectionChanged();
            this.refresh(cx);
        }
    }
    startClaude(name, argv) {
        this.store.watchAccount("claude");
        this.startAgent(name, argv);
    }
    startAgent(name, argv) {
        this.store.watchAccount(argv[0] === "claude" ? "claude" : "codex");
        const local = spaces().find((s) => s.machine == null && s.active) ?? spaces().find((s) => s.machine == null);
        if (local)
            run("tab.new", { name, space: local.id, argv });
        else
            run("space.new", { name, argv, machine: "" });
        if (this.overlay)
            closeOverlay(this.overlay);
    }
    askConnect() {
        this.ask("connect", "Connect Claude Code?", "Puts a small script in front of your Claude Code statusline command that saves your plan limits. Your statusline looks the same. Disconnect takes the script out.");
    }
    color(t, used) {
        const { warn, urgent } = prefs();
        return used >= urgent ? t.blocked : used >= warn ? t.working : t.accent;
    }
    icon(name, color, size = 14) {
        return svg(ICON(name)).size(size).flex_none().text_color(color);
    }
    button(t, id, label, onClick, solid = false) {
        return div().id(id).px(12).py(5).rounded(6).flex_none().cursor_pointer().text_size(12.5).font_medium()
            .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground))
            .when(!solid, (el) => el.bg(t.raised).border_1().border_color(t.input).text_color(t.foreground))
            .hover((s) => s.opacity(0.85))
            .on_click((e, cx) => {
            cx.stop_propagation();
            onClick(cx);
        })
            .child(label);
    }
    bar(t, amount, h, used = amount) {
        const pct = Math.max(0, Math.min(100, amount));
        return div().flex_1().min_w(0).h(h).rounded(h / 2).bg(t.selected).overflow_hidden()
            .child(div().w(`${pct}%`).h(h).bg(this.color(t, used)));
    }
    render(cx) {
        const t = theme();
        return this.overlay ? this.renderSettings(t, cx) : this.renderStrip(t, cx);
    }
    providers() {
        return usageProviders(Object.values(this.store.providers).map(provider => ({ provider,
            account: this.store.accounts[provider.id], usage: this.store.usage[provider.id],
            connection: provider.id === "claude" ? this.store.connection : undefined })));
    }
    providerTip(p) {
        return [p.detail, p.at ? `Updated ${ago(Date.now() - p.at)}.` : null, p.error,
            ...p.windows.map(w => `${w.label}: ${remainingValue(w)} left (${usageValue(w)} used), ${resetText(w.resets, true)}`)].filter(Boolean).join("\n");
    }
    providerRows(t, p, period, detail = false) {
        const nameWidth = detail ? 110 : 44;
        if (!p.windows.length)
            return [h_flex().items_center().gap(8).h(26)
                    .child(div().w(nameWidth).flex_none().text_color(t.foreground).child(p.name))
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(p.error ? t.working : t.muted).child(p.message))];
        return p.windows.map((w, i) => {
            const expired = w.resets * 1000 <= Date.now();
            const status = [!period ? w.label : null, p.error ? "Error" : p.stale ? "Stale" : null].filter(Boolean).join(" · ");
            return h_flex().id(`usage-${p.id}-${w.key}`).h(status ? 32 : 22).items_center().gap(8).tooltip(this.providerTip(p))
                .child(v_flex().w(nameWidth).flex_none().gap(1)
                .child(div().truncate().text_color(t.foreground).child(i ? "" : p.name))
                .when(Boolean(status), el => el.child(div().truncate().text_size(10).text_color(p.error ? t.working : t.muted).child(status))))
                .child(this.bar(t, expired ? 0 : 100 - w.used, 3, w.used).when(p.stale || Boolean(p.error), el => el.opacity(0.5)))
                .child(div().w(32).flex_none().text_right().font_medium()
                .text_color(expired ? t.muted : w.used >= prefs().warn ? this.color(t, w.used) : t.foreground).child(remainingValue(w)))
                .child(div().w(64).flex_none().text_right().text_size(11).text_color(t.muted).child(resetLabel(w.resets)));
        });
    }
    usageOverview(t, providers, detail = false) {
        const period = commonPeriod(providers);
        return v_flex().gap(detail ? 8 : 6).text_size(12)
            .child(h_flex().h(18).items_center().gap(6)
            .child(div().text_size(11).text_color(t.muted).child(period ? `${period} left` : "Remaining"))
            .when(!detail, el => el.child(div().id("cu-gear").cursor_pointer().tooltip("Usage settings")
            .on_click((e, cx) => { cx.stop_propagation(); this.openSettings("usage"); })
            .child(this.icon("settings", t.muted, 12))))
            .child(div().flex_1())
            .child(div().w(64).text_right().text_size(11).text_color(t.muted).child("Resets")))
            .children(providers.flatMap(p => this.providerRows(t, p, period, detail)));
    }
    renderStrip(t, cx) {
        const providers = this.providers();
        if (this.narrow) {
            return this.sized(v_flex().id("usage-rail").size_full().justify_end().items_center().gap(6).pb(8).cursor_pointer()
                .on_click(() => this.openSettings("usage"))
                .children(providers.map(p => v_flex().id(`rail-${p.id}`).items_center().gap(2).tooltip(this.providerTip(p))
                .child(div().text_size(10).text_color(t.muted).child(p.name))
                .children(p.windows.length ? p.windows.map(w => div().text_size(12).text_color(t.foreground).child(remainingValue(w)))
                : [div().text_size(11).text_color(t.muted).child("--")]))));
        }
        return this.sized(v_flex().id("cu-root").size_full().px(16).pb(8).cursor_pointer()
            .on_click(() => this.openSettings("usage"))
            .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().justify_end().child(this.usageOverview(t, providers))));
    }
    sized(el) {
        return el.on_size_change((size, cx) => {
            const narrow = size.width < 150;
            if (narrow !== this.narrow) {
                this.narrow = narrow;
                cx.notify();
            }
        });
    }
    refreshAccount(cx, id, force = false) {
        const store = this.store;
        cx.spawn(async () => { await store.refreshAccount(id, force); }, { owner: null });
    }
    renderAccount(t, id) {
        const provider = this.store.providers[id];
        const resource = this.store.accounts[id];
        const account = resource.value;
        const content = this.box(t);
        if (resource.error)
            content.child(div().text_size(12).text_color(t.working).child(resource.error));
        if (!account)
            content.child(div().text_color(t.muted).child(resource.loading ? "Checking sign-in…" : "Sign-in status unavailable."));
        else if (account.kind === "unavailable")
            content.child(div().text_color(t.muted).child(account.reason));
        else {
            const signedIn = account.kind === "signed-in";
            const meta = signedIn ? [account.email, PLANS[account.plan] || account.plan || account.method,
                account.expiresAt ? `Expires ${monthDay(account.expiresAt)}` : null].filter(Boolean).join(" · ") : "";
            content.child(h_flex().items_center().gap(12)
                .child(h_flex().flex_1().min_w(0).gap(10).items_center()
                .child(div().w(7).h(7).rounded(4).flex_none().bg(signedIn ? t.done : t.idle))
                .child(v_flex().gap(4).min_w(0)
                .child(div().font_medium().child(signedIn ? "Signed in" : "Signed out"))
                .when(Boolean(meta), el => el.child(div().truncate().text_size(12).text_color(t.muted).child(meta)))))
                .child(signedIn
                ? this.button(t, `${id}-logout`, "Log out", () => this.ask(id === "claude" ? "logout" : "codexlogout", `Log out of ${provider.name}?`, `Runs ${provider.logout.argv.join(" ")} on this computer and removes its stored sign-in.`))
                : this.button(t, `${id}-login`, "Log in", () => id === "claude" ? this.startClaude(provider.login.name, provider.login.argv) : this.startAgent(provider.login.name, provider.login.argv), true)));
        }
        content.child(h_flex().child(this.button(t, `${id}-refresh`, resource.loading ? "Checking…" : "Refresh", cx => this.refreshAccount(cx, id, true))));
        const sections = [v_flex().gap(8).child(this.heading(t, "Sign-in")).child(content)];
        if (id === "claude")
            sections.push(this.connectionSection(t));
        else
            sections.push(v_flex().gap(8).child(this.heading(t, "Usage connection"))
                .child(div().text_color(t.muted).text_size(12).child("Local reports update after each reply. No connection setup is needed. After switching accounts, the previous report may remain until a new reply.")));
        return sections;
    }
    renderSettings(t, cx) {
        const pages = [
            { id: "usage", title: "Usage", icon: "chart", render: () => this.usagePage(t) },
            { id: "account", title: "Claude account", icon: "user", render: () => this.renderAccount(t, "claude") },
            { id: "codex-account", title: "Codex account", icon: "user", render: () => this.renderAccount(t, "codex") },
        ];
        const page = pages.find(p => p.id === this.page) || pages[0];
        const nav = (id, label, icon) => {
            const on = this.page === id;
            return h_flex().id(`cu-nav-${id}`).gap(8).items_center().px(8).py(7).rounded(6).cursor_pointer()
                .text_color(on ? t.foreground : t.muted)
                .when(on, (el) => el.bg(t.selected))
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                this.page = id;
                if (id === "usage")
                    this.refreshSessions(cx);
                if (id !== "usage")
                    this.refreshAccount(cx, id === "account" ? "claude" : "codex");
                cx.notify();
            })
                .child(this.icon(icon, on ? t.foreground : t.muted, 15))
                .child(label);
        };
        return h_flex().size_full().text_size(13).text_color(t.foreground)
            .child(v_flex().w(176).flex_none().h_full().bg(t.chrome).border_r_1().border_color(t.border).px(10).py(16).gap(2)
            .child(div().px(8).pb(12).font_semibold().child("Usage settings"))
            .children(pages.map(p => nav(p.id, p.title, p.icon))))
            .child(v_flex().flex_1().min_w(0).h_full().px(24).py(20).gap(18).overflow_y_scrollbar()
            .child(h_flex().items_center()
            .child(div().flex_1().text_size(16).font_semibold().child(page.title))
            .child(div().id("cu-close").cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click(() => closeOverlay(this.overlay))
            .child(this.icon("x", t.muted, 14))))
            .children(page.render()));
    }
    heading(t, text) {
        return div().text_size(11).font_medium().text_color(t.muted).child(text);
    }
    box(t) {
        return v_flex().gap(10).py(6);
    }
    usagePage(t) {
        const cols = [["Session", null], ["Model", 84], ["Output", 64], ["Input + cache write", 132], ["Cache read", 80]];
        const head = h_flex().gap(8).pb(6).text_size(12).font_medium().text_color(t.muted)
            .children(cols.map(([label, w], i) => (w ? div().w(w).flex_none().when(i > 1, (el) => el.text_right()) : div().flex_1().min_w(0)).child(label)));
        const dot = (status) => ({ working: t.working, blocked: t.blocked, done: t.done }[status] ?? t.idle);
        const rows = (this.rows ?? []).map((r) => h_flex().id(`cu-row-${r.address}`).gap(8).py(8).border_t_1().border_color(t.border).text_size(12).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => {
            run("agent.focus", { terminal: r.address });
            closeOverlay(this.overlay);
        })
            .child(h_flex().flex_1().min_w(0).gap(8).items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(dot(r.status)))
            .child(div().truncate().child(r.name))
            .child(div().truncate().text_color(t.muted).child(r.space)))
            .child(div().w(84).flex_none().text_color(t.muted).child(r.model || "--"))
            .child(div().w(64).flex_none().text_right().child(count(r.output)))
            .child(div().w(132).flex_none().text_right().child(count(r.input)))
            .child(div().w(80).flex_none().text_right().child(count(r.cacheRead))));
        const empty = this.rows == null ? "Reading transcripts." : "No Claude Code sessions in Herdr on this computer.";
        const { warn, urgent, sound } = prefs();
        const set = (patch) => setShared(PREFS, { ...prefs(), ...patch });
        const stepper = (id, label, value, min, max, key) => h_flex().gap(8).items_center()
            .child(label)
            .child(this.button(t, `${id}-down`, "-", () => set({ [key]: Math.max(min, value - 5) })))
            .child(div().w(40).text_right().child(`${value}%`))
            .child(this.button(t, `${id}-up`, "+", () => set({ [key]: Math.min(max, value + 5) })));
        return [
            this.usageOverview(t, this.providers(), true),
            ...(["unlinked", "signedout"].includes(this.providers()[0].status) ? [h_flex().child(this.button(t, "usage-connect", this.providers()[0].status === "unlinked" ? "Connect Claude" : "Log in to Claude", () => this.providers()[0].status === "unlinked" ? this.askConnect() : this.startClaude("Claude login", ["claude", "auth", "login"]), true))] : []),
            v_flex().gap(4).child(this.heading(t, "Claude sessions on this computer")).when(Boolean(rows.length), el => el.child(v_flex().pt(6).child(head).children(rows)))
                .when(!rows.length && !this.rowsError, (el) => el.child(div().py(8).text_size(12).text_color(t.muted).child(empty)))
                .when(Boolean(this.rowsError), (el) => el.child(div().py(8).text_size(12).text_color(t.blocked).child(this.rowsError)))
                .when(Boolean(rows.length), el => el.child(div().pt(6).text_size(12).text_color(t.muted).child("Transcript totals include subagents. Select a session to open its tab."))),
            v_flex().gap(10).child(this.heading(t, "Claude alerts"))
                .child(h_flex().gap(20).items_center().flex_wrap()
                .child(stepper("cu-warn", "Warn at", warn, 50, urgent - 5, "warn"))
                .child(stepper("cu-urgent", "Urgent at", urgent, warn + 5, 100, "urgent"))
                .child(h_flex().id("cu-sound").gap(8).items_center().cursor_pointer()
                .on_click(() => set({ sound: !sound }))
                .child(div().w(14).h(14).rounded(3).border_1().border_color(t.input).when(sound, (el) => el.bg(t.accent)))
                .child("Sound when urgent"))),
        ];
    }
    connectionSection(t) {
        const link = this.box(t);
        const l = this.link;
        if (!l)
            link.child(div().text_color(t.muted).child("Checking."));
        else if (l.error)
            link.child(div().text_color(t.blocked).child(l.error));
        else {
            link.child(h_flex().items_center().gap(12)
                .child(h_flex().flex_1().gap(8).items_center()
                .child(div().w(7).h(7).rounded(4).flex_none().bg(l.connected ? t.done : t.idle))
                .child(div().font_medium().child(l.connected ? "Connected" : "Not connected"))
                .child(div().text_color(t.muted).child(l.connected ? "limits arrive after each reply" : "")))
                .child(this.busy.link
                ? div().text_color(t.muted).child("Working")
                : l.connected
                    ? this.button(t, "cu-disconnect", "Disconnect", () => this.ask("disconnect", "Disconnect Claude Code?", "Takes the script out of your statusline command. The strip stops getting your plan limits."))
                    : this.button(t, "cu-connect-a", "Connect", () => this.askConnect(), true)))
                .child(div().text_color(t.muted).child("Claude Code gives your statusline your plan limits. The mod saves them, then passes them on to your own statusline command, so your statusline looks the same."))
                .child(v_flex().gap(4).p(10).rounded(6).bg(t.chrome).text_size(12)
                .child(h_flex().gap(8).child(div().w(72).flex_none().text_color(t.muted).child(l.connected ? "statusline" : "changes to")).child(div().truncate().child(tilde(tapPath()))))
                .child(h_flex().gap(8).child(div().w(72).flex_none().text_color(t.muted).child("then runs")).child(div().truncate().child(this.original || "nothing, you have no statusline"))))
                .child(div().text_size(12).text_color(t.muted).child(`It edits ${tilde(l.path)}. Edit your command there, and Disconnect keeps your edit.`));
        }
        for (const e of [this.error, this.store.connection.error].filter(Boolean))
            link.child(div().text_size(12).text_color(t.blocked).child(e));
        return v_flex().gap(10).child(this.heading(t, "Claude Code connection")).child(link);
    }
}
