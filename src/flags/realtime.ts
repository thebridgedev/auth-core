// SDK realtime client (TBP-150).
//
// Auto-discovers the workspace's pub/sub protocol from `GET /realtime/config`
// (TBP-147), authorizes via `POST /realtime/authorize` (TBP-151 — Centrifugo
// path only; AppSync uses a Lambda authorizer server-side), and connects to
// receive live flag updates + per-user identity changes.
//
// Two protocols, one shape:
//   - `centrifugo`: WebSocket to a Centrifugo server using a signed connect token.
//   - `appsync`:    WebSocket to AWS AppSync Events (TBP-148). Client carries
//                   its Bridge JWT directly in the `header-…` subprotocol; the
//                   Lambda authorizer makes per-channel decisions server-side
//                   (no `/realtime/authorize` round-trip).
//
// `noop` server-side → realtime is disabled; the SDK falls back to periodic
// poll or simply doesn't get live updates.
//
// Messages received on the workspace channel update the BridgeFlags cache
// (`upsert` / `remove`). Per-user channel messages are handled via callbacks
// the framework SDK supplies (token refresh, attribute changes — see TBP-90).

import type { BridgeFlags, CachedFlag } from './flag.js';
import { createLogger, type Logger } from '../logger.js';

export interface RealtimeClientConfig {
  /** Bridge API base URL — same as the telemetry batcher. */
  apiBaseUrl: string;
  /** JWT workspace API key. */
  apiKey: string;
  /**
   * App identifier for the `app:<appId>` channel. Set when the SDK is wired
   * to a known app context.
   */
  appId?: string;
  /** Optional workspace + user identifier for authorize. Defaults derived from the API key. */
  workspaceId?: string;
  userId?: string;
  /** When false, the client is a no-op. Defaults to true. */
  enabled?: boolean;
  /** Initial backoff in ms after an unexpected disconnect. Default 1000. */
  reconnectBaseMs?: number;
  /** Cap on reconnect backoff. Default 30_000. */
  reconnectMaxMs?: number;
  /**
   * Optional WebSocket factory — used in tests + non-browser environments.
   * Default is `globalThis.WebSocket`.
   */
  websocketFactory?: (url: string, protocols?: string | string[]) => WebSocketLike;
  /** Optional fetch — same default-and-override pattern. */
  fetchFn?: typeof fetch;
  /**
   * Called just before each /realtime/authorize round-trip. Return the user's
   * JWT when authenticated so the server can allow per-user channel subscriptions.
   * Falls back to apiKey when this is undefined or returns undefined.
   */
  getAuthToken?: () => string | undefined;
  /**
   * The host SDK's token refresh (TBP-643). Called at most once per refused
   * connection episode; must resolve to the NEW access token (or undefined if
   * the session could not be refreshed). The client reconnects immediately
   * with the returned token instead of waiting out the backoff.
   *
   * Without it, a refused session is diagnosed and parked in `'unauthorized'`
   * until `reauthorize()` is called or the token changes.
   */
  refreshAuthToken?: () => Promise<string | undefined>;
  /**
   * When a refusal can't be explained client-side, ask Bridge why — once per
   * episode — via `POST <apiBaseUrl>/realtime/diagnose`. Default true.
   */
  diagnose?: boolean;
  /**
   * Base URL of the realtime error docs; each reason is an anchor on it.
   * Default {@link REALTIME_DOCS_BASE_URL}.
   */
  docsBaseUrl?: string;
  /**
   * Optional logger. Defaults to a non-debug logger, which still emits
   * `error` — deliberate: a rejected subscription means realtime is silently
   * dead, and that must not require debug mode to notice (TBP-575).
   */
  logger?: Logger;
}

// TBP-643 — single place to repoint the docs the terminal messages link to.
// Links render as `<base>#<reason>`, so every reason code we emit is an anchor
// on that page — keep codes lowercase_with_underscores.
export const REALTIME_DOCS_BASE_URL = 'https://thebridge.dev/docs/live-updates/troubleshooting/';

/**
 * The AppSync `Authorization` value a signed-out session presents. Must be
 * non-empty (AppSync rejects '' before the authorizer runs) and must match
 * what the bridge-api authorizer recognises as "no token" byte for byte.
 */
export const REALTIME_ANONYMOUS_TOKEN = 'anonymous';

/**
 * What the realtime connection is doing right now, and — when it is not
 * working — why, whose move it is (`side`), and whether it is still trying.
 *
 * `side` exists because the same symptom ("no live updates") has owners who
 * need opposite actions: `app` = the host app's session/token handling,
 * `config` = the app's Bridge settings disagree with the session, `bridge` =
 * Bridge refused a token that checks out (nothing to change in the app),
 * `network` = transient transport trouble the client is retrying through.
 */
export interface RealtimeStatus {
  state: ConnectionState;
  /** Machine-readable reason, also the anchor on `docsUrl`. */
  reason?: string;
  side?: 'app' | 'bridge' | 'config' | 'network';
  /** True while the client will keep trying on its own. */
  retrying: boolean;
  docsUrl?: string;
  /** Per-episode correlation id — also sent to Bridge as `x-bridge-realtime-ref`. */
  ref?: string;
  /** `Date.now()` at the last state/reason change. */
  since: number;
}

/** Minimal WebSocket surface the client uses. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
}

interface RealtimeServerConfig {
  kind: 'appsync' | 'centrifugo' | 'noop';
  endpoint?: string;
  protocol?: string;
}

interface AuthorizeResponse {
  allowed: string[];
  denied: Array<{ channel: string; reason: string }>;
  signedToken: string;
  expiresAt: number;
}

/** Flag-update payload published on the workspace channel. */
export interface FlagUpdateMessage {
  kind: 'flag.updated';
  flag: CachedFlag;
}

/** Flag-removed payload. */
export interface FlagRemovedMessage {
  kind: 'flag.removed';
  key: string;
}

/** Per-user payload — e.g. token refresh signal or attribute change. */
export interface UserStateMessage {
  kind: 'user.state_changed';
  reason: 'token_invalidated' | 'attributes_changed' | 'role_changed' | string;
}

/**
 * Billing 2.0 / Phase A / US-3 — canonical plan-change payload published on
 * the workspace channel. Consumers (the SDK billing surface) hydrate their
 * cached state on receipt; no refetch required.
 */
export interface SubscriptionPlanChangedMessage {
  kind: 'subscription.plan_changed';
  tenantId: string;
  from: { slug: string };
  to: { slug: string; name: string };
  status: string;
  effectiveAt: string;
}

/**
 * Billing 2.0 / Phase B (US-4 onwards) — canonical billing lifecycle events.
 * One discriminator-union covers every lifecycle event the workspace channel
 * carries. Fields are optional per-kind; consumers should be defensive.
 */
export interface BillingLifecycleMessage {
  kind:
    | 'payment.failed'
    | 'payment.succeeded'
    | 'subscription.created'
    | 'subscription.updated'
    | 'subscription.canceled'
    | 'subscription.reactivated'
    | 'subscription.trial_started'
    | 'subscription.trial_ending_soon'
    | 'subscription.trial_converted'
    | 'subscription.trial_expired'
    | 'dunning.entered'
    | 'dunning.retry_scheduled'
    | 'dunning.recovered'
    | 'dunning.exhausted'
    | 'entitlements.changed';
  tenantId: string;
  stripeEventId?: string;
  effectiveAt: string;
  // Optional fields populated per-event-kind:
  status?: string;
  pastDueReason?: string | null;
  cardLast4?: string;
  hasCardOnFile?: boolean;
  endsAt?: string;
  daysLeft?: number;
  nextRetryAt?: string;
  finalRetryAt?: string;
  gateEngaged?: boolean;
}

/**
 * Billing 2.0 US-11 — live quota counter push. The bridge-api QuotaService
 * publishes one of these whenever the workspace's used/limit ratio crosses a
 * threshold or just changes (throttled ~1/sec per metric, last-write-wins).
 * Consumers cache the snapshot per metric and re-render reactively.
 *
 * US-12 adds `policy` so the SDK can mark a metric as `metered` (Stripe-bills
 * overage, no entitlement produced) or `hard` (entitlement flips at cap).
 */
export interface QuotaUpdatedMessage {
  kind: 'quota.updated';
  tenantId: string;
  /** Optional — server-side context for telemetry. SDK does not use this. */
  appId?: string;
  effectiveAt: string;
  metric: string;
  used: number;
  limit: number;
  remaining: number;
  /** null = under 80% used (UI renders nothing). */
  warningLevel: null | 'approaching' | 'critical';
  /**
   * US-12 — per-metric policy. Optional for backward compatibility: a server
   * that hasn't shipped US-12 yet won't populate this; the SDK defaults to
   * `'metered'` in that case.
   */
  policy?: 'hard' | 'metered';
  /**
   * TBP-275 — metered overage context. Optional (absent for hard quotas and
   * older servers). `unitAmount` + `currency` describe the per-unit price;
   * `overageEstimate` is the server-computed estimated cost this period;
   * `overcap` is true once usage passed the included allotment.
   */
  unitAmount?: number;
  currency?: string;
  overageEstimate?: number;
  overcap?: boolean;
}

