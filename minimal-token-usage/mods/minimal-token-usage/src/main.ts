import { h_flex, v_flex } from 'gpui-base';
import type { AsyncContext, Context, Element } from 'gpui-kit';
import { div, svg, View } from 'gpui-kit';
import {
  agents,
  checking,
  closeOverlay,
  home,
  layout,
  nextCommand,
  notify,
  openOverlay,
  props,
  run,
  setShared,
  shared,
  spaces,
  theme,
  themes,
} from 'herdr';
import {
  configDir,
  connect,
  disconnect,
  ensureDataDir,
  findTranscript,
  modelName,
  projectsDir,
  prune,
  sessionOf,
  Totals,
  tapPath,
} from './data.js';
import { usageStore } from './runtime.js';
import type { UsageStore } from './store.js';
import type { ConfirmAction, DisplayProvider, PageId, Prefs, ProviderId, SessionRow } from './types.js';
import type { StripStyle } from './usage-model.js';
import {
  commonPeriod,
  litSegments,
  ownColors,
  PREFS_KEY,
  periodWidth,
  readPrefs,
  remainingPercent,
  remainingValue,
  resetLabel,
  rowNote,
  STRIP,
  STRIP_STYLES,
  stripHeight,
  stripOverflows,
  usageProviders,
  usageValue,
} from './usage-model.js';

type Color = `#${string}`;
type Theme = Record<string, Color>;

