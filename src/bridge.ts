import { createAccounts } from './accounts.js';
import { createBilling } from './billing.js';
import { discover, type Endpoints, type IssuerMetadata } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { platformFetch, type Fetch } from './core/http.js';
import { defaultStorage, type BridgeStorage } from './core/storage.js';
import { Emitter, type Readable } from './core/util.js';
import { Flags } from './flags.js';
import { Live, MANY_CHANGED, type LiveNotice, type LiveOptions, type LiveStatus } from './live.js';
import { Session, type ChannelLike, type LockManagerLike, type SessionEvents, type SessionState } from './session.js';
import { createSignIn } from './sign-in.js';

export interface BridgeOptions {
  /**
   * The issuer: the one address the SDK needs. Copy it from the app's
   * settings in Bridge. Every endpoint is read from its metadata.
   */
  readonly issuer: string;
  /** Where the session is kept between page loads. @default localStorage in a browser, memory elsewhere */
  readonly storage?: BridgeStorage;
  /** The fetch to call Bridge with. @default the platform fetch */
  readonly fetch?: Fetch;
  /** Live updates. `false` turns them off. */
  readonly live?: LiveOptions | false;
  /** Fetch flag results as soon as the SDK is ready. @default true */
  readonly loadFlags?: boolean;
  /** Refresh tokens shortly before they expire, while the page is visible. @default true in a browser */
  readonly autoRefresh?: boolean;
  /** When another tab switches workspace: follow it, or raise `session-stale`. @default 'follow' */
  readonly otherTabWorkspace?: 'follow' | 'stale';
  /** For tests: Web Locks, or null for none. */
  readonly locks?: LockManagerLike | null;
  /** For tests: how tabs talk, or null for not at all. */
  readonly tabChannel?: ((name: string) => ChannelLike) | null;
}

export type BridgeEvents = SessionEvents & {
  /** A Live notice: something changed, fetch it again if it is on screen. */
  notice: LiveNotice;
};

/** Notices after which flag results may differ. */
const FLAG_NOTICES = new Set(['flags.revision_changed', 'accounts.member_updated', 'accounts.workspace_updated', MANY_CHANGED]);

type AsyncFn = (...args: never[]) => Promise<unknown>;

/** Every function of `api`, waiting for `ready` first, so calls made early wait instead of failing. */
function afterReady<T extends object>(api: T, ready: Promise<void>): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(api)) {
    if (typeof value === 'function') {
      wrapped[name] = async (...args: never[]) => {
        await ready;
        return (value as AsyncFn)(...args);
      };
    } else if (value !== null && typeof value === 'object') {
      wrapped[name] = afterReady(value as object, ready);
    } else {
      wrapped[name] = value;
    }
  }
  return wrapped as T;
}

/**
 * Makes the Bridge client for one issuer. Make one per page (or per app),
 * and share it.
 *
 * ```ts
 * const bridge = createBridge({ issuer: 'https://…' });
 * await bridge.ready;
 * const step = await bridge.signIn.start({ email, password });
 * if (!step.done) await step.choose(step.workspaces[0].id);
 * if (bridge.flags.enabled('reports')) showReports();
 * ```
 */
