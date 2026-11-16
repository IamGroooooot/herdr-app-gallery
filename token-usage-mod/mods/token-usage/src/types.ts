export type ProviderId = 'claude' | 'codex';
export type PageId = 'usage' | 'account' | 'codex-account';
export type ConfirmAction = 'connect' | 'disconnect' | 'logout' | 'codexlogout';
export interface Limit { readonly used: number; readonly resets: number }
export interface UsageWindow extends Limit { key: string; label: string }
export interface SessionRef { transcript: string | null; model: string | null }
export interface UsageReport { windows: readonly UsageWindow[]; sessions: ReadonlyMap<string, SessionRef>; reportedAt: number | null }
export type AccountState = { context?: { configDirectory?: string; projectsDirectory?: string; identity?: string } } & (
  | { kind: 'signed-in'; method: string; email?: string; plan?: string; expiresAt?: string }
  | { kind: 'signed-out' }
  | { kind: 'unavailable'; reason: string });
export interface AccountCommand { name: string; argv: string[] }
export interface UsageProvider {
  readonly id: ProviderId;
  readonly name: string;
  readUsage(): Promise<UsageReport>;
  readAccount(): Promise<AccountState>;
  readonly login: AccountCommand;
  readonly logout: AccountCommand;
}
export interface ClaudeAuth {
  loggedIn?: boolean; missing?: boolean; error?: string; configDirectory?: string; projectsDirectory?: string;
  email?: string; orgId?: string; authMethod?: string; subscriptionType?: string; loginExpiresAt?: string;
}
export interface ClaudeLimits { windows: Record<string, Limit>; sessions: Map<string,SessionRef>; reports: number; reportedAt: number | null }
export interface Connection {
  path?: string; error?: string; connected?: boolean; legacy?: boolean; command?: string;
  text?: string; settings?: { statusLine?: { type?: string; command?: string; [key: string]: unknown }; [key: string]: unknown };
}
export interface Tokens { output: number; input: number; cacheRead: number; model: string | null }
export interface SessionRow extends Tokens { address: string; name: string; space: string; status: string }
export interface Prefs { warn: number; urgent: number; sound: boolean }
export interface DisplayProvider {
  status: "ready" | "loading" | "error" | "signedout" | "missing" | "unlinked" | "waiting" | "nolimits";
  id: string; name: string; at: number | null; error: string | null; stale: boolean;
  message?: string; detail?: string; windows: readonly UsageWindow[];
}
