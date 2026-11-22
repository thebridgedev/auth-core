import { createAccounts } from './accounts.js';
import { createBilling } from './billing.js';
import { BillingGate, watchLock, type BillingGateState } from './billing-gate.js';
import { Discovery, type DiscoveryOptions, type Endpoints, type IssuerMetadata } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { platformFetch, type Fetch } from './core/http.js';
import { defaultStorage, type BridgeStorage } from './core/storage.js';
import { originOf, secureUrl } from './core/urls.js';
import { Emitter, type Readable } from './core/util.js';
import { createEntitlements } from './entitlements.js';
import { Flags } from './flags.js';
import type { QuotaSnapshot } from './quota.js';
import { Live, MANY_CHANGED, type LiveNotice, type LiveOptions, type LiveStatus } from './live.js';
import { QuotaStore } from './quota-store.js';
import { QuotaEvents, type BillingEventHandlers } from './quota-events.js';
import { Session, type ChannelLike, type LockManagerLike, type SessionEvents, type SessionState } from './session.js';
import { browserCeremonies, type WebAuthnCeremonies } from './passkeys.js';
import { createRecheck } from './recheck.js';
import { createHosted } from './hosted.js';
import { createSignIn } from './sign-in.js';

export interface BridgeOptions {
  /**
   * The issuer: the one address the SDK needs. Copy it from the app's
   * settings in Bridge. Every endpoint is read from its metadata.
   */
  readonly issuer: string;
  /** Where the session is kept between page loads. @default localStorage in a browser, memory elsewhere */
  readonly storage?: BridgeStorage;
  /**
   * Where the PKCE verifier of a sign-up, or of a sign-in link, waits for
   * its email link, at most 15 minutes, as long as the link works. The link
   * usually opens in a new tab, so this must be storage every tab of the
   * page's origin shares: with `storage: memoryStorage()`, pass
   * `localStorageAdapter()` here, or the link only works in the tab that
   * asked for it. Nothing else is kept here; the verifier is removed once
   * the link is used, and when found expired. A passkey setup link's
   * verifier waits here too, as long as that link works (24 hours).
   * @default `storage`
   */
  readonly signUpStorage?: BridgeStorage;
  /**
   * Where the links in sign-up, sign-in link and recovery emails go: one of
   * the app's registered email-links addresses, exactly, usually the page
   * that runs these flows. Needed when the app has several sign-in pages
   * (its own and Bridge's hosted page). Bridge refuses an address the app
   * did not register. @default the app's first email-links address
   */
  readonly linkAddress?: string;
  /**
   * The language of the screen the person is on, as a language tag (`da`, `nb`, `sv-SE`), or a function that gives it
   * when asked. Sent with sign-up, sign-in link, password recovery, passkey setup and confirm-it-is-you requests, so
   * Bridge writes the email in it: without one the email follows the person's own language, then the workspace's, then
   * English. A value that is not a language tag is left out.
   */
  readonly language?: string | (() => string | undefined);
  /** The browser's side of passkey ceremonies. @default `@simplewebauthn/browser` */
  readonly webauthn?: WebAuthnCeremonies;
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
  /**
   * Other origins `bridge.fetch` may send the person's token to, such as
   * your API on its own host (`https://api.example.com`). The page's own
   * origin and Bridge's endpoints are always allowed; nothing else is.
   */
  readonly tokenOrigins?: readonly string[];
  /** How the issuer's metadata is read again after a failure. */
  readonly discovery?: DiscoveryOptions;
  /** For tests: Web Locks, or null for none. */
  readonly locks?: LockManagerLike | null;
  /** For tests: how tabs talk, or null for not at all. */
  readonly tabChannel?: ((name: string) => ChannelLike) | null;
}

export type BridgeEvents = SessionEvents & {
  /** A Live notice: something changed, fetch it again if it is on screen. */
  notice: LiveNotice;
  /** The client started: the issuer's metadata is read and any stored session restored. Fires once. */
  ready: { readonly issuer: string };
  /** The workspace was locked for payment or unlocked, or what the gate says about billing changed: see `gateState()`. */
  'gate-changed': BillingGateState;
};

/** Notices after which the quotas a screen shows are read again (the notices carry no numbers); a gap in Live's notices too. */
/** Notices after which the lock for payment is read again. */
const GATE_NOTICES = new Set(['billing.access_changed', MANY_CHANGED]);

const QUOTA_NOTICES = new Set(['billing.quota_updated', 'billing.access_changed', MANY_CHANGED]);

/** Notices after which flag results may differ. */
const FLAG_NOTICES = new Set(['flags.revision_changed', 'accounts.member_updated', 'accounts.workspace_updated', MANY_CHANGED]);

type AsyncFn = (...args: never[]) => Promise<unknown>;

/**
 * Every function of `api`, waiting for the client to start first, so calls
 * made early wait instead of failing. A client that could not start tries
 * again at once, and the call fails with the reason if it still cannot.
 */
