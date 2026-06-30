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

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

export class RealtimeClient {
  private readonly cfg: Required<
    Omit<RealtimeClientConfig, 'appId' | 'workspaceId' | 'userId' | 'websocketFactory' | 'fetchFn' | 'getAuthToken'>
  > & {
    appId?: string;
    workspaceId?: string;
    userId?: string;
    websocketFactory: (url: string, protocols?: string | string[]) => WebSocketLike;
    fetchFn: typeof fetch;
    getAuthToken: (() => string | undefined) | undefined;
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
  private stopped = false;

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
    };
    this.reconnectDelayMs = this.cfg.reconnectBaseMs;
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
   * Register a hook fired when the WebSocket transitions to `'open'` —
   * fires on initial connect AND on every successful reconnect. Framework
   * SDKs use this to re-fire startup tasks (e.g. cache hydration) that
   * may have been missed during an outage.
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
    if (this.state === 'connecting') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectDelayMs = this.cfg.reconnectBaseMs;
    if (this.state === 'open' && this.ws) {
      const oldWs = this.ws;
      this.ws = undefined;
      this.state = 'closed';
      try {
        oldWs.close(1000, 'sdk.reauthorize');
      } catch {
        // ignore
      }
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
    if (this.state === 'open' && this.ws) {
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
    if (this.state === 'open' && this.ws) {
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
    if (this.state === 'open' && this.ws) {
      this.ws.close(1000, 'sdk.setUserId');
      // onclose fires → scheduleReconnect → start() picks up updated channelsToSubscribe()
    }
  }

  /** Begin connecting. Idempotent. */
  async start(): Promise<void> {
    if (!this.cfg.enabled || this.stopped) return;
    if (this.state !== 'idle' && this.state !== 'closed') return;

    this.state = 'connecting';
    try {
      const serverConfig = await this.fetchServerConfig();
      if (serverConfig.kind === 'noop' || !serverConfig.endpoint) {
        this.state = 'closed';
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
        const auth = await this.authorize(channels);
        this.openWebSocket(serverConfig.endpoint, auth);
        return;
      }
      // Unknown protocol — close cleanly so consumers don't get stuck in
      // 'connecting'. New transports must be added explicitly here.
      this.state = 'closed';
    } catch {
      this.state = 'closed';
      this.scheduleReconnect();
    }
  }

  /** Close the connection. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
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
    this.state = 'closed';
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

  private async authorize(channels: string[]): Promise<AuthorizeResponse> {
    const token = this.cfg.getAuthToken?.() ?? this.cfg.apiKey;
    const res = await this.cfg.fetchFn(`${this.cfg.apiBaseUrl}/realtime/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channels }),
    });
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
      this.state = 'open';
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
      try {
        this.onOpenHook?.();
      } catch {
        // hook errors must not break the connection
      }
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
      this.state = 'closed';
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
   * empty string. The Lambda authorizer accepts that only for `app:<appId>`
   * channels whose origin matches the app's allowedOrigins (demo path).
   */
  private openAppSyncWebSocket(endpoint: string, channels: string[]): void {
    const { url, httpHost } = normalizeAppSyncEndpoint(endpoint);
    // AWS spec: the auth header's `host` field refers to the HTTP endpoint
    // even when the wss:// call is made against the realtime endpoint. The
    // server-side validation uses this to verify the connection — sending
    // the realtime host instead produces a silent close 1000 right after
    // the WS upgrade succeeds.
    const authHeader = buildAppSyncAuthHeader(this.cfg.getAuthToken?.(), httpHost);
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
      let frame: { type?: unknown; id?: unknown; event?: unknown };
      try {
        frame = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      } catch {
        return; // malformed — ignore
      }
      if (!frame || typeof frame !== 'object') return;
      const type = typeof frame.type === 'string' ? frame.type : '';
      switch (type) {
        case 'connection_ack': {
          // Handshake complete — open the gate for app traffic.
          this.state = 'open';
          this.reconnectDelayMs = this.cfg.reconnectBaseMs;
          for (const channel of channels) {
            try {
              ws.send(
                JSON.stringify({
                  type: 'subscribe',
                  id: appSyncSubscriptionId(),
                  channel: appSyncChannelToWire(channel),
                  authorization: authHeader,
                }),
              );
            } catch {
              // ignore — onclose will pick up a broken socket.
            }
          }
          try {
            this.onOpenHook?.();
          } catch {
            // hook errors must not break the connection.
          }
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
        case 'subscribe_success':
          // Per-channel ack — no action required, server now streams data.
          break;
        case 'connection_error':
        case 'subscribe_error':
        case 'error':
          // Server-side reject — close cleanly so onclose triggers reconnect.
          // We intentionally don't surface the error message: the next
          // connect's authorize will succeed or fail with the same signal.
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
      this.state = 'closed';
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

  private handleMessage(msg: RealtimeMessage): void {
    switch (msg.kind) {
      case 'flag.updated':
        if (this.bridge && msg.flag) this.bridge.upsert(msg.flag);
        break;
      case 'flag.removed':
        if (this.bridge && msg.key) this.bridge.remove(msg.key);
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
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.cfg.reconnectMaxMs);
      void this.start();
    }, this.reconnectDelayMs);
    if ((this.reconnectTimer as any)?.unref) (this.reconnectTimer as any).unref();
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
 * token. Anonymous sessions send Authorization: '' — the Lambda authorizer
 * accepts that only for `app:<appId>` channels with a passing origin check.
 */
function buildAppSyncAuthHeader(
  token: string | undefined,
  host: string,
): { Authorization: string; host: string } {
  return {
    Authorization: token ? `Bearer ${token}` : '',
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
 * (`<ns>/<id>`). Mirrors the publish side at
 * `microservices/shared/realtime/adapters/appsync-events.adapter.ts:87`
 * and the Lambda authorizer's normalizer at
 * `microservices/shared/realtime/appsync-authorizer.handler.ts:59`.
 */
function appSyncChannelToWire(internal: string): string {
  return internal.replace(':', '/');
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
