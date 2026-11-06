import type { Endpoints } from './core/discovery.js';
import { BridgeError, isBridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { readJson, storageKey, type BridgeStorage } from './core/storage.js';
import { Emitter, Store, readJwtPayload, type Readable } from './core/util.js';

/**
 * The session: who is signed in on this device, and the tokens that prove it.
 *
 * - The access token lives in memory only, for its five minutes.
 * - The refresh token and the ID token are kept in storage, so a reload stays
 *   signed in. Bridge replaces the refresh token on every use; an old one
 *   used again after a short grace ends the session, because that means it
 *   was copied.
 * - Tabs share one session. Only one tab refreshes at a time (Web Locks), and
 *   it hands the new access token to the others (BroadcastChannel), so two
 *   tabs never spend the same refresh token.
 * - A failed refresh says why: `signed-out` when the session ended, and
 *   `network` or `unavailable` when Bridge could not be reached, which keeps
 *   the session and tries again.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export interface SessionWorkspace {
  readonly id: string;
  /** The workspace's standing, such as `active` or `suspended`. A workspace that is not active can only read. */
  readonly standing: string | null;
}

/** Why the session is signed out. */
export type SignedOutReason =
  /** Nobody has signed in on this device. */
  | 'never-signed-in'
  /** The person signed out, here or in another tab. */
  | 'signed-out'
  /** Bridge ended the session: it expired, was ended from another device, or its password was reset. */
  | 'session-ended';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out'; readonly reason: SignedOutReason }
  | { readonly status: 'signed-in'; readonly user: SessionUser; readonly workspace: SessionWorkspace | null };

export type SignedInState = Extract<SessionState, { status: 'signed-in' }>;

export interface SessionEvents {
  [name: string]: unknown;
  'signed-in': SignedInState;
  'signed-out': { readonly reason: SignedOutReason };
  'workspace-changed': { readonly workspace: SessionWorkspace | null };
  /** Another tab moved this session to another workspace, and this tab was told not to follow (`otherTabWorkspace: 'stale'`). */
  'session-stale': { readonly workspace: string | null };
  'token-refreshed': { readonly expiresAt: number };
  error: unknown;
}

/** The token endpoint's answer. */
export interface TokenAnswer {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly workspace?: string;
}

/** The parts of Web Locks the session uses. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** The parts of BroadcastChannel the session uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface SessionOptions {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly storage: BridgeStorage;
  /** Refresh shortly before the access token expires, while the page is visible. @default true in a browser */
  readonly autoRefresh?: boolean;
  /** When another tab switches workspace: follow it, or raise `session-stale` and stay. @default 'follow' */
  readonly otherTabWorkspace?: 'follow' | 'stale';
  /** Web Locks. @default navigator.locks when there is one */
  readonly locks?: LockManagerLike | null;
  /** Makes the channel tabs talk on. @default BroadcastChannel when there is one */
  readonly channel?: ((name: string) => ChannelLike) | null;
  readonly now?: () => number;
}

interface Stored {
  readonly refreshToken: string;
  readonly idToken: string | null;
  readonly workspace: SessionWorkspace | null;
}

interface Access {
  readonly token: string;
  readonly expiresAt: number;
}

type TabMessage =
  | { readonly type: 'tokens'; readonly access: Access; readonly idToken: string | null; readonly workspace: SessionWorkspace | null }
  | { readonly type: 'signed-out'; readonly reason: SignedOutReason };

/** Refresh when less than this is left. */
const REFRESH_MARGIN_MS = 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

function signedOut(message = 'Nobody is signed in.'): BridgeError {
  return new BridgeError('signed-out', message, { status: 401 });
}

function defaultLocks(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return locks !== undefined && typeof locks.request === 'function' ? locks : null;
}

function defaultChannel(): ((name: string) => ChannelLike) | null {
  const Channel = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
  return Channel === undefined ? null : (name) => new Channel(name);
}