function afterReady<T extends object>(api: T, started: () => Promise<void>): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(api)) {
    if (typeof value === 'function') {
      wrapped[name] = async (...args: never[]) => {
        await started();
        return (value as AsyncFn)(...args);
      };
    } else if (value !== null && typeof value === 'object') {
      wrapped[name] = afterReady(value as object, started);
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
  const discovery = new Discovery(issuer, fetchFn, options.discovery);
  const endpoints = (): Endpoints => {
    const found = discovery.current();
    if (found === null) throw new BridgeError('unavailable', "The issuer's metadata has not been read yet.", { status: 503 });
    return found;
  };
  const tokenOrigins = (options.tokenOrigins ?? []).map((origin) => {
    const secure = secureUrl(origin, 'https:');
    const normalised = secure === null ? null : originOf(secure);
    if (normalised === null) throw new BridgeError('misconfigured', `tokenOrigins must be https origins (http only on localhost); got "${origin}".`);
    return normalised;
  });
  const onError = (error: unknown) => events.emit('error', error);
  // A 402 for a workspace locked for payment, caught anywhere the SDK or `bridge.fetch` sees one, shows the lock at once.
  const watchedFetch = watchLock(fetchFn, (status) => gate.markLocked(status));

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
  const flags = new Flags({ issuer, endpoints, fetch: watchedFetch, storage, session, onError });
  const live = new Live({ endpoints, fetch: fetchFn, session, onError }, options.live === false ? { enabled: false } : (options.live ?? {}));
  const language = typeof options.language === 'function' ? options.language : () => options.language as string | undefined;
  const flows = createSignIn({ issuer, endpoints, fetch: fetchFn, signUpStorage: options.signUpStorage ?? storage, session, ceremonies: options.webauthn ?? browserCeremonies(), language, ...(options.linkAddress === undefined ? {} : { linkAddress: options.linkAddress }) });
  const recheck = createRecheck({ issuer, endpoints, fetch: fetchFn, signUpStorage: options.signUpStorage ?? storage, session, ceremonies: options.webauthn ?? browserCeremonies(), language, ...(options.linkAddress === undefined ? {} : { linkAddress: options.linkAddress }) });
  const hosted = createHosted({ issuer, endpoints, fetch: fetchFn, storage: options.signUpStorage ?? storage, session });
  const accounts = createAccounts({ endpoints, fetch: watchedFetch, session, renewed: () => void gate.refresh() });
  const billing = createBilling({ endpoints, fetch: watchedFetch, session, renewed: () => void gate.refresh(), changed: () => {
    void flags.load();
    void gate.refresh();
  } });
  const gate: BillingGate = new BillingGate({ state: () => billing.gate(), session, onError });
  gate.subscribe((state) => events.emit('gate-changed', state));
  const quotas = new QuotaStore({ endpoints, fetch: watchedFetch, session, onError });
  const quotaEvents = new QuotaEvents(quotas, () => {
    const now = session.state.get();
    return now.status === 'signed-in' ? (now.workspace?.id ?? '') : '';
  });
  const entitlements = createEntitlements(flags);

  let started = false;
  const whoChanged = () => {
    quotas.reset();
    gate.reset();
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
    // What the workspace may do changed (its plan): the results follow once Bridge's copy of it does, a moment later.
    // Usage changing (`billing.quota_updated`) moves numbers, not what the plan allows: only the quotas are read again.
    // A quota_updated notice also tells the handlers registered with `handle` which metrics changed.
    if (notice.type === 'billing.quota_updated') void quotaEvents.noticed();
    else if (QUOTA_NOTICES.has(notice.type)) void quotas.refresh();
    if (GATE_NOTICES.has(notice.type)) void gate.refresh();
    if (notice.type.startsWith('billing.') && notice.type !== 'billing.quota_updated') void flags.reloadAfterChange();
    else if (FLAG_NOTICES.has(notice.type)) void flags.load();
    // This session was ended elsewhere: find out now rather than at the next refresh.
    if (notice.type === 'identity.signed_out') void session.refresh({ force: true }).catch(() => undefined);
  });

  // Starting: read the metadata, restore the session, load flags, connect Live. A failed start is tried again, waiting
  // longer each time, so a page opened while Bridge was briefly unreachable recovers without a reload.
  let starting: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  function start(now: boolean): Promise<void> {
    if (started) return Promise.resolve();
    starting ??= (async () => {
      await discovery.get({ now });
      await session.restore();
      if (options.loadFlags !== false) await flags.load();
      started = true;
      events.emit('ready', { issuer });
      void quotas.refresh();
      void gate.refresh();
      void live.start();
    })().finally(() => {
      starting = null;
    });
    return starting;
  }
  function retryLater(error: unknown): void {
    onError(error);
    if (destroyed || started || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start(false).catch(retryLater);
    }, Math.max(1000, discovery.retryInMs()));
  }
  const ready = start(true);
  // A failed first start is reported through `ready` and `error`, and tried again; never an unhandled rejection.
  ready.catch(retryLater);
  const ensureStarted = () => start(true);

  /** Whether `bridge.fetch` may send the person's token to this address. */
  function mayCarryToken(url: string): boolean {
    const page = typeof location !== 'undefined' && typeof location.href === 'string' ? location : null;
    const origin = originOf(url, page?.href);
    if (origin === null) return false;
    if (page !== null && origin === page.origin) return true;
    if (tokenOrigins.includes(origin)) return true;
    const known = discovery.current()?.metadata.endpoints ?? {};
    return Object.values(known).some((endpoint) => endpoint !== undefined && originOf(endpoint) === origin);
  }

  /**
   * `fetch` for the Child App's own API: adds the person's access token, and
   * after a 401 refreshes once and tries again. A request body that is a
   * stream cannot be sent twice, so it is not retried. The token goes only to
   * the page's own origin, Bridge's endpoints and `tokenOrigins`; any other
   * address is refused before anything is sent.
   */
  async function bridgeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    await ensureStarted();
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!mayCarryToken(target)) {
      throw new BridgeError('misconfigured', `bridge.fetch sends the person's token only to this page's origin, Bridge's endpoints and \`tokenOrigins\`; ${originOf(target) ?? target} is none of them.`);
    }
    const withToken = (token: string): RequestInit => {
      const headers = new Headers(init.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${token}`);
      return { ...init, headers };
    };
    const retryable = !(typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream);
    const again = typeof Request !== 'undefined' && input instanceof Request && retryable ? input.clone() : input;
    const first = await watchedFetch(input, withToken(await session.accessToken()));
    if (first.status !== 401 || !retryable) return first;
    // Locking a workspace for payment, or lifting the lock, takes back everyone's tokens: renew silently and try once more.
    // A session that cannot be renewed has ended, as any sign-out does.
    try {
      await session.refresh({ force: true });
    } catch {
      return first;
    }
    const second = await watchedFetch(again, withToken(await session.accessToken()));
    // The lock may have changed meanwhile: read it again, so the page shows the lockscreen, or goes back to normal.
    void gate.refresh();
    return second;
  }

  return {
    issuer,
    /**
     * Resolves once the issuer's metadata is read and any stored session is
     * restored. If the first try fails, it rejects with the reason and the
     * client keeps trying in the background (`ready` fires when it starts);
     * calls made meanwhile try again at once.
     */
    ready,
    /** Who is signed in. */
    session: session.state as Readable<SessionState>,
    /** What the issuer published. Available once `ready` resolves. */
    metadata: (): IssuerMetadata => endpoints().metadata,
    ...afterReady(
      {
        signIn: flows.signIn,
        signUp: flows.signUp,
        magicLink: flows.magicLink,
        passkeys: flows.passkeys,
        password: flows.password,
        invites: flows.invites,
        /** What an email link is, without using it: see `links.preview`. */
        links: flows.links,
        /** Another app's sign-in request, for Bridge's hosted page: see `request.use`. */
        request: flows.request,
        /** Hosted mode: sign in on the page Bridge hosts for the app, and come back signed in. */
        hosted,
        /** Confirming it is you, for an action that wants a recent sign-in, without signing out. */
        recheck,
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
      ensureStarted,
    ),
    flags,
    /**
     * Plan features as the flags `bridge:billing.entitlement.<key>`: `can(key)`
     * is whether the workspace's plan includes the feature (off until Bridge
     * says on), `all()` every one Bridge gave a result for.
     */
    entitlements,
    /** The plan limits a screen shows, one snapshot per metric: see `QuotaStore`. */
    quotas,
    /**
     * A metric's quota snapshot: what is used, the limit, the policy and the
     * warning level. The first call for a metric starts reading it and
     * returns undefined; `quotas.subscribe` tells when it arrives, and it is
     * read again when Bridge says usage or the plan changed.
     */
    quota: (metric: string): QuotaSnapshot | undefined => quotas.ensureHydrated(metric),
    /**
     * True when the workspace is locked for payment (it can be read, not
     * changed); false until that is known. For disabling write actions early.
     */
    isLocked: (): boolean => gate.isLocked(),
    /** The lock with its severity and notice state, for a custom lock screen. `on('gate-changed')` tells when it changes. */
    gateState: (): BillingGateState => gate.gateState(),
    /** Throws a `BillingLockedError` when the workspace is locked for payment. */
    assertNotLocked: (): void => gate.assertNotLocked(),
    /**
     * Runs `handlers['quota.updated']` when a metric's numbers changed, with
     * the numbers read again (Bridge's notice carries none). Returns how to
     * remove the handlers.
     */
    handle: (handlers: BillingEventHandlers): (() => void) => quotaEvents.handle(handlers),
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
      destroyed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      live.stop();
      session.destroy();
      events.clear();
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