const ICON = (name: string) => `mods/minimal-token-usage/icons/${name}.svg`;
const SESSIONS_EVERY = 5000;
const PLANS: Record<string, string> = {
  pro: 'Claude Pro',
  max: 'Claude Max',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise',
  ultra: 'Claude Ultra',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const prefs = (): Prefs => readPrefs(shared(PREFS_KEY));
const ownTheme = () => ownColors(themes(), prefs().theme);
const palette = (): Theme => ({ ...theme(), ...ownTheme() }) as Theme;

function ago(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function count(n: number) {
  if (n >= 999950) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 999.5) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const monthDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

function ownBlock(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as { id?: unknown; content?: { mod?: unknown }; size?: { px?: unknown }; children?: unknown };
  if (n.content?.mod === 'minimal-token-usage')
    return typeof n.id === 'string' && typeof n.size?.px === 'number' ? n.id : null;
  for (const child of Array.isArray(n.children) ? n.children : []) {
    const id = ownBlock(child);
    if (id) return id;
  }
  return null;
}

const tilde = (path: string) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);

export default class ClaudeUsage extends View {
  overlay: string | null = null;
  page: PageId = 'usage';
  rows: SessionRow[] | null = null;
  rowsError: string | null = null;
  totals = new Totals();
  transcripts = new Map<string, string>();
  busy: Record<string, boolean> = {};
  error: string | null = null;
  pending: string | null = null;
  pendingAction: ConfirmAction | null = null;
  narrow = false;
  fitted: number | null = null;
  store!: UsageStore;

  override init(_props: unknown, cx: AsyncContext) {
    this.overlay = (props()?.overlay as string) ?? null;
    const requestedPage = props()?.page;
    this.page = requestedPage === 'account' || requestedPage === 'codex-account' ? requestedPage : 'usage';
    this.store = usageStore();

    if (checking()) return;

    cx.timer.every(5000, cx => this.refresh(cx));
    if (this.overlay) cx.timer.every(SESSIONS_EVERY, cx => this.refreshSessions(cx));
    else {
      ensureDataDir()
        .then(() => prune())
        .catch((): null => null);
      cx.timer.every(3600000, () => prune());
    }
    this.refresh(cx);
    if (this.overlay && this.page !== 'usage') this.refreshAccount(cx, this.page === 'account' ? 'claude' : 'codex');
    cx.timer.every(10000, cx => {
      if (this.overlay && this.page !== 'usage') this.refreshAccount(cx, this.page === 'account' ? 'claude' : 'codex');
    });

    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === 'settings' || c === 'account' || c === 'codex-account' || c === 'codexaccount') {
          if (!this.overlay)
            this.openSettings(c === 'settings' ? 'usage' : c === 'codexaccount' ? 'codex-account' : (c as PageId));
        } else if (this.pending && c === this.pending && this.pendingAction) await this.act(this.pendingAction, cx);
        cx.notify();
      }
    });
  }

  private get data() {
    return this.store.usage.claude.value;
  }
  private get link() {
    return this.store.connection.value;
  }
  private get original() {
    return this.link?.command ?? this.link?.settings?.statusLine?.command ?? '';
  }
  private claudeContext() {
    return this.store.accounts.claude.value?.context ?? {};
  }

  refresh(cx: AsyncContext) {
    const store = this.store;
    cx.spawn(
      async () => {
        await store.poll();
        this.fit();
      },
      { owner: null },
    );
  }

  fit() {
    if (this.overlay || this.narrow) return;
    const px = stripHeight(this.providers(), prefs().style);
    if (px === this.fitted) return;
    const id = ownBlock(layout());
    if (!id) return;
    this.fitted = px;
    run('layout.resize', { id, px });
  }

  refreshSessions(cx: AsyncContext) {
    if (this.busy.sessions || this.page !== 'usage' || this.store.accounts.claude.value?.kind !== 'signed-in') return;
    this.busy.sessions = true;
    cx.spawn(async cx => {
      try {
        const dir = configDir(this.claudeContext());
        const prev = new Map((this.rows ?? []).map(r => [r.address, r]));
        const rows = [];
        let failed = 0;
        for (const a of agents().filter(a => a.app === 'claude-code' && !a.address.includes('/'))) {
          try {
            const sid = await sessionOf(a.address, dir);
            if (!sid) continue;
            let transcript = this.data?.sessions.get(sid)?.transcript ?? this.transcripts.get(sid);
            if (!transcript) {
              transcript = (await findTranscript(projectsDir(this.claudeContext()), sid)) ?? undefined;
              if (transcript) this.transcripts.set(sid, transcript);
            }
            if (!transcript) continue;
            const t = await this.totals.of(transcript);
            rows.push({
              address: a.address,
              name: a.tab_name,
              space: a.space_name,
              status: a.status,
              ...t,
              model: modelName(t.model, this.data?.sessions.get(sid)?.model),
            });
          } catch {
            failed++;
            const old = prev.get(a.address);
            if (old) rows.push({ ...old, name: a.tab_name, space: a.space_name, status: a.status });
          }
        }
        this.rows = rows;
        this.rowsError = failed
          ? `Couldn't read ${failed === 1 ? '1 session' : `${failed} sessions`}. Trying again.`
          : null;
      } finally {
        this.busy.sessions = false;
        cx.notify();
      }
    });
  }

  closeSettings() {
    if (this.overlay) closeOverlay(this.overlay);
  }

  openSettings(page: PageId) {
    openOverlay({ mod: 'minimal-token-usage', kind: 'dialog', width: 720, height: 560, props: { page } });
  }

  ask(action: ConfirmAction, title: string, detail: string) {
    this.pendingAction = action;
    this.pending = `${action}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    openOverlay({
      mod: 'confirm',
      kind: 'dialog',
      width: 420,
      height: 200,
      props: { title, detail, command: { name: `minimal-token-usage.${this.pending}` } },
    });
  }

  async act(action: ConfirmAction, cx: AsyncContext) {
    this.pending = null;
    this.pendingAction = null;
    if (action === 'codexlogout') {
      this.startAgent(this.store.providers.codex.logout.name, this.store.providers.codex.logout.argv);
      return;
    }
    if (action === 'logout') {
      this.startClaude(this.store.providers.claude.logout.name, this.store.providers.claude.logout.argv);
      return;
    }
    this.busy.link = true;
    cx.notify();
    try {
      const dir = configDir(this.claudeContext());
      if (action === 'connect') await connect(dir);
      else if (action === 'disconnect') await disconnect(dir);
      else throw new Error('Unsupported account action.');
      this.error = null;
      notify({
        title: action === 'connect' ? 'Connected to Claude Code' : 'Disconnected from Claude Code',
        body:
          action === 'connect'
            ? 'Your plan limits arrive with your next Claude reply.'
            : 'Your statusline runs your own command again.',
        level: 'success',
        timeout: 6000,
      });
    } catch (e) {
      this.error = String(e instanceof Error ? e.message : e);
      notify({
        title: action === 'connect' ? "Couldn't connect" : "Couldn't disconnect",
        body: this.error,
        level: 'error',
      });
    } finally {
      this.busy.link = false;
      await this.store.connectionChanged();
      this.refresh(cx);
    }
  }

  startClaude(name: string, argv: string[]) {
    this.store.watchAccount('claude');
    this.startAgent(name, argv);
  }

  startAgent(name: string, argv: string[]) {
    this.store.watchAccount(argv[0] === 'claude' ? 'claude' : 'codex');
    const local = spaces().find(s => s.machine == null && s.active) ?? spaces().find(s => s.machine == null);
    if (local) run('tab.new', { name, space: local.id, argv });
    else run('space.new', { name, argv, machine: '' });
    this.closeSettings();
  }

  askConnect() {
    this.ask(
      'connect',
      'Connect Claude Code?',
      'Puts a small script in front of your Claude Code statusline command that saves your plan limits. Your statusline looks the same. Disconnect takes the script out.',
    );
  }

  color(t: Theme, used: number) {
    const { warn, urgent } = prefs();
    return used >= urgent ? t.blocked : used >= warn ? t.working : t.accent;
  }

  icon(name: string, color: Color, size = 14) {
    return svg(ICON(name)).size(size).flex_none().text_color(color);
  }

  button(t: Theme, id: string, label: string, onClick: (cx: Context) => void, solid = false) {
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(6)
      .flex_none()
      .cursor_pointer()
      .text_size(12.5)
      .font_medium()
      .when(solid, el => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!solid, el => el.bg(t.raised).border_1().border_color(t.input).text_color(t.foreground))
      .hover(s => s.opacity(0.85))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  meter(t: Theme, w: { used: number; resets: number }, dimmed: boolean) {
    return div()
      .relative()
      .flex_1()
      .min_w(0)
      .h(STRIP.meter)
      .rounded(4)
      .bg(t.selected)
      .overflow_hidden()
      .child(
        div()
          .absolute()
          .top_0()
          .left_0()
          .h_full()
          .w(`${remainingPercent(w)}%`)
          .rounded(4)
          .bg(this.color(t, w.used))
          .opacity(dimmed ? 0.25 : 0.5),
      )
      .child(
        h_flex()
          .absolute()
          .inset_0()
          .items_center()
          .justify_end()
          .px(6)
          .text_size(11)
          .font_medium()
          .text_color(this.valueColor(t, w))
          .child(remainingValue(w)),
      );
  }

  gauge(t: Theme, w: { used: number; resets: number }, dimmed: boolean, segmented: boolean) {
    const left = remainingPercent(w);
    const color = this.color(t, w.used);
    const strength = dimmed ? 0.35 : 1;
    if (segmented) {
      const lit = litSegments(left);
      return h_flex()
        .h(STRIP.bar)
        .gap(2)
        .children(
          Array.from({ length: 10 }, (_, i) =>
            div()
              .flex_1()
              .h_full()
              .rounded(1.5)
              .bg(i < lit ? color : t.selected)
              .opacity(i < lit ? strength : 1),
          ),
        );
    }
    return h_flex()
      .h(STRIP.bar)
      .items_center()
      .child(
        div()
          .relative()
          .flex_1()
          .h(4)
          .rounded(2)
          .bg(t.selected)
          .overflow_hidden()
          .child(div().absolute().top_0().left_0().h_full().w(`${left}%`).rounded(2).bg(color).opacity(strength)),
      );
  }

  valueColor(t: Theme, w: { used: number; resets: number }) {
    if (w.resets * 1000 <= Date.now()) return t.muted;
    return w.used >= prefs().warn ? this.color(t, w.used) : t.foreground;
  }

  render() {
    const t = palette();
    return this.overlay ? this.renderSettings(t) : this.renderStrip(t);
  }

  providers(): DisplayProvider[] {
    return usageProviders(
      Object.values(this.store.providers).map(provider => ({
        provider,
        account: this.store.accounts[provider.id],
        usage: this.store.usage[provider.id],
        connection: provider.id === 'claude' ? this.store.connection : undefined,
      })),
    );
  }

  providerTip(p: DisplayProvider) {
    return [
      p.detail,
      p.at ? `Updated ${ago(Date.now() - p.at)}.` : null,
      p.error,
      ...p.windows.map(
        w =>
          `${w.label}: ${remainingValue(w)} left (${usageValue(w)} used), ${w.resets * 1000 <= Date.now() ? 'already reset' : `resets ${resetLabel(w.resets)}`}`,
      ),
    ]
      .filter(Boolean)
      .join('\n');
  }

  providerRows(t: Theme, p: DisplayProvider, periodColumn: number, style: StripStyle, detail = false) {
    const nameWidth = detail ? 110 : 44;
    const note = rowNote(p);
    const noteColor = p.error ? t.working : t.muted;
    if (!p.windows.length)
      return [
        h_flex()
          .items_center()
          .gap(8)
          .h(STRIP.message)
          .child(div().w(nameWidth).flex_none().text_color(t.foreground).child(p.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(noteColor).child(p.message)),
      ];
    const dimmed = p.stale || Boolean(p.error);
    return p.windows.map((w, i) => {
      const noted = i === 0 && Boolean(note);
      const id = `usage-${p.id}-${w.key}`;
      const name = () =>
        div()
          .truncate()
          .text_color(t.foreground)
          .child(i ? '' : p.name);
      const period = () =>
        div().w(periodColumn).flex_none().truncate().text_size(11).text_color(t.muted).child(w.label);
      const resets = () =>
        div().w(64).flex_none().text_right().text_size(11).text_color(t.muted).child(resetLabel(w.resets));
      if (style === 'meter')
        return h_flex()
          .id(id)
          .h(noted ? STRIP.noted : STRIP.row)
          .items_center()
          .gap(8)
          .tooltip(this.providerTip(p))
          .child(
            v_flex()
              .w(nameWidth)
              .flex_none()
              .gap(1)
              .child(name())
              .when(noted, el =>
                el.child(
                  div()
                    .truncate()
                    .text_size(10)
                    .text_color(noteColor)
                    .child(note ?? ''),
                ),
              ),
          )
          .when(periodColumn > 0, el => el.child(period()))
          .child(this.meter(t, w, dimmed))
          .child(resets());
      return v_flex()
        .id(id)
        .h(STRIP.stacked)
        .gap(STRIP.lineGap)
        .tooltip(this.providerTip(p))
        .child(
          h_flex()
            .h(STRIP.line)
            .items_center()
            .gap(8)
            .child(div().w(nameWidth).flex_none().child(name()))
            .when(periodColumn > 0, el => el.child(period()))
            .child(div().flex_none().font_medium().text_color(this.valueColor(t, w)).child(remainingValue(w)))
            .when(noted, el =>
              el.child(
                div()
                  .flex_none()
                  .text_size(10)
                  .text_color(noteColor)
                  .child(note ?? ''),
              ),
            )
            .child(div().flex_1())
            .child(resets()),
        )
        .child(this.gauge(t, w, dimmed, style === 'segments'));
    });
  }

  usageOverview(t: Theme, providers: DisplayProvider[], detail = false) {
    const period = commonPeriod(providers);
    const periodColumn = periodWidth(providers, detail ? 220 : 72);
    const { style } = prefs();
    return v_flex()
      .gap(detail ? 8 : STRIP.gap)
      .text_size(12)
      .child(
        h_flex()
          .h(STRIP.header)
          .items_center()
          .gap(6)
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .child(period ? `${period} left` : 'Remaining'),
          )
          .when(!detail, el =>
            el.child(
              div()
                .id('cu-gear')
                .cursor_pointer()
                .tooltip('Usage settings')
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.openSettings('usage');
                })
                .child(this.icon('settings', t.muted, 12)),
            ),
          )
          .child(div().flex_1())
          .child(div().w(64).text_right().text_size(11).text_color(t.muted).child('Resets')),
      )
      .children(providers.flatMap(p => this.providerRows(t, p, periodColumn, style, detail)));
  }

  renderStrip(t: Theme) {
    const providers = this.providers();
    if (this.narrow) {
      return this.sized(
        this.surface(v_flex().id('usage-rail').size_full(), t.chrome)
          .justify_end()
          .items_center()
          .gap(6)
          .pb(8)
          .cursor_pointer()
          .on_click(() => this.openSettings('usage'))
          .children(
            providers.map(p =>
              v_flex()
                .id(`rail-${p.id}`)
                .items_center()
                .gap(2)
                .tooltip(this.providerTip(p))
                .child(div().text_size(10).text_color(t.muted).child(p.name))
                .children(
                  p.windows.length
                    ? p.windows.map(w => div().text_size(12).text_color(t.foreground).child(remainingValue(w)))
                    : [div().text_size(11).text_color(t.muted).child('--')],
                ),
            ),
          ),
      );
    }
    this.fit();
    return this.sized(
      this.surface(v_flex().id('cu-root').size_full(), t.chrome)
        .px(16)
        .pb(STRIP.pad)
        .cursor_pointer()
        .on_click(() => this.openSettings('usage'))
        .child(this.stripBody(providers).child(this.usageOverview(t, providers))),
    );
  }

  stripBody(providers: DisplayProvider[]) {
    const body = v_flex().flex_1().min_h(0).justify_end();
    return this.fitted !== null && !stripOverflows(providers, prefs().style)
      ? body.overflow_hidden()
      : body.overflow_y_scrollbar();
  }

  /** Herdr paints what is behind a mod in the app's colors; a mod with its own theme paints its own. */
  surface<E extends Element>(el: E, color: Color): E {
    return ownTheme() ? (el.bg(color) as E) : el;
  }

  sized(el: Element) {
    return el.on_size_change((size, cx) => {
      const narrow = size.width < 150;
      if (narrow !== this.narrow) {
        this.narrow = narrow;
        cx.notify();
      }
    });
  }

  refreshAccount(cx: AsyncContext, id: ProviderId, force = false): void {
    const store = this.store;
    cx.spawn(
      async () => {
        await store.refreshAccount(id, force);
      },
      { owner: null },
    );
  }

  renderAccount(t: Theme, id: ProviderId): Element[] {
    const provider = this.store.providers[id];
    const resource = this.store.accounts[id];
    const account = resource.value;
    const content = this.box();
    if (resource.error) content.child(div().text_size(12).text_color(t.working).child(resource.error));
    if (!account)
      content.child(
        div()
          .text_color(t.muted)
          .child(resource.loading ? 'Checking sign-in…' : 'Sign-in status unavailable.'),
      );
    else if (account.kind === 'unavailable') content.child(div().text_color(t.muted).child(account.reason));
    else {
      const signedIn = account.kind === 'signed-in';
      const meta = signedIn
        ? [
            account.email,
            PLANS[account.plan ?? ''] || account.plan || account.method,
            account.expiresAt ? `Expires ${monthDay(account.expiresAt)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      content.child(
        h_flex()
          .items_center()
          .gap(12)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(10)
              .items_center()
              .child(
                div()
                  .w(7)
                  .h(7)
                  .rounded(4)
                  .flex_none()
                  .bg(signedIn ? t.done : t.idle),
              )
              .child(
                v_flex()
                  .gap(4)
                  .min_w(0)
                  .child(
                    div()
                      .font_medium()
                      .child(signedIn ? 'Signed in' : 'Signed out'),
                  )
                  .when(Boolean(meta), el => el.child(div().truncate().text_size(12).text_color(t.muted).child(meta))),
              ),
          )
          .child(
            signedIn
              ? this.button(t, `${id}-logout`, 'Log out', () =>
                  this.ask(
                    id === 'claude' ? 'logout' : 'codexlogout',
                    `Log out of ${provider.name}?`,
                    `Runs ${provider.logout.argv.join(' ')} on this computer and removes its stored sign-in.`,
                  ),
                )
              : this.button(
                  t,
                  `${id}-login`,
                  'Log in',
                  () =>
                    id === 'claude'
                      ? this.startClaude(provider.login.name, provider.login.argv)
                      : this.startAgent(provider.login.name, provider.login.argv),
                  true,
                ),
          ),
      );
    }
    content.child(
      h_flex().child(
        this.button(t, `${id}-refresh`, resource.loading ? 'Checking…' : 'Refresh', cx =>
          this.refreshAccount(cx as AsyncContext, id, true),
        ),
      ),
    );
    const sections = [v_flex().gap(8).child(this.heading(t, 'Sign-in')).child(content)];
    if (id === 'claude') sections.push(this.connectionSection(t));
    else
      sections.push(
        v_flex()
          .gap(8)
          .child(this.heading(t, 'Usage connection'))
          .child(
            div()
              .text_color(t.muted)
              .text_size(12)
              .child(
                'Local reports update after each reply. No connection setup is needed. After switching accounts, the previous report may remain until a new reply.',
              ),
          ),
      );
    return sections;
  }

  renderSettings(t: Theme) {
    const pages: { id: PageId; title: string; icon: string; render: () => Element[] }[] = [
      { id: 'usage', title: 'Usage', icon: 'chart', render: () => this.usagePage(t) },
      { id: 'account', title: 'Claude account', icon: 'user', render: () => this.renderAccount(t, 'claude') },
      { id: 'codex-account', title: 'Codex account', icon: 'user', render: () => this.renderAccount(t, 'codex') },
    ];
    const page = pages.find(p => p.id === this.page) || pages[0];
    const nav = (id: PageId, label: string, icon: string) => {
      const on = this.page === id;
      return h_flex()
        .id(`cu-nav-${id}`)
        .gap(8)
        .items_center()
        .px(8)
        .py(7)
        .rounded(6)
        .cursor_pointer()
        .text_color(on ? t.foreground : t.muted)
        .when(on, el => el.bg(t.selected))
        .hover(s => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          this.page = id;
          if (id === 'usage') this.refreshSessions(cx);
          if (id !== 'usage') this.refreshAccount(cx as AsyncContext, id === 'account' ? 'claude' : 'codex');
          cx.notify();
        })
        .child(this.icon(icon, on ? t.foreground : t.muted, 15))
        .child(label);
    };
    return this.surface(h_flex().size_full(), t.background)
      .text_size(13)
      .text_color(t.foreground)
      .child(
        v_flex()
          .w(176)
          .flex_none()
          .h_full()
          .bg(t.chrome)
          .border_r_1()
          .border_color(t.border)
          .px(10)
          .py(16)
          .gap(2)
          .child(div().px(8).pb(12).font_semibold().child('Usage settings'))
          .children(pages.map(p => nav(p.id, p.title, p.icon))),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .px(24)
          .py(20)
          .gap(18)
          .overflow_y_scrollbar()
          .child(
            h_flex()
              .items_center()
              .child(div().flex_1().text_size(16).font_semibold().child(page.title))
              .child(
                div()
                  .id('cu-close')
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover(s => s.text_color(t.foreground))
                  .on_click(() => this.closeSettings())
                  .child(this.icon('x', t.muted, 14)),
              ),
          )
          .children(page.render()),
      );
  }

  heading(t: Theme, text: string) {
    return div().text_size(11).font_medium().text_color(t.muted).child(text);
  }

  box() {
    return v_flex().gap(10).py(6);
  }

  choice(t: Theme, id: string, label: string, on: boolean, pick: () => void, swatch: Color[] = []) {
    return h_flex()
      .id(id)
      .gap(6)
      .items_center()
      .px(10)
      .py(5)
      .rounded(6)
      .flex_none()
      .cursor_pointer()
      .text_size(12.5)
      .border_1()
      .border_color(on ? t.accent : t.input)
      .bg(on ? t.selected : t.raised)
      .text_color(on ? t.foreground : t.muted)
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        pick();
      })
      .children(swatch.map(color => div().w(9).h(9).rounded(5).flex_none().bg(color).border_1().border_color(t.input)))
      .child(label);
  }

  appearanceSection(t: Theme, set: (patch: Partial<Prefs>) => null) {
    const { style, theme: picked } = prefs();
    const current = ownTheme() ? picked : null;
    const row = (label: string, picks: Element[]) =>
      h_flex()
        .gap(12)
        .items_start()
        .child(div().w(52).flex_none().pt(6).text_size(12).text_color(t.muted).child(label))
        .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().children(picks));
    return v_flex()
      .gap(10)
      .child(this.heading(t, 'Appearance'))
      .child(
        row(
          'Bars',
          STRIP_STYLES.map(s =>
            this.choice(t, `cu-style-${s.id}`, s.label, s.id === style, () => set({ style: s.id })),
          ),
        ),
      )
      .child(
        row('Colors', [
          this.choice(t, 'cu-theme-app', 'Same as Herdr', current === null, () => set({ theme: null })),
          ...themes().map(x =>
            this.choice(t, `cu-theme-${x.name}`, x.name, x.name === current, () => set({ theme: x.name }), [
              x.colors.chrome as Color,
              x.colors.accent as Color,
            ]),
          ),
        ]),
      );
  }

  usagePage(t: Theme) {
    const cols: [string, number | null][] = [
      ['Session', null],
      ['Model', 84],
      ['Output', 64],
      ['Input + cache write', 132],
      ['Cache read', 80],
    ];
    const head = h_flex()
      .gap(8)
      .pb(6)
      .text_size(12)
      .font_medium()
      .text_color(t.muted)
      .children(
        cols.map(([label, w], i) =>
          (w
            ? div()
                .w(w)
                .flex_none()
                .when(i > 1, el => el.text_right())
            : div().flex_1().min_w(0)
          ).child(label),
        ),
      );
    const dot = (status: string) =>
      (({ working: t.working, blocked: t.blocked, done: t.done }) as Record<string, Color>)[status] ?? t.idle;
    const rows = (this.rows ?? []).map(r =>
      h_flex()
        .id(`cu-row-${r.address}`)
        .gap(8)
        .py(8)
        .border_t_1()
        .border_color(t.border)
        .text_size(12)
        .cursor_pointer()
        .hover(s => s.bg(t.hover))
        .on_click(() => {
          run('agent.focus', { terminal: r.address });
          this.closeSettings();
        })
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .gap(8)
            .items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(dot(r.status)))
            .child(div().truncate().child(r.name))
            .child(div().truncate().text_color(t.muted).child(r.space)),
        )
        .child(
          div()
            .w(84)
            .flex_none()
            .text_color(t.muted)
            .child(r.model || '--'),
        )
        .child(div().w(64).flex_none().text_right().child(count(r.output)))
        .child(div().w(132).flex_none().text_right().child(count(r.input)))
        .child(div().w(80).flex_none().text_right().child(count(r.cacheRead))),
    );
    const empty = this.rows == null ? 'Reading transcripts.' : 'No Claude Code sessions in Herdr on this computer.';

    const { warn, urgent, sound } = prefs();
    const set = (patch: Partial<Prefs>) => setShared(PREFS_KEY, { ...prefs(), ...patch });
    const stepper = (id: string, label: string, value: number, min: number, max: number, key: 'warn' | 'urgent') =>
      h_flex()
        .gap(8)
        .items_center()
        .child(label)
        .child(this.button(t, `${id}-down`, '-', () => set({ [key]: Math.max(min, value - 5) })))
        .child(div().w(40).text_right().child(`${value}%`))
        .child(this.button(t, `${id}-up`, '+', () => set({ [key]: Math.min(max, value + 5) })));

    return [
      this.usageOverview(t, this.providers(), true),
      ...(['unlinked', 'signedout'].includes(this.providers()[0].status)
        ? [
            h_flex().child(
              this.button(
                t,
                'usage-connect',
                this.providers()[0].status === 'unlinked' ? 'Connect Claude' : 'Log in to Claude',
                () =>
                  this.providers()[0].status === 'unlinked'
                    ? this.askConnect()
                    : this.startClaude('Claude login', ['claude', 'auth', 'login']),
                true,
              ),
            ),
          ]
        : []),
      this.appearanceSection(t, set),
      v_flex()
        .gap(4)
        .child(this.heading(t, 'Claude sessions on this computer'))
        .when(Boolean(rows.length), el => el.child(v_flex().pt(6).child(head).children(rows)))
        .when(!rows.length && !this.rowsError, el =>
          el.child(div().py(8).text_size(12).text_color(t.muted).child(empty)),
        )
        .when(Boolean(this.rowsError), el =>
          el.child(
            div()
              .py(8)
              .text_size(12)
              .text_color(t.blocked)
              .child(this.rowsError ?? ''),
          ),
        )
        .when(Boolean(rows.length), el =>
          el.child(
            div()
              .pt(6)
              .text_size(12)
              .text_color(t.muted)
              .child('Transcript totals include subagents. Select a session to open its tab.'),
          ),
        ),
      v_flex()
        .gap(10)
        .child(this.heading(t, 'Claude alerts'))
        .child(
          h_flex()
            .gap(20)
            .items_center()
            .flex_wrap()
            .child(stepper('cu-warn', 'Warn at', warn, 50, urgent - 5, 'warn'))
            .child(stepper('cu-urgent', 'Urgent at', urgent, warn + 5, 100, 'urgent'))
            .child(
              h_flex()
                .id('cu-sound')
                .gap(8)
                .items_center()
                .cursor_pointer()
                .on_click(() => set({ sound: !sound }))
                .child(
                  div()
                    .w(14)
                    .h(14)
                    .rounded(3)
                    .border_1()
                    .border_color(t.input)
                    .when(sound, el => el.bg(t.accent)),
                )
                .child('Sound when urgent'),
            ),
        ),
    ];
  }

  connectionSection(t: Theme): Element {
    const link = this.box();
    const l = this.link;
    if (!l) link.child(div().text_color(t.muted).child('Checking.'));
    else if (l.error) link.child(div().text_color(t.blocked).child(l.error));
    else {
      link
        .child(
          h_flex()
            .items_center()
            .gap(12)
            .child(
              h_flex()
                .flex_1()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .w(7)
                    .h(7)
                    .rounded(4)
                    .flex_none()
                    .bg(l.connected ? t.done : t.idle),
                )
                .child(
                  div()
                    .font_medium()
                    .child(l.connected ? 'Connected' : 'Not connected'),
                )
                .child(
                  div()
                    .text_color(t.muted)
                    .child(l.connected ? 'limits arrive after each reply' : ''),
                ),
            )
            .child(
              this.busy.link
                ? div().text_color(t.muted).child('Working')
                : l.connected
                  ? this.button(t, 'cu-disconnect', 'Disconnect', () =>
                      this.ask(
                        'disconnect',
                        'Disconnect Claude Code?',
                        'Takes the script out of your statusline command. The strip stops getting your plan limits.',
                      ),
                    )
                  : this.button(t, 'cu-connect-a', 'Connect', () => this.askConnect(), true),
            ),
        )
        .child(
          div()
            .text_color(t.muted)
            .child(
              'Claude Code gives your statusline your plan limits. The mod saves them, then passes them on to your own statusline command, so your statusline looks the same.',
            ),
        )
        .child(
          v_flex()
            .gap(4)
            .p(10)
            .rounded(6)
            .bg(t.chrome)
            .text_size(12)
            .child(
              h_flex()
                .gap(8)
                .child(
                  div()
                    .w(72)
                    .flex_none()
                    .text_color(t.muted)
                    .child(l.connected ? 'statusline' : 'changes to'),
                )
                .child(div().truncate().child(tilde(tapPath()))),
            )
            .child(
              h_flex()
                .gap(8)
                .child(div().w(72).flex_none().text_color(t.muted).child('then runs'))
                .child(
                  div()
                    .truncate()
                    .child(this.original || 'nothing, you have no statusline'),
                ),
            ),
        )
        .child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(`It edits ${tilde(l.path)}. Edit your command there, and Disconnect keeps your edit.`),
        );
    }
    for (const e of [this.error, this.store.connection.error].filter((e): e is string => Boolean(e)))
      link.child(div().text_size(12).text_color(t.blocked).child(e));

    return v_flex().gap(10).child(this.heading(t, 'Claude Code connection')).child(link);
  }
}