function isTokenAnswer(value: unknown): value is TokenAnswer {
  const answer = value as Partial<TokenAnswer> | null;
  return typeof answer?.access_token === 'string' && typeof answer.expires_in === 'number';
}

function userFrom(idToken: string | null, accessToken: string): SessionUser | null {
  const claims = readJwtPayload(idToken) ?? readJwtPayload(accessToken);
  if (claims === null || typeof claims['sub'] !== 'string') return null;
  return {
    id: claims['sub'],
    email: typeof claims['email'] === 'string' ? claims['email'] : null,
    emailVerified: claims['email_verified'] === true,
  };
}

function workspaceFrom(answer: TokenAnswer): SessionWorkspace | null {
  const claims = readJwtPayload(answer.access_token);
  const id = answer.workspace ?? (typeof claims?.['tid'] === 'string' ? claims['tid'] : null);
  if (id === null) return null;
  return { id, standing: typeof claims?.['wst'] === 'string' ? claims['wst'] : null };
}

export class Session {
  readonly events = new Emitter<SessionEvents>();
  private readonly store = new Store<SessionState>({ status: 'loading' });
  private readonly key: string;
  private readonly lockName: string;
  private readonly now: () => number;
  private readonly locks: LockManagerLike | null;
  private readonly channel: ChannelLike | null;
  private access: Access | null = null;
  private generation = 0;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MIN_MS;
  private restoring: Promise<void> | null = null;
  private destroyed = false;
  private readonly onVisible = () => {
    if (this.isVisible() && this.store.get().status === 'signed-in' && !this.accessFresh()) void this.refreshInBackground();
  };
  private readonly onStorage = (event: { key: string | null; newValue: string | null }) => {
    if (event.key === this.key && event.newValue === null && this.store.get().status === 'signed-in') this.endLocally('signed-out', false);
  };