/**
 * Billing 2.0 US-12 — wholesale entitlement snapshot push. The bridge-api
 * EntitlementService publishes one of these whenever the diff against the
 * previously published snapshot is non-empty. Consumers replace their cache
 * wholesale on receipt.
 *
 * Distinct from `BillingLifecycleMessage`'s `'entitlements.changed'` kind:
 * that one is a SIGNAL (no payload) on the lifecycle channel; this one
 * carries the actual map. Both can be present on the wire — the SDK dispatch
 * routes the carrying-map variant to `setOnEntitlementsChanged`.
 */
export interface EntitlementsChangedMessage {
  kind: 'entitlements.changed';
  tenantId: string;
  effectiveAt: string;
  entitlements: Record<string, boolean>;
}

/**
 * Phase 3 (TBP-287/314) — first-paint snapshot. The server emits one per
 * successful per-user channel subscribe (and again on reconnect). The SDK
 * fans the `data` out to whichever slices the consumer has wired up — see
 * `setOnSnapshot()`. Lazy slices (`tenant.quotas`, `tenant.members`,
 * `app.plans`, etc.) are NOT in this payload; consumers call their `.load()`
 * to populate them on demand.
 */
export interface SessionSnapshotMessage {
  kind: 'session.snapshot';
  data: {
    app: {
      branding: {
        logo: string;
        name: string;
        primaryButtonBgColor?: string;
        textColor?: string;
        bgColor?: string;
        fontFamily?: string;
      };
    };
    tenant: {
      id: string;
      name: string;
      subscription: {
        plan: { slug: string; name: string };
        status: string;
        endsAt?: string;
        gateEngaged?: boolean;
      };
      entitlements: Record<string, boolean>;
    };
    user: {
      id: string;
      email?: string;
      role: string;
      tenantId: string;
    };
  };
}

export type RealtimeMessage =
  | FlagUpdateMessage
  | FlagRemovedMessage
  | UserStateMessage
  | SubscriptionPlanChangedMessage
  | BillingLifecycleMessage
  | QuotaUpdatedMessage
  | EntitlementsChangedMessage
  | SessionSnapshotMessage;

/** A flag mutation received on the wire — see `setOnFlagChange` (TBP-575). */
export interface FlagChange {
  /** The flag key that changed. */
  key: string;
  kind: 'updated' | 'removed';
}

/**
 * `degraded` (TBP-575) means the socket is up and the handshake completed, but
 * no channel subscription was accepted — the client is connected and deaf.
 * Before this state existed such a connection reported `open`, which is how a
 * dead realtime transport passed for healthy in production for months.
 */
//
// `unauthorized` (TBP-643) means Bridge refused this session's connection and
// the client has STOPPED retrying: reconnecting with the same token can only
// be refused again, and doing it on a backoff loop is how a stage app logged
// the same refusal 101 times without ever saying why.
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'degraded' | 'closed' | 'unauthorized';

/** How long to wait for a subscribe ack before declaring the connection deaf. */
const SUBSCRIBE_ACK_TIMEOUT_MS = 10_000;

/** Cap on the diagnose round-trip — a hung call must not leave us 'connecting' forever. */
const DIAGNOSE_TIMEOUT_MS = 5_000;

/** While parked in 'unauthorized', how often to look for a new token. */
const PARKED_TOKEN_CHECK_MS = 5_000;

/** Who owns a refusal — see RealtimeStatus.side. */
type RefusalSide = 'app' | 'bridge' | 'config';

interface RefusalVerdict {
  reason: string;
  side: RefusalSide;
  /** wrong_environment: the token's issuer. */
  tokenIssuer?: string;
  /** wrong_app: the token's `aid`. */
  tokenAppId?: string;
}

/**
 * One run of trouble, from the first failure to recovery (or to parking in
 * 'unauthorized'). Logging is keyed to episodes, not attempts: the developer
 * hears once that something broke and once that it recovered.
 */
interface FaultEpisode {
  kind: 'transient' | 'auth';
  ref: string;
  /** Reconnect attempts fired during this episode. */
  attempts: number;
  /** transient: the cause; auth: placeholder until a verdict lands. */
  reason: string;
  /** transient: the level the start was logged at — recovery logs at the same level. */
  logLevel?: 'error' | 'warn';
  refreshed: boolean;
  diagnosed: boolean;
}

interface Refusal extends RefusalVerdict {
  /** The token that was refused — a later start() with the same one stays parked. */
  token: string | undefined;
  ref: string;
  docsUrl: string;
}

/** Centrifugo `/realtime/authorize` answered 401/403 — a refusal, not a blip. */
class RealtimeAuthRefusedError extends Error {
  constructor(readonly status: number) {
    super(`realtime authorize refused: ${status}`);
  }
}

export class RealtimeClient {
  private readonly cfg: Required<
    Omit<
      RealtimeClientConfig,
      'appId' | 'workspaceId' | 'userId' | 'websocketFactory' | 'fetchFn' | 'getAuthToken' | 'refreshAuthToken'
    >
  > & {
    appId?: string;
    workspaceId?: string;
    userId?: string;
    websocketFactory: (url: string, protocols?: string | string[]) => WebSocketLike;
    fetchFn: typeof fetch;
    getAuthToken: (() => string | undefined) | undefined;
    refreshAuthToken: (() => Promise<string | undefined>) | undefined;
  };
  private ws?: WebSocketLike;
  private state: ConnectionState = 'idle';
  private reconnectDelayMs: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private bridge?: BridgeFlags;
  private onUserStateHook?: (msg: UserStateMessage) => void;
  private onSubscriptionPlanChangedHook?: (msg: SubscriptionPlanChangedMessage) => void;
  private onBillingLifecycleHook?: (msg: BillingLifecycleMessage) => void;
  private onQuotaUpdatedHook?: (msg: QuotaUpdatedMessage) => void;
  private onEntitlementsChangedHook?: (msg: EntitlementsChangedMessage) => void;
  // Phase 3 (TBP-287/314) — fans `session.snapshot` out to whichever slices
  // the consumer has wired (app.branding, tenant.subscription, etc.).
  private onSnapshotHook?: (msg: SessionSnapshotMessage) => void;
  private onOpenHook?: () => void;
  private onCloseHook?: () => void;
  /**
   * TBP-575 — fires whenever a flag mutation arrives on the wire, regardless
   * of which cache consumes it. Route guards read a *different* cache
   * (`FeatureFlagService`) than `<FeatureFlag>` does (`BridgeFlags`), and
   * nothing used to tell that second cache the world had changed. This hook is
   * how the framework SDK invalidates it and re-evaluates the current route.
   */
  private onFlagChangeHook?: (change: FlagChange) => void;
  /** Fires when the connection is up but no channel subscription was accepted. */
  private onDegradedHook?: () => void;
  private stopped = false;
  // ── AppSync subscribe bookkeeping (TBP-575) ──────────────────────────────
  /** Subscription id → internal channel name, for correlating server acks. */
  private pendingSubscribes = new Map<string, string>();
  private ackedChannels = new Set<string>();
  private failedChannels = new Map<string, string>();
  private subscribeAckTimer?: ReturnType<typeof setTimeout>;
  // ── Fault reporting (TBP-643) ─────────────────────────────────────────────
  private status: RealtimeStatus;
  private onStatusChangeHook?: (status: RealtimeStatus) => void;
  /** The current run of trouble, if any — see FaultEpisode. */
  private episode?: FaultEpisode;
  /** Set while parked in 'unauthorized'. */
  private refusal?: Refusal;
  /**
   * token|reason|side of the last refusal we logged. A resume (tab refocus,
   * `online`) that ends in the identical refusal is the same news — it goes
   * to debug, not another console error.
   */
  private lastRefusalKey?: string;
  /**
   * Token handed back by `refreshAuthToken`, used while the host's
   * `getAuthToken()` still returns the token it replaced (`staleToken`). Hosts
   * may not have updated their store by the time the refresh resolves.
   */
  private freshToken?: string;
  private staleToken?: string;
  /** A socket we closed on purpose (setUserId & co.) — its close is not a fault. */
  private expectedCloseWs?: WebSocketLike;
  private resumeListenersInstalled = false;
  /** Runs only while parked — see startParkedTokenCheck. */
  private parkedTokenTimer?: ReturnType<typeof setInterval>;