export function createBridge(options: BridgeOptions) {
  if (typeof options?.issuer !== 'string' || options.issuer === '') throw new BridgeError('misconfigured', 'createBridge needs the issuer: the address from the app\'s settings in Bridge.');
  const issuer = options.issuer;
  const fetchFn = options.fetch ?? platformFetch();
  const storage = options.storage ?? defaultStorage();
  const events = new Emitter<BridgeEvents>();
  let resolved: Endpoints | null = null;
  const endpoints = (): Endpoints => {
    if (resolved === null) throw new BridgeError('misconfigured', 'The SDK is not ready yet: wait for `bridge.ready`.');
    return resolved;
  };
  const onError = (error: unknown) => events.emit('error', error);

  const session = new Session({
    issuer,
    endpoints,
    fetch: fetchFn,
    storage,
    ...(options.autoRefresh === undefined ? {} : { autoRefresh: options.autoRefresh }),
    ...(options.otherTabWorkspace === undefined ? {} : { otherTabWorkspace: options.otherTabWorkspace }),
    ...(options.locks === undefined ? {} : { locks: options.locks }),
    ...(options.tabChannel === undefined ? {} : { channel: options.tabChannel }),
  });
  const flags = new Flags({ issuer, endpoints, fetch: fetchFn, storage, session, onError });
  const live = new Live({ endpoints, fetch: fetchFn, session, onError }, options.live === false ? { enabled: false } : (options.live ?? {}));
  const flows = createSignIn({ issuer, endpoints, fetch: fetchFn, storage, session });
  const accounts = createAccounts({ endpoints, fetch: fetchFn, session });
  const billing = createBilling({ endpoints, fetch: fetchFn, session, changed: () => void flags.load() });

  let started = false;
  const whoChanged = () => {
    flags.reset();
    void flags.load();
    if (started) void live.start();
  };
  for (const name of ['signed-in', 'signed-out', 'workspace-changed', 'session-stale', 'token-refreshed', 'error'] as const) {
    session.events.on(name, (value) => events.emit(name, value as never));
  }
  session.events.on('signed-in', whoChanged);
  session.events.on('signed-out', whoChanged);
  session.events.on('workspace-changed', whoChanged);
  live.on('*', (notice) => {
    events.emit('notice', notice);
    if (FLAG_NOTICES.has(notice.type) || notice.type.startsWith('billing.')) void flags.load();
    // This session was ended elsewhere: find out now rather than at the next refresh.
    if (notice.type === 'identity.signed_out') void session.refresh({ force: true }).catch(() => undefined);
  });

  const ready = (async () => {
    resolved = await discover(issuer, fetchFn);
    await session.restore();
    if (options.loadFlags !== false) await flags.load();
    started = true;
    void live.start();
  })();
  // A failed start is reported through `ready`; never as an unhandled rejection.
  ready.catch(onError);

  /**
   * `fetch` for the Child App's own API: adds the person's access token, and
   * after a 401 refreshes once and tries again. A request body that is a
   * stream cannot be sent twice, so it is not retried.
   */
  async function bridgeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    await ready;
    const withToken = (token: string): RequestInit => {
      const headers = new Headers(init.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${token}`);
      return { ...init, headers };
    };
    const retryable = !(typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream);
    const again = typeof Request !== 'undefined' && input instanceof Request && retryable ? input.clone() : input;
    const first = await fetchFn(input, withToken(await session.accessToken()));
    if (first.status !== 401 || !retryable) return first;
    try {
      await session.refresh({ force: true });
    } catch {
      return first;
    }
    return fetchFn(again, withToken(await session.accessToken()));
  }

  return {
    issuer,
    /** Resolves once the issuer's metadata is read and any stored session is restored. */
    ready,
    /** Who is signed in. */
    session: session.state as Readable<SessionState>,
    /** What the issuer published. Available once `ready` resolves. */
    metadata: (): IssuerMetadata => endpoints().metadata,
    ...afterReady(
      {
        signIn: flows.signIn,
        signUp: flows.signUp,
        password: flows.password,
        invites: flows.invites,
        workspaces: accounts.workspaces,
        me: accounts.me,
        team: accounts.team,
        sessions: accounts.sessions,
        billing,
        /** Signs out here, in every tab, and at Bridge. */
        signOut: () => session.signOut(),
        /** The person's access token, for calling the Child App's own API by hand. Prefer `fetch`. */
        token: () => session.accessToken(),
      },
      ready,
    ),
    flags,
    live: {
      status: live.status as Readable<LiveStatus>,
      on: (type: string, listener: (notice: LiveNotice) => void) => live.on(type, listener),
    },
    fetch: bridgeFetch,
    on<K extends keyof BridgeEvents & string>(name: K, listener: (value: BridgeEvents[K]) => void): () => void {
      return events.on(name, listener);
    },
    /** Stops timers, Live and tab messages. */
    destroy(): void {
      live.stop();
      session.destroy();
      events.clear();
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