  constructor(private readonly options: SessionOptions) {
    this.key = storageKey(options.issuer, 'session');
    this.lockName = storageKey(options.issuer, 'refresh');
    this.now = options.now ?? Date.now;
    this.locks = options.locks === undefined ? defaultLocks() : options.locks;
    const makeChannel = options.channel === undefined ? defaultChannel() : options.channel;
    this.channel = makeChannel === null ? null : makeChannel(storageKey(options.issuer, 'tabs'));
    if (this.channel !== null) this.channel.onmessage = (event) => this.fromOtherTab(event.data as TabMessage);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      if (this.channel === null) window.addEventListener('storage', this.onStorage as unknown as EventListener);
      if (this.autoRefresh && typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  /** The session now, to read and watch. */
  get state(): Readable<SessionState> {
    return this.store;
  }

  private get autoRefresh(): boolean {
    return this.options.autoRefresh ?? (typeof document !== 'undefined');
  }

  /** Loads the stored session and gets a fresh access token for it. */
  restore(): Promise<void> {
    this.restoring ??= this.doRestore();
    return this.restoring;
  }

  private async doRestore(): Promise<void> {
    const stored = await this.read();
    if (stored === null) {
      this.store.set({ status: 'signed-out', reason: 'never-signed-in' });
      return;
    }
    try {
      await this.refresh();
    } catch (error) {
      if (isBridgeError(error, 'signed-out')) return;
      // Bridge could not be reached: stay signed in on what is stored, and try again.
      const user = userFrom(stored.idToken, '');
      if (user === null) {
        this.endLocally('session-ended', false);
        return;
      }
      this.store.set({ status: 'signed-in', user, workspace: stored.workspace });
      this.events.emit('error', error);
      this.scheduleRetry();
    }
  }

  /** A valid access token, refreshed first when it is close to expiring. Throws `signed-out` when there is no session. */
  async accessToken(): Promise<string> {
    if (this.store.get().status === 'loading') await this.restore();
    if (this.store.get().status === 'signed-out') throw signedOut();
    if (this.accessFresh()) return (this.access as Access).token;
    await this.refresh();
    if (this.access === null) throw signedOut();
    return this.access.token;
  }

  /** The access token if one is held, without refreshing. */
  currentAccessToken(): string | null {
    return this.access !== null && this.access.expiresAt > this.now() ? this.access.token : null;
  }

  /**
   * Gets new tokens with the refresh token. With `workspace`, the new tokens
   * are for that workspace: this is how a person switches. With `force`, it
   * refreshes even when the access token is still fresh (after a 401).
   */
  refresh(options: { readonly workspace?: string; readonly force?: boolean } = {}): Promise<void> {
    if (options.workspace === undefined && this.inflight !== null) return this.inflight;
    const seen = this.generation;
    const run = this.withLock(() => this.refreshLocked(options, seen));
    if (options.workspace !== undefined) return run;
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refreshLocked(options: { readonly workspace?: string; readonly force?: boolean }, seen: number): Promise<void> {
    // Another tab refreshed while this one waited for the lock, and handed over its access token.
    if (options.workspace === undefined && !options.force && this.generation !== seen && this.accessFresh()) return;
    const stored = await this.read();
    if (stored === null) {
      this.endLocally(this.store.get().status === 'signed-in' ? 'signed-out' : 'never-signed-in', false);
      throw signedOut();
    }
    const grant = (refreshToken: string) =>
      this.tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken, ...(options.workspace === undefined ? {} : { workspace: options.workspace }) });
    let answer: TokenAnswer;
    try {
      answer = await grant(stored.refreshToken);
    } catch (error) {
      if (!isBridgeError(error, 'signed-out')) throw error;
      // Without Web Locks another tab may have spent this refresh token a moment ago: try the one it stored.
      const again = await this.read();
      if (again === null || again.refreshToken === stored.refreshToken) {
        this.endLocally('session-ended', true);
        throw error;
      }
      try {
        answer = await grant(again.refreshToken);
      } catch (retryError) {
        if (isBridgeError(retryError, 'signed-out')) this.endLocally('session-ended', true);
        throw retryError;
      }
    }
    await this.adopt(answer, stored.idToken);
  }

  /** Trades an authorization code and its PKCE verifier for tokens: the last step of every sign-in. */
  async exchangeCode(code: string, verifier: string): Promise<void> {
    const answer = await this.tokenCall({ grant_type: 'authorization_code', code, code_verifier: verifier });
    await this.adopt(answer, null);
  }

  /**
   * Signs out: the session ends at Bridge, so its tokens are refused
   * everywhere within seconds, and this device and every tab forget it.
   * Never throws; the session is forgotten here even when Bridge cannot be
   * reached.
   */
  async signOut(): Promise<void> {
    const stored = await this.read();
    const token = this.currentAccessToken();
    let ended = false;
    if (token !== null && this.options.endpoints().offers(ROUTES.signOut)) {
      try {
        await call(this.options.fetch, this.options.endpoints().url(ROUTES.signOut), { method: 'POST', token });
        ended = true;
      } catch {
        // Revoking the refresh token below ends the session as well.
      }
    }
    if (!ended && stored !== null) {
      try {
        await call(this.options.fetch, this.options.endpoints().url(ROUTES.revoke), { method: 'POST', body: { token: stored.refreshToken, token_type_hint: 'refresh_token' } });
      } catch {
        // Forgotten here regardless.
      }
    }
    this.endLocally('signed-out', true);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    this.channel?.close();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('storage', this.onStorage as unknown as EventListener);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    }
    this.events.clear();
  }

  private async tokenCall(body: Readonly<Record<string, unknown>>): Promise<TokenAnswer> {
    const answer = await call<unknown>(this.options.fetch, this.options.endpoints().url(ROUTES.token), { method: 'POST', body });
    if (!isTokenAnswer(answer.body)) throw new BridgeError('unavailable', 'The token endpoint gave an answer this SDK cannot read.', { status: answer.status });
    return answer.body;
  }