  constructor(cfg: RealtimeClientConfig) {
    const defaultWs = ((url: string, protocols?: string | string[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (globalThis as any).WebSocket(url, protocols)) as (
      url: string,
      protocols?: string | string[],
    ) => WebSocketLike;
    this.cfg = {
      apiBaseUrl: cfg.apiBaseUrl.replace(/\/+$/, ''),
      apiKey: cfg.apiKey,
      appId: cfg.appId,
      workspaceId: cfg.workspaceId,
      userId: cfg.userId,
      enabled: cfg.enabled !== false,
      reconnectBaseMs: cfg.reconnectBaseMs ?? 1000,
      reconnectMaxMs: cfg.reconnectMaxMs ?? 30_000,
      websocketFactory: cfg.websocketFactory ?? defaultWs,
      fetchFn: cfg.fetchFn ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch),
      getAuthToken: cfg.getAuthToken,
      refreshAuthToken: cfg.refreshAuthToken,
      diagnose: cfg.diagnose !== false,
      docsBaseUrl: cfg.docsBaseUrl ?? REALTIME_DOCS_BASE_URL,
      logger: cfg.logger ?? createLogger(false),
    };
    this.reconnectDelayMs = this.cfg.reconnectBaseMs;
    this.status = { state: 'idle', retrying: false, since: Date.now() };
  }

  /**
   * Current connection status with the reason, whose side a fault is on, and
   * whether the client is still retrying (TBP-643). `getState()` is the same
   * `state` without the explanation.
   */
  getStatus(): RealtimeStatus {
    return { ...this.status };
  }

  /**
   * Register a hook fired on every status change (state, reason, side or
   * retrying). Use it to drive a "live updates off" indicator. Hook errors are
   * swallowed, like every other hook here.
   */
  setOnStatusChange(hook: (status: RealtimeStatus) => void): void {
    this.onStatusChangeHook = hook;
  }

  /** Attach to a BridgeFlags instance — flag updates auto-apply to its cache. */
  attach(bridge: BridgeFlags): void {
    this.bridge = bridge;
  }

  /** Register a hook for per-user channel messages. */
  setOnUserState(hook: (msg: UserStateMessage) => void): void {
    this.onUserStateHook = hook;
  }

  /**
   * Billing 2.0 US-3 — register a hook for canonical subscription plan-change
   * events. The billing reactive surface (`BridgeSubscription.attach(rt)`)
   * wires this up; framework SDKs typically don't call it directly.
   */
  setOnSubscriptionPlanChanged(hook: (msg: SubscriptionPlanChangedMessage) => void): void {
    this.onSubscriptionPlanChangedHook = hook;
  }

  /**
   * Billing 2.0 US-5+ — register a hook for all canonical lifecycle events
   * (payment.*, subscription.*, dunning.*, entitlements.*). `BridgeSubscription.attach(rt)`
   * wires this; user-level event handlers can also register here via
   * `useBridge().handle({ "payment.failed": ... })`.
   */
  setOnBillingLifecycle(hook: (msg: BillingLifecycleMessage) => void): void {
    this.onBillingLifecycleHook = hook;
  }

  /**
   * Billing 2.0 US-11 — register a hook for `quota.updated` payloads on the
   * workspace channel. `useBridge().quota(metric)` consumers wire this up
   * so live counter UI reflects server-side ingest without polling.
   */
  setOnQuotaUpdated(hook: (msg: QuotaUpdatedMessage) => void): void {
    this.onQuotaUpdatedHook = hook;
  }

  /**
   * Billing 2.0 US-12 — register a hook for `entitlements.changed` payloads
   * on the workspace channel that carry the full entitlements map.
   * `useBridge().entitlements.can(...)` consumers wire this up so the cache
   * replaces wholesale on every diff.
   *
   * Note: the legacy `BillingLifecycleMessage` `entitlements.changed` kind
   * (signal-only, no payload) keeps firing through `setOnBillingLifecycle`
   * — this hook ONLY fires when the wire payload includes the `entitlements`
   * field. Allows both old and new consumers to coexist during rollout.
   */
  setOnEntitlementsChanged(hook: (msg: EntitlementsChangedMessage) => void): void {
    this.onEntitlementsChangedHook = hook;
  }

  /**
   * Phase 3 (TBP-287/314) — register a hook for `session.snapshot`. The server
   * publishes one on every successful per-user channel subscribe (initial
   * connect AND reconnect). Framework SDKs use this to pre-populate the
   * `bridge.app.branding` / `bridge.tenant.{subscription,entitlements}` /
   * `bridge.user` slices on first paint, eliminating the per-slice REST
   * hydrate round-trips that the legacy bootstrap path required.
   *
   * Composition is fixed (no consumer config). If a later release promotes
   * another slice into the snapshot, that slice's `.load()` becomes a no-op
   * automatically — consumers don't need code changes.
   */
  setOnSnapshot(hook: (msg: SessionSnapshotMessage) => void): void {
    this.onSnapshotHook = hook;
  }

  /**
   * Register a hook fired on every flag mutation received on the wire
   * (TBP-575). Distinct from `attach()`, which only feeds the `BridgeFlags`
   * cache: this hook exists so a framework SDK can also invalidate the
   * legacy `FeatureFlagService` cache that route guards read, and re-run the
   * guard for the route the user is currently sitting on.
   */
  setOnFlagChange(hook: (change: FlagChange) => void): void {
    this.onFlagChangeHook = hook;
  }

  /**
   * Register a hook fired when the connection reaches `'degraded'` — socket
   * up, handshake done, no channel subscription accepted (TBP-575). The
   * client stays connected; nothing will arrive on it. Use this to surface an
   * indicator or fall back to polling.
   */
  setOnDegraded(hook: () => void): void {
    this.onDegradedHook = hook;
  }

  /**
   * Register a hook fired when the WebSocket transitions to `'open'` —
   * fires on initial connect AND on every successful reconnect. Framework
   * SDKs use this to re-fire startup tasks (e.g. cache hydration) that
   * may have been missed during an outage.
   *
   * On the AppSync transport this fires when the first channel subscription
   * is **accepted**, not merely when the handshake completes — a connection
   * with no accepted subscription is `degraded`, not open (TBP-575).
   */
  setOnOpen(hook: () => void): void {
    this.onOpenHook = hook;
  }

  /**
   * Register a hook fired when the WebSocket transitions to `'closed'` —
   * use for surfacing connection status to consumers (e.g. an "offline"
   * indicator). Fires on intentional close as well; check `getState()`
   * if you need to distinguish.
   */
  setOnClose(hook: () => void): void {
    this.onCloseHook = hook;
  }

  /**
   * Re-run the authorize step against the current `getAuthToken()` value and
   * re-open the WebSocket. Used by the framework SDK on every token rotation
   * where the userId is unchanged but the JWT value rotated (post-refresh).
   *
   * Without this, the existing connection keeps riding the OLD token until
   * Centrifugo's own connection-token TTL drops it — a strictly-larger
   * blast-radius window than necessary.
   *
   * Behavior:
   *  - Disabled / stopped → no-op.
   *  - Mid-`connecting` → no-op; the in-flight authorize() reads the current
   *    token by closure, so it will already pick up the new value.
   *  - Open → drop the ws ref (so the old socket's onclose treats itself as
   *    stale via the identity guard in `openWebSocket`), close it with
   *    `1000 / sdk.reauthorize`, reset backoff, then `start()` immediately.
   */
  async reauthorize(): Promise<void> {
    if (!this.cfg.enabled || this.stopped) return;
    // A connect attempt that has not yet produced a socket will read the
    // current token when it gets there — nothing to redo. Once a socket
    // exists we must replace it, whatever the state is called: TBP-575 added
    // 'degraded' (live socket, no accepted subscription) and widened
    // 'connecting' to cover the await-subscribe-ack window, and keying this
    // on `state === 'open'` silently skipped both.
    if (!this.ws) {
      if (this.state === 'connecting') return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectDelayMs = this.cfg.reconnectBaseMs;
    // TBP-643 — an explicit reauthorize is the host saying "try again": it
    // lifts a parked refusal and starts a fresh episode. An auth episode that
    // is still in flight is deliberately NOT reset — the host calls this
    // whenever its token changes, including after the refresh WE asked for,
    // and resetting would re-arm that refresh and loop.
    if (this.state === 'unauthorized') this.clearRefusal();
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = undefined;
      this.setState('closed');
      try {
        oldWs.close(1000, 'sdk.reauthorize');
      } catch {
        // ignore
      }
    } else if (this.state === 'unauthorized') {
      this.setState('closed');
    }
    await this.start();
  }

  /**
   * Phase 2 (TBP-307) — Set/update the appId after initial start. Framework
   * SDKs call this when the app context first lands (e.g. after the first
   * authorize round-trip exposes the JWT `aid` claim). Triggers a reconnect
   * so the new `app:<appId>` channel is included in the next authorize.
   */
  setAppId(appId: string | undefined): void {
    if (this.cfg.appId === appId) return;
    this.cfg.appId = appId;
    if (this.ws) {
      this.expectedCloseWs = this.ws;
      this.ws.close(1000, 'sdk.setAppId');
      // onclose → scheduleReconnect → start() picks up updated channelsToSubscribe()
    }
  }

  /**
   * Phase 2 (TBP-307) — Set/update the workspaceId after initial start. Used
   * by framework SDKs when the tenant context lands or changes (workspace
   * switcher, tenant join/leave). Triggers a reconnect.
   */
  setWorkspaceId(workspaceId: string | undefined): void {
    if (this.cfg.workspaceId === workspaceId) return;
    this.cfg.workspaceId = workspaceId;
    if (this.ws) {
      this.expectedCloseWs = this.ws;
      this.ws.close(1000, 'sdk.setWorkspaceId');
    }
  }

  /**
   * Update the userId after initial start — used by the framework SDK to
   * subscribe to the per-user channel when the user logs in post-bootstrap.
   * Triggers a reconnect so the new channel is included in the next authorize.
   */
  setUserId(userId: string | undefined): void {
    if (this.cfg.userId === userId) return;
    this.cfg.userId = userId;
    if (this.ws) {
      this.expectedCloseWs = this.ws;
      this.ws.close(1000, 'sdk.setUserId');
      // onclose fires → scheduleReconnect → start() picks up updated channelsToSubscribe()
    }
  }

  /** Begin connecting. Idempotent. */
  async start(): Promise<void> {
    if (!this.cfg.enabled || this.stopped) return;
    if (this.state === 'unauthorized') {
      // Parked after a refusal (TBP-643). The same token would only be refused
      // again, so a plain start() with it stays parked; a different token is
      // a new session and gets a fresh episode.
      if (this.currentToken() === this.refusal?.token) return;
      this.clearRefusal();
    } else if (this.state !== 'idle' && this.state !== 'closed') {
      return;
    }

    this.installResumeListeners();
    this.setState('connecting');
    try {
      const serverConfig = await this.fetchServerConfig();
      if (serverConfig.kind === 'noop' || !serverConfig.endpoint) {
        // Realtime is off for this workspace — nothing to retry or report.
        this.episode = undefined;
        this.setState('closed');
        return;
      }
      const channels = this.channelsToSubscribe();
      if (serverConfig.kind === 'appsync') {
        // AppSync uses a Lambda authorizer for per-channel auth — no client-side
        // /realtime/authorize round-trip. The Bridge JWT is carried in the
        // subprotocol negotiation; the Lambda decides allow/deny per channel.
        this.openAppSyncWebSocket(serverConfig.endpoint, channels);
        return;
      }
      if (serverConfig.kind === 'centrifugo') {
        const userToken = this.currentToken();
        let auth: AuthorizeResponse;
        try {
          auth = await this.authorize(channels, userToken);
        } catch (err) {
          // A 401/403 from /realtime/authorize is the same refusal AppSync
          // reports as connection_error — retrying on a backoff can't fix it.
          if (err instanceof RealtimeAuthRefusedError) {
            await this.handleAuthRefusal(userToken, channels);
            return;
          }
          throw err;
        }
        this.openWebSocket(serverConfig.endpoint, auth);
        return;
      }
      // Unknown protocol — close cleanly so consumers don't get stuck in
      // 'connecting'. New transports must be added explicitly here.
      this.setState('closed');
    } catch (err) {
      this.beginTransient(
        'setup_failed',
        `could not reach Bridge to set up the connection (${errorText(err)})`,
        'warn',
      );
      this.setState('closed');
      this.scheduleReconnect();
    }
  }

  /** Close the connection. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearSubscribeAckTimer();
    this.removeResumeListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'sdk.stop');
      } catch {
        // ignore
      }
      this.ws = undefined;
    }
    this.episode = undefined;
    this.clearRefusal();
    this.setState('closed');
  }

  /** Read connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Channels this client subscribes to — the three canonical channels:
   *   - `app:<appId>`           — flag mutations, app config (app-scoped)
   *   - `workspace:<wsId>`      — subscription, quota, entitlement (tenant-scoped)
   *   - `user:<userId>`         — user-state, role/attr change (user-scoped)
   *
   * Each id is optional; the SDK skips the channel if its id isn't configured.
   * The anonymous-only standalone case ends up with just `app:<appId>`.
   */
  channelsToSubscribe(): string[] {
    const out: string[] = [];
    if (this.cfg.appId) out.push(`app:${this.cfg.appId}`);
    if (this.cfg.workspaceId) out.push(`workspace:${this.cfg.workspaceId}`);
    if (this.cfg.userId) out.push(`user:${this.cfg.userId}`);
    return out;
  }

  // ── private ───────────────────────────────────────────────────────────────

  private async fetchServerConfig(): Promise<RealtimeServerConfig> {
    const res = await this.cfg.fetchFn(`${this.cfg.apiBaseUrl}/realtime/config`, {
      method: 'GET',
      headers: { 'x-api-key': this.cfg.apiKey },
    });
    if (!res.ok) {
      throw new Error(`realtime config fetch failed: ${res.status}`);
    }
    return (await res.json()) as RealtimeServerConfig;
  }

  private async authorize(channels: string[], userToken: string | undefined): Promise<AuthorizeResponse> {
    const token = userToken ?? this.cfg.apiKey;
    const res = await this.cfg.fetchFn(`${this.cfg.apiBaseUrl}/realtime/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channels }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new RealtimeAuthRefusedError(res.status);
    }
    if (!res.ok) {
      throw new Error(`realtime authorize failed: ${res.status}`);
    }
    return (await res.json()) as AuthorizeResponse;
  }

  private openWebSocket(endpoint: string, auth: AuthorizeResponse): void {
    const ws = this.cfg.websocketFactory(endpoint);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelayMs = this.cfg.reconnectBaseMs;
      // Send connect with the signed token + channels. Centrifugo expects a
      // command frame like `{ "connect": { "token": "..." }, "id": 1 }` and
      // separate subscribe frames per channel. For v1 we send one connect
      // and let the server-side token's `channels` claim handle subscription.
      try {
        ws.send(JSON.stringify({ id: 1, connect: { token: auth.signedToken } }));
      } catch {
        // ignore
      }
      this.markOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      // Centrifugo v5 JSON protocol keepalive: the server periodically sends
      // an empty `{}` frame and expects an empty `{}` reply. Without this
      // echo the server closes the connection on its pong-timeout and the
      // SDK ends up in a perpetual reconnect loop.
      if (typeof ev.data === 'string' && ev.data === '{}') {
        try {
          ws.send('{}');
        } catch {
          // ignore — onclose will pick up a broken socket
        }
        return;
      }
      try {
        const parsed = parseMessage(ev.data);
        if (parsed) this.handleMessage(parsed);
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      // Identity guard — if we've already replaced this ws (e.g. via
      // reauthorize() dropping the ref before close), the late-firing onclose
      // is from a stale socket. Don't flap state or fire hooks.
      if (this.ws !== ws) return;
      this.noteClose(ws);
      this.setState('closed');
      try {
        this.onCloseHook?.();
      } catch {
        // hook errors must not block reconnect scheduling
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // Let onclose handle reconnect — errors are noisy but not actionable.
    };
  }

  /**
   * TBP-148 — AppSync Events transport.
   *
   * Wire protocol (AWS public spec for AppSync Events, distinct from the older
   * AppSync GraphQL `graphql-ws` subscriptions):
   *   - WebSocket to `wss://<endpoint>/event/realtime` (path appended if the
   *     endpoint from /realtime/config doesn't already include it — stage
   *     CFN output is the bare host today; the spec test uses the full URL).
   *   - Subprotocols: `['aws-appsync-event-ws', 'header-<base64url-json>']`.
   *     The `header-…` token carries auth, since browsers can't set arbitrary
   *     HTTP headers on a WebSocket.
   *   - After open: `{type:'connection_init'}` → server replies
   *     `{type:'connection_ack', connectionTimeoutMs}` → then one
   *     `{type:'subscribe', id, channel, authorization}` per channel.
   *   - Data: `{type:'data', id, event:'<json-string>'}` — `event` is a string
   *     (matches `appsync-events.adapter.ts:90` JSON.stringify).
   *   - Keepalive: server sends `{type:'ka'}` (silently ignored).
   *   - Channel wire format: `<ns>/<id>` (colon-to-slash; mirrors
   *     `appsync-events.adapter.ts:87` and `appsync-authorizer.handler.ts:59`).
   *
   * Anonymous flow: `getAuthToken()` returns undefined → Authorization sent as
   * the marker `REALTIME_ANONYMOUS_TOKEN` (see buildAppSyncAuthHeader for why
   * it can't be empty). The Lambda authorizer treats exactly that value as "no
   * token": CONNECT allowed, `app:<appId>` channels origin-checked against the
   * app's allowedOrigins, everything else denied `no_token`.
   */
  private openAppSyncWebSocket(endpoint: string, channels: string[]): void {
    const { url, httpHost } = normalizeAppSyncEndpoint(endpoint);
    // AWS spec: the auth header's `host` field refers to the HTTP endpoint
    // even when the wss:// call is made against the realtime endpoint. The
    // server-side validation uses this to verify the connection — sending
    // the realtime host instead produces a silent close 1000 right after
    // the WS upgrade succeeds.
    // Captured once: a refusal must be diagnosed against the token that was
    // actually presented, not whatever the host holds by the time we look.
    const token = this.currentToken();
    const authHeader = buildAppSyncAuthHeader(token, httpHost);
    const headerProtocol = `header-${base64urlEncode(JSON.stringify(authHeader))}`;

    const ws = this.cfg.websocketFactory(url, [APPSYNC_WS_PROTOCOL, headerProtocol]);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      // `state` stays 'connecting' until connection_ack lands — premature
      // transition would let the client miss server-side rejects (auth
      // failure surfaces as a quick close right after open).
      try {
        ws.send(JSON.stringify({ type: 'connection_init' }));
      } catch {
        // onclose will fire on a broken socket; no further work here.
      }
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let frame: {
        type?: unknown;
        id?: unknown;
        event?: unknown;
        errors?: unknown;
        message?: unknown;
      };
      try {
        frame = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      } catch {
        return; // malformed — ignore
      }
      if (!frame || typeof frame !== 'object') return;
      const type = typeof frame.type === 'string' ? frame.type : '';
      switch (type) {
        case 'connection_ack': {
          // Handshake complete — but NOT usable yet. The connection only
          // becomes 'open' once a channel subscription is accepted; see the
          // note on ConnectionState. Reporting 'open' here is what let a
          // fully deaf client look healthy in production (TBP-575).
          this.reconnectDelayMs = this.cfg.reconnectBaseMs;
          this.resetSubscribeTracking();
          for (const channel of channels) {
            const id = appSyncSubscriptionId();
            this.pendingSubscribes.set(id, channel);
            try {
              ws.send(
                JSON.stringify({
                  type: 'subscribe',
                  id,
                  channel: appSyncChannelToWire(channel),
                  authorization: authHeader,
                }),
              );
            } catch {
              // ignore — onclose will pick up a broken socket.
            }
          }
          // A server that accepts the socket and then silently ignores every
          // subscribe would otherwise sit in 'connecting' forever.
          this.subscribeAckTimer = setTimeout(() => {
            if (this.ws !== ws || this.ackedChannels.size > 0) return;
            this.cfg.logger.error(
              `realtime: connected to AppSync but no channel subscription was acknowledged within ${SUBSCRIBE_ACK_TIMEOUT_MS}ms — live updates are NOT arriving. Channels: ${channels.join(', ')}`,
            );
            this.markDegraded();
          }, SUBSCRIBE_ACK_TIMEOUT_MS);
          break;
        }
        case 'ka':
          // Keepalive — server-initiated, no client response required.
          break;
        case 'data': {
          // Per AWS spec, the `event` field is an **array of stringified JSON
          // values** (publish accepts `events: [...]`; data delivers `event:
          // [...]`). The backend currently publishes one entry per frame
          // (`events: [JSON.stringify(payload)]`), but the wire shape is an
          // array either way — iterate, decode each, dispatch independently.
          const rawList: unknown[] = Array.isArray(frame.event)
            ? (frame.event as unknown[])
            : typeof frame.event === 'string'
              ? [frame.event]
              : [];
          for (const raw of rawList) {
            if (typeof raw !== 'string') continue;
            let payload: unknown;
            try {
              payload = JSON.parse(raw);
            } catch {
              continue;
            }
            if (
              payload &&
              typeof payload === 'object' &&
              typeof (payload as { kind?: unknown }).kind === 'string'
            ) {
              try {
                this.handleMessage(payload as RealtimeMessage);
              } catch {
                // hook errors are isolated per-handler in handleMessage.
              }
            }
          }
          break;
        }
        case 'subscribe_success': {
          // Per-channel ack — the connection is only genuinely usable now.
          const id = typeof frame.id === 'string' ? frame.id : '';
          const channel = this.pendingSubscribes.get(id);
          if (channel) {
            this.pendingSubscribes.delete(id);
            this.ackedChannels.add(channel);
          }
          if (this.state !== 'open') {
            this.clearSubscribeAckTimer();
            this.markOpen();
          }
          break;
        }
        case 'subscribe_error': {
          // A rejected channel is NOT a reason to drop the socket. Tearing the
          // connection down here turned a permanent per-channel fault into an
          // endless reconnect loop that never surfaced anything (TBP-575).
          const id = typeof frame.id === 'string' ? frame.id : '';
          const channel = this.pendingSubscribes.get(id) ?? '(unknown channel)';
          this.pendingSubscribes.delete(id);
          this.failedChannels.set(channel, describeAppSyncError(frame));
          this.cfg.logger.error(
            `realtime: AppSync rejected subscription to '${channel}' — ${describeAppSyncError(frame)}. Live updates will not arrive on this channel.`,
          );
          // Every channel rejected → connected but deaf.
          if (this.pendingSubscribes.size === 0 && this.ackedChannels.size === 0) {
            this.clearSubscribeAckTimer();
            this.markDegraded();
          }
          break;
        }
        case 'connection_error':
        case 'error':
          // TBP-643 — an auth refusal is not a blip. Reconnecting with the same
          // token can only be refused again; before this branch existed the
          // client did exactly that on a backoff loop forever, logging a
          // reason-less line each time. AppSync never relays the authorizer's
          // reason, so detect by errorType/errorCode and work out the "why"
          // ourselves (pre-checks → one refresh → one diagnose).
          if (isAppSyncAuthRefusal(frame)) {
            this.detachSocket(ws, `appsync:${type}`);
            void this.handleAuthRefusal(token, channels);
            break;
          }
          // Anything else is a connection-level fault worth retrying. Logged
          // once per episode (beginTransient), not once per attempt.
          this.beginTransient(
            'server_error',
            `the realtime server reported ${type}: ${describeAppSyncError(frame)}`,
            'error',
          );
          try {
            ws.close(1011, `appsync:${type}`);
          } catch {
            // ignore
          }
          break;
        default:
          // Unknown frame type — ignore. Forward-compatible with future
          // protocol additions (e.g. `keepalive`, `pong`, …).
          break;
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.noteClose(ws);
      this.setState('closed');
      this.resetSubscribeTracking();
      try {
        this.onCloseHook?.();
      } catch {
        // hook errors must not block reconnect scheduling.
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // Let onclose handle reconnect — errors are noisy but not actionable.
    };
  }

  // ── AppSync subscribe bookkeeping (TBP-575) ──────────────────────────────

  private resetSubscribeTracking(): void {
    this.clearSubscribeAckTimer();
    this.pendingSubscribes.clear();
    this.ackedChannels.clear();
    this.failedChannels.clear();
  }

  private clearSubscribeAckTimer(): void {
    if (this.subscribeAckTimer) {
      clearTimeout(this.subscribeAckTimer);
      this.subscribeAckTimer = undefined;
    }
  }

  /**
   * Connected, handshaken, and subscribed to nothing. Deliberately does NOT
   * close the socket: the fault is per-channel and reconnecting would just
   * reproduce it in a loop. Consumers are told so they can fall back to
   * polling or warn the user.
   */
  private markDegraded(): void {
    // The transport did come back; degraded has its own error log above, so a
    // pending "restored" line would be misleading — drop the episode quietly.
    this.episode = undefined;
    this.setState('degraded');
    try {
      this.onDegradedHook?.();
    } catch {
      // hook errors must not break the connection.
    }
  }

  /** Channels rejected by the server on the current connection, if any. */
  getFailedChannels(): Record<string, string> {
    return Object.fromEntries(this.failedChannels);
  }

  private emitFlagChange(change: FlagChange): void {
    if (!this.onFlagChangeHook) return;
    try {
      this.onFlagChangeHook(change);
    } catch (err) {
      // A consumer's guard re-check must never take down the connection.
      this.cfg.logger.warn('onFlagChange hook threw', err);
    }
  }

  private handleMessage(msg: RealtimeMessage): void {
    switch (msg.kind) {
      case 'flag.updated':
        if (this.bridge && msg.flag) this.bridge.upsert(msg.flag);
        // Fire even when no BridgeFlags is attached — the route-guard cache is
        // a separate consumer and must be invalidated either way (TBP-575).
        if (msg.flag?.key) this.emitFlagChange({ key: msg.flag.key, kind: 'updated' });
        break;
      case 'flag.removed':
        if (this.bridge && msg.key) this.bridge.remove(msg.key);
        if (msg.key) this.emitFlagChange({ key: msg.key, kind: 'removed' });
        break;
      case 'user.state_changed':
        if (this.onUserStateHook) {
          try {
            this.onUserStateHook(msg);
          } catch {
            // ignore
          }
        }
        break;
      case 'subscription.plan_changed':
        if (this.onSubscriptionPlanChangedHook) {
          try {
            this.onSubscriptionPlanChangedHook(msg);
          } catch {
            // ignore
          }
        }
        break;
      case 'payment.failed':
      case 'payment.succeeded':
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.canceled':
      case 'subscription.reactivated':
      case 'subscription.trial_started':
      case 'subscription.trial_ending_soon':
      case 'subscription.trial_converted':
      case 'subscription.trial_expired':
      case 'dunning.entered':
      case 'dunning.retry_scheduled':
      case 'dunning.recovered':
      case 'dunning.exhausted':
        if (this.onBillingLifecycleHook) {
          try {
            this.onBillingLifecycleHook(msg as BillingLifecycleMessage);
          } catch {
            // ignore
          }
        }
        break;
      case 'entitlements.changed':
        // bridge-api always publishes the payload-carrying shape (US-12);
        // the pre-prod signal-only fallback was removed at milestone close-out.
        if (this.onEntitlementsChangedHook) {
          try {
            this.onEntitlementsChangedHook(msg as EntitlementsChangedMessage);
          } catch {
            // ignore
          }
        }
        break;
      case 'quota.updated':
        if (this.onQuotaUpdatedHook) {
          try {
            this.onQuotaUpdatedHook(msg as QuotaUpdatedMessage);
          } catch {
            // ignore
          }
        }
        break;
      case 'session.snapshot':
        // Phase 3 (TBP-287/314) — first-paint snapshot. Defensive check on
        // `data` because the wire shape is deeper than the other kinds and
        // a partial server might omit it; we never want to call the hook
        // with `undefined`.
        if (this.onSnapshotHook && (msg as SessionSnapshotMessage).data) {
          try {
            this.onSnapshotHook(msg as SessionSnapshotMessage);
          } catch {
            // ignore
          }
        }
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.fireReconnect();
    }, this.reconnectDelayMs);
    if ((this.reconnectTimer as any)?.unref) (this.reconnectTimer as any).unref();
  }

  private fireReconnect(): void {
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.cfg.reconnectMaxMs);
    if (this.episode) this.episode.attempts++;
    void this.start();
  }

  // ── Status + fault reporting (TBP-643) ────────────────────────────────────

  private setState(state: ConnectionState): void {
    this.state = state;
    this.publishStatus();
  }

  private publishStatus(): void {
    const detail = this.statusDetail();
    const prev = this.status;
    if (
      prev.state === this.state &&
      prev.reason === detail.reason &&
      prev.side === detail.side &&
      prev.retrying === detail.retrying &&
      prev.ref === detail.ref
    ) {
      return;
    }
    this.status = { state: this.state, ...detail, since: Date.now() };
    if (!this.onStatusChangeHook) return;
    try {
      this.onStatusChangeHook({ ...this.status });
    } catch {
      // a consumer's indicator must never break the connection.
    }
  }

  private statusDetail(): Omit<RealtimeStatus, 'state' | 'since'> {
    if (this.state === 'unauthorized' && this.refusal) {
      const r = this.refusal;
      return { reason: r.reason, side: r.side, retrying: false, docsUrl: r.docsUrl, ref: r.ref };
    }
    if (this.state === 'degraded') return { reason: 'no_channel_accepted', retrying: false };
    const ep = this.episode;
    if (ep?.kind === 'transient') {
      return { reason: ep.reason, side: 'network', retrying: true, ref: ep.ref };
    }
    // Auth episode in flight: refreshing or diagnosing — not given up yet.
    if (ep?.kind === 'auth') return { reason: ep.reason, retrying: true, ref: ep.ref };
    return { retrying: false };
  }

  /** The token to present — see `freshToken`. */
  private currentToken(): string | undefined {
    const host = this.cfg.getAuthToken?.();
    if (this.freshToken !== undefined) {
      if (host === this.staleToken) return this.freshToken;
      // The host has caught up (or moved on) — its value wins from here.
      this.freshToken = undefined;
      this.staleToken = undefined;
    }
    return host;
  }

  /** The transport is usable. Closes any episode, logging recovery if we logged the fault. */
  private markOpen(): void {
    const ep = this.episode;
    this.episode = undefined;
    this.lastRefusalKey = undefined;
    this.setState('open');
    if (ep?.kind === 'transient' && ep.logLevel) {
      const n = Math.max(ep.attempts, 1);
      this.cfg.logger[ep.logLevel](
        `[bridge] Live updates restored after ${n} attempt${n === 1 ? '' : 's'}.`,
      );
    }
    try {
      this.onOpenHook?.();
    } catch {
      // hook errors must not break the connection.
    }
  }

  /** Called from onclose of the CURRENT socket: an unplanned close starts a transient episode. */
  private noteClose(ws: WebSocketLike): void {
    if (this.expectedCloseWs === ws) {
      this.expectedCloseWs = undefined;
      return;
    }
    this.beginTransient('connection_lost', 'the realtime connection dropped', 'warn');
  }

  /**
   * Open a transient episode if none is running, and log its start ONCE.
   * Server-reported errors log at `error` (they used to, and they are real
   * faults); plain drops and fetch failures log at `warn` — sleep/wake and
   * wifi changes cause them constantly and they fix themselves, so they must
   * not paint every end-user console red.
   */
  private beginTransient(reason: string, detail: string, level: 'error' | 'warn'): void {
    if (this.episode) return;
    const ref = newRef();
    this.episode = {
      kind: 'transient',
      ref,
      attempts: 0,
      reason,
      logLevel: level,
      refreshed: false,
      diagnosed: false,
    };
    this.cfg.logger[level](
      `[bridge] Live updates interrupted — ${detail}. Retrying in the background; plan, entitlement and feature-flag changes resume when it reconnects. ref ${ref}`,
    );
  }

  /** Drop a socket without letting its onclose schedule a reconnect. */
  private detachSocket(ws: WebSocketLike, reason: string): void {
    if (this.ws === ws) this.ws = undefined;
    this.resetSubscribeTracking();
    try {
      ws.close(1011, reason);
    } catch {
      // ignore
    }
    try {
      this.onCloseHook?.();
    } catch {
      // hook errors must not break refusal handling.
    }
  }

  /**
   * Bridge refused `token` (TBP-643). Policy, in order:
   *   a. client-side pre-checks on the token — cheap, and they name the fix;
   *   b. one host refresh + an immediate reconnect, if the host gave us a hook;
   *   c. if still refused and the pre-checks found nothing, ask Bridge once;
   *   d. park in 'unauthorized', stop reconnecting, log ONE message.
   * Resumes on reauthorize(), a changed token on start(), `online`, or the
   * tab becoming visible.
   */
  private async handleAuthRefusal(token: string | undefined, channels: string[]): Promise<void> {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    let ep = this.episode;
    if (!ep || ep.kind !== 'auth') {
      ep = {
        kind: 'auth',
        ref: newRef(),
        attempts: 0,
        reason: 'refused',
        refreshed: false,
        diagnosed: false,
      };
      this.episode = ep;
    }
    this.setState('connecting');

    if (this.cfg.refreshAuthToken && !ep.refreshed) {
      ep.refreshed = true;
      let fresh: string | undefined;
      try {
        fresh = await this.cfg.refreshAuthToken();
      } catch {
        fresh = undefined;
      }
      if (this.episode !== ep || this.stopped) return;
      // Same token back = nothing to retry with; fall through to diagnosis.
      if (fresh && fresh !== token) {
        this.freshToken = fresh;
        this.staleToken = this.cfg.getAuthToken?.();
        this.setState('closed');
        await this.start();
        return;
      }
    }

    let verdict = this.precheckToken(token, channels);
    if (!verdict && this.cfg.diagnose && !ep.diagnosed) {
      ep.diagnosed = true;
      verdict = await this.diagnoseRefusal(token, channels, ep.ref);
      if (this.episode !== ep || this.stopped) return;
    }
    // Nothing explained it. With a token: Bridge-issued, unexpired, right
    // environment and app, yet refused — Bridge's problem, not the app's.
    // Without one: the server would not take an anonymous connect (e.g. an
    // authorizer that predates the anonymous marker). That is not a fault in
    // the app either, but "a problem on Bridge's side" would send developers
    // chasing an outage — it gets its own reason and wording, and the parked
    // client resumes as soon as a user signs in.
    const fallback: RefusalVerdict = token
      ? { reason: 'refused', side: 'bridge' }
      : { reason: 'anonymous_refused', side: 'bridge' };
    this.enterUnauthorized(token, verdict ?? fallback, ep);
  }

  /** Explain a refusal from the token alone. Decodes without verifying — this is diagnosis, not auth. */
  private precheckToken(token: string | undefined, channels: string[]): RefusalVerdict | undefined {
    if (!token) {
      // Anonymous is a legitimate state for app-only channels (`app:<id>`).
      // It is only a fault when a channel needs a user — workspace, user,
      // integration: anything that is not `app:`.
      return channels.some((c) => !c.startsWith('app:'))
        ? { reason: 'no_token', side: 'app' }
        : undefined;
    }
    const claims = decodeJwtPayload(token);
    if (!claims) return { reason: 'malformed', side: 'app' };
    const expectedIssuer = `${this.cfg.apiBaseUrl}/auth`;
    if (typeof claims.iss === 'string' && !claims.iss.startsWith(expectedIssuer)) {
      return { reason: 'wrong_environment', side: 'config', tokenIssuer: claims.iss };
    }
    if (this.cfg.appId && typeof claims.aid === 'string' && claims.aid !== this.cfg.appId) {
      return { reason: 'wrong_app', side: 'config', tokenAppId: claims.aid };
    }
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
      return { reason: 'expired', side: 'app' };
    }
    return undefined;
  }

  /**
   * Ask Bridge why it refused (contract: `POST /realtime/diagnose` →
   * `{ ok, reason, side }`, sharing the authorizer's classifier). The endpoint
   * may not exist yet — any failure returns undefined and the caller falls
   * back to 'refused'.
   */
  private async diagnoseRefusal(
    token: string | undefined,
    channels: string[],
    ref: string,
  ): Promise<RefusalVerdict | undefined> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-bridge-realtime-ref': ref,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.cfg.appId) headers['x-app-id'] = this.cfg.appId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('diagnose timed out')), DIAGNOSE_TIMEOUT_MS);
      });
      const res = await Promise.race([
        this.cfg.fetchFn(`${this.cfg.apiBaseUrl}/realtime/diagnose`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ channels }),
        }),
        timeout,
      ]);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { ok?: unknown; reason?: unknown; side?: unknown };
      // Bridge sees nothing wrong — no verdict; the caller's fallback applies.
      if (body?.ok === true) return undefined;
      const reason =
        typeof body?.reason === 'string' && /^[a-z0-9_]+$/.test(body.reason) ? body.reason : 'refused';
      const side: RefusalSide =
        body?.side === 'app' || body?.side === 'config' || body?.side === 'bridge' ? body.side : 'bridge';
      return { reason, side };
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private enterUnauthorized(token: string | undefined, verdict: RefusalVerdict, ep: FaultEpisode): void {
    const docsUrl = `${this.cfg.docsBaseUrl}#${verdict.reason}`;
    this.refusal = { ...verdict, token, ref: ep.ref, docsUrl };
    this.episode = undefined;
    this.setState('unauthorized');
    this.startParkedTokenCheck();
    const message = this.formatRefusal(this.refusal);
    const key = `${token ?? ''}|${verdict.reason}|${verdict.side}`;
    if (key === this.lastRefusalKey) {
      this.cfg.logger.debug(message);
      return;
    }
    this.lastRefusalKey = key;
    this.cfg.logger.error(message);
  }

  private clearRefusal(): void {
    this.refusal = undefined;
    if (this.parkedTokenTimer) {
      clearInterval(this.parkedTokenTimer);
      this.parkedTokenTimer = undefined;
    }
  }

  /**
   * A parked client must resume when the host's token changes — most
   * importantly when a signed-out session signs in (undefined → token).
   * Framework SDKs only call reauthorize() when one token REPLACES another
   * (TBP-644 fixes that), so auth-core can't rely on being told.
   *
   * Chosen over a `notifyAuthTokenChanged()` API because it needs no host
   * change — the missing host call is the bug. It is cheap and bounded: it
   * runs only while parked, calls the synchronous `getAuthToken()` getter (no
   * network), and resumes only on a token DIFFERENT from the refused one, so
   * an unchanged session can never turn it into a reconnect loop.
   */
  private startParkedTokenCheck(): void {
    if (this.parkedTokenTimer || !this.cfg.getAuthToken) return;
    this.parkedTokenTimer = setInterval(() => {
      if (this.state !== 'unauthorized' || this.stopped) {
        this.clearRefusal();
        return;
      }
      if (this.currentToken() !== this.refusal?.token) void this.start();
    }, PARKED_TOKEN_CHECK_MS);
    if ((this.parkedTokenTimer as any)?.unref) (this.parkedTokenTimer as any).unref();
  }

  /**
   * The one message a developer gets per refused episode. Product terms, whose
   * side it is, what still works, one next step, a docs link and a ref.
   */
  private formatRefusal(r: Refusal): string {
    const stopped =
      '  Stopped: plan & entitlement changes, feature-flag flips, the plan-changed token refresh. They appear only after a reload.';
    const stillFine = '  Still fine: every API call your app makes.';
    const footer = `  ${r.docsUrl} · ref ${r.ref}`;
    if (r.reason === 'anonymous_refused') {
      return [
        `[bridge] Live updates are unavailable before sign-in — Bridge did not accept this signed-out session's realtime connection (${r.reason}).`,
        '  They start automatically once a user signs in. Until then, feature-flag flips appear only after a reload.',
        stillFine,
        '  Nothing to change in your code.',
        footer,
      ].join('\n');
    }
    if (r.side === 'bridge') {
      return [
        "[bridge] Live updates are OFF — this is a problem on Bridge's side, not in your app.",
        `  Bridge refused this session's realtime connection (${r.reason}) although the session token checks out.`,
        stopped,
        stillFine,
        `  Nothing to change in your code — include ref ${r.ref} if you contact support.`,
        footer,
      ].join('\n');
    }
    if (r.side === 'config') {
      const apiHost = hostOf(this.cfg.apiBaseUrl);
      let mismatch: string;
      let fix: string;
      if (r.reason === 'wrong_environment' && r.tokenIssuer) {
        const tokenHost = hostOf(r.tokenIssuer);
        mismatch = `  This app's Bridge API host is ${apiHost}, but the signed-in session's token was issued by ${tokenHost}.`;
        fix = `  Fix: point the Bridge API base URL setting (apiBaseUrl) at ${tokenHost}, or sign users in against ${apiHost} — both must be the same environment.`;
      } else if (r.reason === 'wrong_app' && r.tokenAppId) {
        mismatch = `  This app is configured with app id ${this.cfg.appId}, but the signed-in session's token belongs to app ${r.tokenAppId}.`;
        fix = `  Fix: set the appId setting to ${r.tokenAppId}, or sign users in through app ${this.cfg.appId} — both must name the same app.`;
      } else {
        mismatch = `  This app's Bridge settings (API host ${apiHost}${this.cfg.appId ? `, app id ${this.cfg.appId}` : ''}) don't match the signed-in session.`;
        fix = `  Fix: correct the Bridge setting the docs entry below names for '${r.reason}'.`;
      }
      return [
        `[bridge] Live updates are OFF — Bridge refused this session's realtime connection (${r.reason}): your Bridge settings don't match the session.`,
        mismatch,
        stopped,
        fix,
        footer,
      ].join('\n');
    }
    return [
      `[bridge] Live updates are OFF — Bridge refused this session's realtime connection (${r.reason}).`,
      stopped,
      stillFine,
      `  Fix: ${appFix(r.reason)}.`,
      footer,
    ].join('\n');
  }

  // ── Resume triggers (browser only; guarded so Node/SSR never touches them) ──

  private readonly onOnline = (): void => this.nudge();

  private readonly onVisibilityChange = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((globalThis as any).document?.visibilityState === 'visible') this.nudge();
  };

  private installResumeListeners(): void {
    if (this.resumeListenersInstalled) return;
    this.resumeListenersInstalled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.addEventListener === 'function') g.addEventListener('online', this.onOnline);
    if (typeof g.document?.addEventListener === 'function') {
      g.document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  private removeResumeListeners(): void {
    if (!this.resumeListenersInstalled) return;
    this.resumeListenersInstalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.removeEventListener === 'function') g.removeEventListener('online', this.onOnline);
    if (typeof g.document?.removeEventListener === 'function') {
      g.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  /**
   * The network came back or the user returned to the tab: the conditions
   * behind a refusal may have changed (host refreshed the session, clock
   * caught up), so a parked client gets one new episode; a client waiting out
   * a backoff tries now instead.
   */
  private nudge(): void {
    if (!this.cfg.enabled || this.stopped) return;
    if (this.state === 'unauthorized') {
      this.clearRefusal();
      this.setState('closed');
      void this.start();
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.fireReconnect();
    }
  }
}

/** Reason-specific next step for app-side refusals. */
function appFix(reason: string): string {
  switch (reason) {
    case 'no_token':
      return "start live updates after sign-in, or pass getAuthToken so the client can read the session's access token";
    case 'expired':
      return 'the access token expired and was not refreshed — pass refreshAuthToken to the realtime client (the framework SDKs do this for you), or refresh the session and call reauthorize()';
    case 'malformed':
      return 'getAuthToken must return the Bridge access token (a JWT) — not an ID token, an API key or another string';
    default:
      return `see the docs entry below for what '${reason}' means for this session`;
  }
}

function parseMessage(raw: unknown): RealtimeMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Centrifugo wraps publish data in `{ push: { channel, pub: { data: {...} } } }`.
  // We accept both that shape and a flat `{ kind: ... }` shape so the same
  // client works with simpler transports too.
  const data =
    parsed?.push?.pub?.data ??
    parsed?.pub?.data ??
    parsed;
  if (!data || typeof data !== 'object' || typeof data.kind !== 'string') return null;
  return data as RealtimeMessage;
}

