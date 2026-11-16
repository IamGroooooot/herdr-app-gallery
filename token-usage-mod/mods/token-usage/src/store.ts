import { Resource } from './resource.js';
import type { AccountState, Connection, ProviderId, UsageProvider, UsageReport } from './types.js';

export interface StoreIO {
  connection(account: AccountState | null): Promise<Connection>;
  accountChanged(): Promise<void>;
  claudeIdentity?: { read(): string | null; write(identity: string): void };
}
/** One store per mod source version; views own timers, never provider state. */
export class UsageStore {
  readonly accounts: Record<ProviderId, Resource<AccountState>>;
  readonly usage: Record<ProviderId, Resource<UsageReport>>;
  readonly connection: Resource<Connection>;
  private readonly lastIdentity: Partial<Record<ProviderId, string>> = {};
  private readonly watchUntil: Record<ProviderId, number> = { claude: 0, codex: 0 };

  constructor(readonly providers: Record<ProviderId, UsageProvider>, io: StoreIO,
    private readonly clock = Date.now, changed: () => void = () => {}) {
    const remembered = io.claudeIdentity?.read();
    if (remembered) this.lastIdentity.claude = remembered;
    this.usage = {
      claude: new Resource(providers.claude.readUsage, clock, changed),
      codex: new Resource(providers.codex.readUsage, clock, changed),
    };
    const account = (id: ProviderId) => new Resource(async () => {
      const next = await providers[id].readAccount();
      const previous = this.accounts[id].value;
      const identity = next.kind === 'signed-in' ? next.context?.identity : undefined;
      const switched = Boolean(identity && this.lastIdentity[id] && this.lastIdentity[id] !== identity);
      if (switched || previous?.kind !== next.kind) {
        this.usage[id].invalidate();
        if (id === 'claude') this.connection.invalidate();
        if (switched && id === 'claude') await io.accountChanged();
      }
      if (identity) {
        this.lastIdentity[id] = identity;
        if (id === "claude") io.claudeIdentity?.write(identity);
      }
      return next;
    }, clock, changed);
    this.accounts = { claude: account('claude'), codex: account('codex') };
    this.connection = new Resource(async () => {
      const result = await io.connection(this.accounts.claude.value);
      if (result.error) throw new Error(result.error);
      return result;
    }, clock, changed);
  }

  async poll(): Promise<void> {
    await Promise.all((['claude', 'codex'] as const).map(async id => {
      const a = this.accounts[id];
      const fast = a.error || !a.value || a.value.kind === 'signed-out' || this.clock() < this.watchUntil[id];
      await a.refresh(fast ? 10000 : 300000);
      if (id === 'claude' && a.value && a.value.kind !== 'unavailable') await this.connection.refresh(10000);
      if (a.value?.kind === 'signed-in') await this.usage[id].refresh(id === 'claude' ? 10000 : 15000);
    }));
  }

  async refreshAccount(id: ProviderId, force = false): Promise<void> {
    await this.accounts[id].refresh(force ? 0 : 10000);
    if (id === 'claude') await this.connection.refresh(force ? 0 : 10000);
  }

  watchAccount(id: ProviderId): void { this.watchUntil[id] = this.clock() + 120000; }

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