  private async adopt(answer: TokenAnswer, previousIdToken: string | null): Promise<void> {
    const idToken = answer.id_token ?? previousIdToken;
    const user = userFrom(idToken, answer.access_token);
    if (user === null) throw new BridgeError('unavailable', 'The token endpoint gave tokens that name nobody.');
    const workspace = workspaceFrom(answer);
    if (answer.refresh_token !== undefined) {
      const record: Stored = { refreshToken: answer.refresh_token, idToken, workspace };
      await this.options.storage.set(this.key, JSON.stringify(record));
    }
    const access: Access = { token: answer.access_token, expiresAt: this.now() + answer.expires_in * 1000 };
    this.take(access, user, workspace);
    this.channel?.postMessage({ type: 'tokens', access, idToken, workspace } satisfies TabMessage);
  }

  /** Holds new tokens and says what changed. */
  private take(access: Access, user: SessionUser, workspace: SessionWorkspace | null): void {
    const before = this.store.get();
    this.access = access;
    this.generation += 1;
    this.retryMs = RETRY_MIN_MS;
    const state: SignedInState = { status: 'signed-in', user, workspace };
    this.store.set(state);
    if (before.status !== 'signed-in' || before.user.id !== user.id) this.events.emit('signed-in', state);
    else if ((before.workspace?.id ?? null) !== (workspace?.id ?? null)) this.events.emit('workspace-changed', { workspace });
    this.events.emit('token-refreshed', { expiresAt: access.expiresAt });
    this.schedule();
  }

  private fromOtherTab(message: TabMessage): void {
    if (this.destroyed || message === null || typeof message !== 'object') return;
    if (message.type === 'signed-out') {
      if (this.store.get().status !== 'signed-out') this.endLocally(message.reason, false);
      return;
    }
    if (message.type !== 'tokens') return;
    const user = userFrom(message.idToken, message.access.token);
    if (user === null) return;
    const before = this.store.get();
    const otherWorkspace = message.workspace?.id ?? null;
    if (before.status === 'signed-in' && before.user.id === user.id && (before.workspace?.id ?? null) !== otherWorkspace && this.options.otherTabWorkspace === 'stale') {
      // Its tokens are for another workspace: keep this tab's until the person decides.
      this.events.emit('session-stale', { workspace: otherWorkspace });
      return;
    }
    this.take(message.access, user, message.workspace);
  }

  private endLocally(reason: SignedOutReason, tellOtherTabs: boolean): void {
    const before = this.store.get();
    this.clearTimer();
    this.access = null;
    this.generation += 1;
    void this.options.storage.remove(this.key);
    this.store.set({ status: 'signed-out', reason });
    if (before.status === 'signed-in') this.events.emit('signed-out', { reason });
    if (tellOtherTabs) this.channel?.postMessage({ type: 'signed-out', reason } satisfies TabMessage);
  }

  private async read(): Promise<Stored | null> {
    const stored = await readJson<Stored>(this.options.storage, this.key);
    return stored !== null && typeof stored.refreshToken === 'string' ? stored : null;
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.locks === null ? work() : this.locks.request(this.lockName, work);
  }

  private accessFresh(): boolean {
    return this.access !== null && this.access.expiresAt - this.now() > REFRESH_MARGIN_MS;
  }

  private isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.autoRefresh || this.destroyed || this.access === null) return;
    const wait = Math.max(1_000, this.access.expiresAt - this.now() - REFRESH_MARGIN_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      // A hidden tab does not keep the session alive: it refreshes when it is looked at again.
      if (this.isVisible()) void this.refreshInBackground();
    }, wait);
  }

  private async refreshInBackground(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      if (isBridgeError(error, 'signed-out')) return;
      this.events.emit('error', error);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    this.clearTimer();
    if (!this.autoRefresh || this.destroyed) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isVisible()) void this.refreshInBackground();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