// ── AppSync Events helpers (TBP-148) ─────────────────────────────────────────

/**
 * Best-effort human-readable reason out of an AppSync error frame (TBP-575).
 *
 * AppSync is inconsistent about where it puts the reason — sometimes
 * `errors: [{ message }]`, sometimes a bare `message`. Previously the client
 * discarded all of it, which is why a channel-format bug went undiagnosed for
 * months. Anything is better than nothing here, so fall back to the raw frame.
 */
function describeAppSyncError(frame: { errors?: unknown; message?: unknown }): string {
  const { message } = frame;
  const errors = appSyncErrors(frame);
  if (errors.length > 0) {
    const parts = errors
      .map((e) => {
        if (typeof e === 'string') return e;
        const m = (e as { message?: unknown })?.message;
        if (typeof m === 'string') return m;
        const t = (e as { errorType?: unknown })?.errorType;
        return typeof t === 'string' ? t : undefined;
      })
      .filter((m): m is string => !!m);
    if (parts.length > 0) return parts.join('; ');
  }
  if (typeof message === 'string' && message) return message;
  try {
    return JSON.stringify(frame);
  } catch {
    return 'no error detail supplied by the server';
  }
}

/** AppSync puts `errors` at the top level or under `payload` — accept both. */
function appSyncErrors(frame: { errors?: unknown; payload?: unknown }): unknown[] {
  if (Array.isArray(frame.errors)) return frame.errors;
  const nested = (frame.payload as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(nested) ? nested : [];
}

/**
 * TBP-643 — is this error frame an auth refusal? AppSync Events does NOT relay
 * the authorizer's reason and often sends no message text at all, so match on
 * errorType / errorCode only, never on wording.
 */
function isAppSyncAuthRefusal(frame: { errors?: unknown; payload?: unknown }): boolean {
  return appSyncErrors(frame).some((e) => {
    if (!e || typeof e !== 'object') return false;
    const { errorType, errorCode } = e as { errorType?: unknown; errorCode?: unknown };
    if (typeof errorType === 'string' && /^unauthori[sz]ed/i.test(errorType)) return true;
    const code = typeof errorCode === 'string' ? Number(errorCode) : errorCode;
    return code === 401 || code === 403;
  });
}

/** Decode a JWT payload WITHOUT verifying it. undefined = not a JWT. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const json =
      typeof g.atob === 'function'
        ? decodeURIComponent(escape(g.atob(padded)))
        : g.Buffer.from(padded, 'base64').toString('utf-8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Short per-episode correlation id — quoted in logs, sent to Bridge on diagnose. */
function newRef(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.crypto?.getRandomValues === 'function') {
    const bytes = g.crypto.getRandomValues(new Uint8Array(4)) as Uint8Array;
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/** Subprotocol identifier for AppSync Events realtime channels. */
const APPSYNC_WS_PROTOCOL = 'aws-appsync-event-ws';

/**
 * Normalize the realtime endpoint to a full `wss://…/event/realtime` URL and
 * compute the matching HTTP host (needed in the auth header — AppSync
 * server-side validation uses the HTTP host, NOT the realtime host).
 *
 * Stage's CFN output currently surfaces a bare host (`<id>.appsync-realtime-api.<region>.amazonaws.com`),
 * while the backend spec tests use the fully-qualified `wss://…/event/realtime`.
 * Both must work — this normalizer accepts either.
 *
 * HTTP-host derivation: AWS uses two parallel domains for AppSync Events:
 *   wss://<id>.appsync-realtime-api.<region>.amazonaws.com/event/realtime
 *   https://<id>.appsync-api.<region>.amazonaws.com/event
 * The HTTP host is the realtime host with `appsync-realtime-api` swapped for
 * `appsync-api`. Custom domains skip the suffix entirely (host == http host).
 */
function normalizeAppSyncEndpoint(endpoint: string): { url: string; httpHost: string } {
  let raw = endpoint.trim();
  if (!raw.startsWith('ws://') && !raw.startsWith('wss://')) {
    raw = `wss://${raw}`;
  }
  raw = raw.replace(/\/+$/, '');
  if (!/\/event\/realtime$/.test(raw)) {
    raw = `${raw}/event/realtime`;
  }
  let realtimeHost = '';
  try {
    realtimeHost = new URL(raw).host;
  } catch {
    realtimeHost = endpoint.replace(/^wss?:\/\//, '').split('/')[0] ?? '';
  }
  // Swap the realtime suffix → http suffix. If the host doesn't match the
  // standard AppSync naming (e.g. custom domain), pass it through unchanged
  // — the same host serves both endpoints on custom domains.
  const httpHost = realtimeHost.replace('.appsync-realtime-api.', '.appsync-api.');
  return { url: raw, httpHost };
}

/**
 * Build the AppSync Events auth header carried in the `header-…` subprotocol
 * token — and in every subscribe frame's `authorization`. This is the ONLY
 * place the anonymous value is decided.
 *
 * Anonymous sessions send `Authorization: REALTIME_ANONYMOUS_TOKEN`, never ''.
 * TBP-643 — AppSync rejects an empty Authorization itself, BEFORE the Lambda
 * authorizer runs (`connection_error` / UnauthorizedException 401, no
 * message), so with '' the authorizer's anonymous-CONNECT branch was
 * unreachable and no signed-out session could ever connect. The authorizer
 * treats exactly this marker as "no token" (app channels origin-checked,
 * everything else denied `no_token`).
 */
function buildAppSyncAuthHeader(
  token: string | undefined,
  host: string,
): { Authorization: string; host: string } {
  return {
    Authorization: token ? `Bearer ${token}` : REALTIME_ANONYMOUS_TOKEN,
    host,
  };
}

/**
 * Base64url-encode a UTF-8 string. AppSync Events expects the `header-…`
 * subprotocol token to be base64url (no padding). Uses `btoa` when available
 * (every modern browser + Node ≥16 globalThis); falls back to a manual encode
 * for the rare environment where it isn't.
 */
function base64urlEncode(input: string): string {
  let b64: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.btoa === 'function') {
    // btoa wants binary string; encode UTF-8 → bytes first so non-ASCII JWTs
    // survive (rare but legal — JWT header/claims can be unicode).
    const utf8 = unescape(encodeURIComponent(input));
    b64 = g.btoa(utf8);
  } else if (typeof g.Buffer?.from === 'function') {
    b64 = g.Buffer.from(input, 'utf-8').toString('base64');
  } else {
    // No encoder available — return the raw input. Will fail the handshake,
    // but loudly (Lambda authorizer rejects), which is preferable to silent
    // corruption.
    return input;
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Translate internal channel name (`<ns>:<id>`) to the AppSync wire form
 * (`/<ns>/<id>`). Mirrors the publish side at
 * `microservices/shared/realtime/adapters/appsync-events.adapter.ts:87`
 * and the Lambda authorizer's normalizer at
 * `microservices/shared/realtime/appsync-authorizer.ts:63`.
 *
 * TBP-575 — the LEADING SLASH is load-bearing and was missing here for the
 * whole life of the AppSync transport. AppSync Events addresses channels as
 * `/<namespace>/<path>`; without the slash the namespace never resolves, so
 * every `subscribe` was rejected and no client on prod ever received a flag
 * push. The publish side always sent `/app/<id>`, so the two ends were
 * addressing different channels even where AppSync tolerated the form.
 *
 * Both ends are pinned to the shared vectors in `appsync-channel-vectors.ts`
 * — change one and the other repo's test fails. Do not "simplify" this.
 */
export function appSyncChannelToWire(internal: string): string {
  return `/${internal.replace(':', '/')}`;
}

/**
 * Stable per-subscribe identifier. Prefer `crypto.randomUUID()` (ES2022,
 * available in every supported runtime — browser globals + Node ≥19); fall
 * back to a Math.random-based id for the rare environment where it isn't.
 */
function appSyncSubscriptionId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID() as string;
  }
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
