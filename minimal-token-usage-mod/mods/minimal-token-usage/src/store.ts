import { Resource } from './resource.js';
import type { AccountState, Connection, ConnectionResult, ProviderId, UsageProvider, UsageReport } from './types.js';

export interface StoreIO {
  connection(account: AccountState | null): Promise<ConnectionResult>;
  accountChanged(): Promise<void>;
  /** The identity last seen in a Claude config folder, kept across restarts. */
  claudeIdentity?: { read(directory: string): string | null; write(directory: string, identity: string): void };
  /** `ClaudeLimits.sessionConfigDir` of the saved reports. */
  sessionConfigDir?(): Promise<string | null>;
}
export class UsageStore {
  readonly accounts: Record<ProviderId, Resource<AccountState>>;
  readonly usage: Record<ProviderId, Resource<UsageReport>>;
  readonly connection: Resource<Connection>;
  private readonly sessionConfigDir: Resource<string | null>;
  /** Keyed by provider and config folder: two folders hold two accounts, and neither replaces the other. */
  private readonly lastIdentity = new Map<string, string>();
  private readonly watchUntil: Record<ProviderId, number> = { claude: 0, codex: 0 };

  constructor(
    readonly providers: Record<ProviderId, UsageProvider>,
    io: StoreIO,
    private readonly clock = Date.now,
    changed: () => void = () => {},
  ) {
    this.sessionConfigDir = new Resource(async () => (await io.sessionConfigDir?.()) ?? null, clock);
    this.usage = {
      claude: new Resource(providers.claude.readUsage, clock, changed),
      codex: new Resource(providers.codex.readUsage, clock, changed),
    };
    const account = (id: ProviderId) =>
      new Resource(
        async () => {
          const next = await providers[id].readAccount();
          const previous = this.accounts[id].value;
          const identity = next.kind === 'signed-in' ? next.context?.identity : undefined;
          const directory = next.context?.configDirectory ?? '';
          const key = `${id}:${directory}`;
          const last = this.lastIdentity.get(key) ?? (id === 'claude' ? io.claudeIdentity?.read(directory) : null);
          const switched = Boolean(identity && last && last !== identity);
          if (switched || previous?.kind !== next.kind) {
            this.usage[id].invalidate();
            if (id === 'claude') this.connection.invalidate();
            if (switched && id === 'claude') await io.accountChanged();
          }
          if (identity && identity !== last) {
            this.lastIdentity.set(key, identity);
            if (id === 'claude') io.claudeIdentity?.write(directory, identity);
          }
          return next;
        },
        clock,
        changed,
      );
    this.accounts = { claude: account('claude'), codex: account('codex') };
    this.connection = new Resource(
      async () => {
        const result = await io.connection(this.accounts.claude.value);
        if (result.error !== undefined) throw new Error(result.error);
        return result;
      },
      clock,
      changed,
    );
  }

  async poll(): Promise<void> {
    await this.followSession();
    await Promise.all(
      (['claude', 'codex'] as const).map(async id => {
        const a = this.accounts[id];
        const fast = a.error || !a.value || a.value.kind === 'signed-out' || this.clock() < this.watchUntil[id];
        await a.refresh(fast ? 10000 : 300000);
        if (id === 'claude' && a.value && a.value.kind !== 'unavailable') await this.connection.refresh(10000);
        if (a.value?.kind === 'signed-in') await this.usage[id].refresh(id === 'claude' ? 10000 : 15000);
      }),
    );
  }

  /** A reply from a session under another `CLAUDE_CONFIG_DIR` makes that folder's account the one shown. */
  private async followSession(): Promise<void> {
    const latest = this.sessionConfigDir;
    await latest.refresh(10000);
    const account = this.accounts.claude;
    if (latest.checkedAt === null || latest.error || !account.value || account.loading) return;
    if ((account.value.context?.sessionConfigDir ?? null) !== latest.value) account.invalidate();
  }

  async refreshAccount(id: ProviderId, force = false): Promise<void> {
    await this.accounts[id].refresh(force ? 0 : 10000);
    if (id === 'claude') await this.connection.refresh(force ? 0 : 10000);
  }

  watchAccount(id: ProviderId): void {
    this.watchUntil[id] = this.clock() + 120000;
  }

  async connectionChanged(): Promise<void> {
    this.connection.invalidate();
    await this.connection.refresh();
  }
}

/** Synchronous read-and-write: a claim is recorded before any notification. */
export function claimAlert(read: () => readonly string[], write: (keys: string[]) => void, key: string): boolean {
  const keys = read();
  if (keys.includes(key)) return false;
  write([...keys, key].slice(-400));
  return true;
}
