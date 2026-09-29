// Billing 2.0 US-11 (TBP-263) — SDK quota cache + reactive surface.
//
// In-memory store keyed on metric. The store is the single source of truth
// for `useBridge().quota(metric)`:
//   - First call for a metric → hydrate via `GET /usage/quota/:metric`, mark
//     the entry as "loading" so subscribers see `undefined` until the server
//     replies.
//   - Live `quota.updated` pushes (via RealtimeClient.setOnQuotaUpdated) replace
//     the cached snapshot — last-write-wins.
//   - Subscribers receive snapshot notifications on every cache mutation.
//
// Framework-agnostic. bridge-svelte wraps `subscribe()` in a Svelte 5 rune.

import { httpFetch } from '../http.js';
import type { Logger } from '../logger.js';
import type { QuotaUpdatedMessage, RealtimeClient } from '../flags/realtime.js';

/** Public quota snapshot shape exposed to SDK consumers. */
export interface QuotaSnapshot {
  metric: string;
  used: number;
  limit: number;
  remaining: number;
  /** Convenience: `used / limit` clamped to [0, +inf). */
  percent_used: number;
  /**
   * US-12 — server-driven per-metric policy.
   *   - `metered` → Stripe bills the overage automatically; NO entitlement
   *     produced; UI shows "metered usage" copy.
   *   - `hard`    → entitlement flips to false at the cap; UI gates on
   *     `useBridge().entitlements.can(<key>)` instead of on the counter.
   *
   * Default for backward compatibility (pre-US-12 server payload missing
   * `policy`): `'metered'`.
   */
  policy: 'hard' | 'metered';
  /**
   * TBP-699 — `counter`: `used` is this billing period's total, reset each
   * period. `gauge`: `used` is how many exist right now (never reset), so a
   * UI can say "8 of 10 projects" rather than "8 used this month". The store
   * always sets it (`'counter'` for servers that predate gauges); optional in
   * the type only so snapshot literals written against older versions still
   * compile.
   */
  kind?: 'counter' | 'gauge';
  /**
   * TBP-763 — `membership`: a gauge Bridge counts itself from the workspace's
   * active members (seats); the app never reports it.
   */
  source?: 'membership';
  warningLevel: null | 'approaching' | 'critical';
  /** Display label. US-11 uses the raw metric key; framework wrappers can override. */
  label: string;
  /**
   * TBP-275 — per-unit price for a metered quota (whole currency units, e.g.
   * 0.002). Absent for `hard` quotas and for metered quotas with no price yet.
   */
  unitAmount?: number;
  /** TBP-275 — currency of `unitAmount` / `overageEstimate` (ISO code). */
  currency?: string;
  /**
   * TBP-275 — estimated overage cost accrued this period, in `currency` units.
   * Server-computed: `max(0, used - limit) * unitAmount` (or `used * unitAmount`
   * when `limit === 0`). Lets the UI show "~$1.00 estimated" without waiting for
   * a Stripe invoice.
   */
  overageEstimate?: number;
  /**
   * TBP-275 — true once usage has passed the included allotment (metered billing
   * engaged). Prefer this over a UI-derived `used > limit` so the server stays
   * authoritative (handles `limit === 0` pure-per-unit correctly).
   */
  overcap?: boolean;
}

type Listener = (metric: string, snap: QuotaSnapshot | undefined) => void;

interface MountOptions {
  apiBaseUrl: string;
  /** Bearer access token. Null when unauthenticated — hydrate is skipped. */
  accessToken: string | null;
  appId: string;
  /**
   * TBP-762 — renews an out-of-date sign-in. When Bridge answers
   * `401 TOKEN_VERSION_STALE` (a checkout just changed the plan), the request
   * is retried once with the token this returns. Pass
   * `bridgeAuth.tokenStaleHandler()`.
   */
  onTokenStale?: () => Promise<string | null>;
}

/**
 * TBP-700 — how long after Bridge accepts a usage report the store waits for
 * that report's `quota.updated` push before asking the server itself. The push
 * is published before the ingest request returns, so on a healthy socket it has
 * normally arrived by the time the report is acknowledged.
 */
export const RECONCILE_AFTER_REPORT_MS = 1000;

const noopLogger: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export class QuotaStore {
  private _snapshots = new Map<string, QuotaSnapshot>();
  private _hydrating = new Set<string>();
  private _listeners = new Set<Listener>();
  /**
   * Options used for hydration HTTP. Set via `configure()` before the first
   * `get(metric)` call; otherwise hydration is skipped and only live pushes
   * populate the cache.
   */
  private _opts: MountOptions | null = null;
  private _logger: Logger = noopLogger;
  /**
   * Bumped on every value the cache takes for a metric (push or REST answer),
   * so an in-flight reconcile can tell that something newer landed meanwhile.
   */
  private _version = new Map<string, number>();
  private _reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Wire HTTP options + optional logger. Framework wrappers call this once. */
  configure(opts: MountOptions, logger: Logger = noopLogger): void {
    this._opts = opts;
    this._logger = logger;
  }

  /** Current cached snapshot for a metric, or undefined while hydrating / unconfigured. */
  get(metric: string): QuotaSnapshot | undefined {
    return this._snapshots.get(metric);
  }

  /** All cached snapshots. */
  getAll(): Map<string, QuotaSnapshot> {
    return new Map(this._snapshots);
  }

  /** Subscribe to per-metric snapshot changes. Returns an unsubscribe fn. */
  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Lazy hydration entry point. On the first call for a metric, kicks off a
   * `GET /usage/quota/:metric` round-trip and marks the metric as hydrating.
   * Subsequent calls are no-ops until the response arrives or a live push
   * lands.
   *
   * Non-blocking — returns the current cached snapshot (or undefined) and
   * lets the fetch resolve asynchronously. Consumers re-render via the
   * subscriber notification.
   */
  ensureHydrated(metric: string): QuotaSnapshot | undefined {
    const cached = this._snapshots.get(metric);
    if (cached) return cached;
    if (this._hydrating.has(metric)) return undefined;
    if (!this._opts || !this._opts.accessToken) return undefined;
    this._hydrating.add(metric);
    void this._fetchSnapshot(metric);
    return undefined;
  }

  /**
   * Apply a live `quota.updated` payload to the cache. Last-write-wins;
   * notifies subscribers. Hydration is implicitly cleared if it was pending.
   */
  applyQuotaUpdated(msg: QuotaUpdatedMessage): void {
    const snap: QuotaSnapshot = {
      metric: msg.metric,
      used: msg.used,
      limit: msg.limit,
      remaining: msg.remaining,
      percent_used: msg.limit > 0 ? msg.used / msg.limit : 0,
      // US-12 — server now publishes `policy`; fall back to `'metered'` when
      // an older bridge-api hasn't shipped US-12 yet so existing UI stays
      // visually identical.
      policy: msg.policy === 'hard' ? 'hard' : 'metered',
      kind: msg.quotaKind === 'gauge' ? 'gauge' : 'counter',
      // A push does not repeat how the quota is counted; keep what the read said.
      source: this._snapshots.get(msg.metric)?.source,
      warningLevel: msg.warningLevel ?? null,
      label: msg.metric,
      // TBP-275 — overage fields (server-authoritative; overcap falls back to a
      // used>limit derivation, which also yields true for limit===0 + used>0).
      unitAmount: msg.unitAmount,
      currency: msg.currency,
      overageEstimate: msg.overageEstimate,
      overcap: msg.overcap ?? msg.used > msg.limit,
    };
    this._snapshots.set(msg.metric, snap);
    this._hydrating.delete(msg.metric);
    this._bump(msg.metric);
    this._notify(msg.metric, snap);
  }

  /**
   * Apply the result of an initial-hydration REST fetch. Same semantics as a
   * live push but driven by the server's `GET /usage/quota/:metric` reply.
   */
  applyInitialSnapshot(
    metric: string,
    snapshot:
      | (Omit<QuotaSnapshot, 'percent_used' | 'policy' | 'label'> & {
          policy?: 'hard' | 'metered';
        })
      | null,
  ): void {
    this._hydrating.delete(metric);
    this._bump(metric);
    if (!snapshot) {
      // Server returned null → no quota configured. Notify with undefined so
      // subscribers can show an "unmetered" UI state without an extra check.
      this._snapshots.delete(metric);
      this._notify(metric, undefined);
      return;
    }
    const snap: QuotaSnapshot = {
      metric,
      used: snapshot.used,
      limit: snapshot.limit,
      remaining: snapshot.remaining,
      percent_used: snapshot.limit > 0 ? snapshot.used / snapshot.limit : 0,
      // US-12 — accept the server-supplied policy; fall back to `'metered'`
      // for older bridge-api responses.
      policy: snapshot.policy === 'hard' ? 'hard' : 'metered',
      kind: snapshot.kind === 'gauge' ? 'gauge' : 'counter',
      source: snapshot.source === 'membership' ? 'membership' : undefined,
      warningLevel: snapshot.warningLevel ?? null,
      label: metric,
      // TBP-275 — overage fields from the hydration response.
      unitAmount: snapshot.unitAmount,
      currency: snapshot.currency,
      overageEstimate: snapshot.overageEstimate,
      overcap: snapshot.overcap ?? snapshot.used > snapshot.limit,
    };
    this._snapshots.set(metric, snap);
    this._notify(metric, snap);
  }

  /**
   * Bridge has just accepted usage for `metric` from this client. If no new
   * value for the metric reaches the cache within `delayMs`, read
   * `GET /usage/quota/:metric` once, so the page shows its own usage even when
   * the `quota.updated` push for it is lost. A push that lands while the read
   * is in flight is newer and wins. Only metrics the store already shows are
   * reconciled; repeated reports for one metric share one pending read.
   */
  /*
   * TBP-700 — why the push alone is not enough. AppSync Events accepts a
   * publish (HTTP 200) and now and then never delivers it to a subscription
   * made shortly after the same client's previous connection closed: a page
   * navigation, or a socket swap. Measured on stage with a direct IAM publish,
   * no bridge-api involved: 3 of 40 events lost 1.2 s after `subscribe_success`
   * when the old socket closed 0.7 s before the new one opened, 5 of 155 when
   * it closed as the new one opened; 0 of 50 with a 3 s pause and 0 of 160 on
   * a long-lived socket. The lost subscription recovers — a publish 10 s later
   * arrives — but the lost event is gone, and before this the page kept the
   * old `used` until the next push (metered-plan-switch US-D, ~2 in 3 stage
   * runs). The on-connect catch-up in the framework runtimes cannot cover it:
   * the event is published after the subscription is acknowledged.
   */
  reconcileAfterReport(metric: string, delayMs: number = RECONCILE_AFTER_REPORT_MS): void {
    if (!this._snapshots.has(metric) && !this._hydrating.has(metric)) return;
    const acceptedAt = this._versionOf(metric);
    const pending = this._reconcileTimers.get(metric);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      this._reconcileTimers.delete(metric);
      // Something reached the cache after the report was accepted — the push
      // got through (or a fresher read did). Nothing was lost.
      if (this._versionOf(metric) !== acceptedAt) return;
      void this._reconcile(metric);
    }, delayMs);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    this._reconcileTimers.set(metric, timer);
  }

  /**
   * Wire the store to a RealtimeClient so `quota.updated` pushes flow into
   * `applyQuotaUpdated`. Idempotent: re-attaching replaces the hook.
   */
  attach(rt: RealtimeClient): void {
    rt.setOnQuotaUpdated((msg) => this.applyQuotaUpdated(msg));
  }

  /** Test-only: clear cache + listeners. */
  __resetForTests(): void {
    for (const t of this._reconcileTimers.values()) clearTimeout(t);
    this._reconcileTimers.clear();
    this._version.clear();
    this._snapshots.clear();
    this._hydrating.clear();
    this._listeners.clear();
    this._opts = null;
  }

  private _notify(metric: string, snap: QuotaSnapshot | undefined): void {
    for (const listener of this._listeners) {
      try {
        listener(metric, snap);
      } catch {
        // ignore — listener errors must not break the cache
      }
    }
  }

  private _bump(metric: string): void {
    this._version.set(metric, this._versionOf(metric) + 1);
  }

  private _versionOf(metric: string): number {
    return this._version.get(metric) ?? 0;
  }

  private async _fetchSnapshot(metric: string): Promise<void> {
    if (!this._opts || !this._opts.accessToken) {
      this._hydrating.delete(metric);
      return;
    }
    try {
      this.applyInitialSnapshot(metric, await this._readSnapshot(this._opts, metric));
    } catch (err) {
      // Hydration is best-effort. Drop the hydrating mark so a later push or
      // a manual retry can re-populate. Log at warn so the consumer can
      // diagnose if every fetch is failing.
      this._logger.warn(
        '[bridge.quota] hydrate failed',
        err instanceof Error ? err.message : err,
      );
      this._hydrating.delete(metric);
    }
  }

  /** TBP-700 — the read behind `reconcileAfterReport`. */
  private async _reconcile(metric: string): Promise<void> {
    const opts = this._opts;
    if (!opts || !opts.accessToken) return;
    const before = this._versionOf(metric);
    try {
      const snapshot = await this._readSnapshot(opts, metric);
      // A push (or another read) landed while this one was in flight: it is at
      // least as new as this answer, so this answer must not overwrite it.
      if (this._versionOf(metric) !== before) return;
      // Signed out or switched workspace meanwhile: the answer is not ours.
      if (this._opts?.accessToken !== opts.accessToken) return;
      this.applyInitialSnapshot(metric, snapshot);
    } catch (err) {
      this._logger.warn(
        '[bridge.quota] reconcile after report failed',
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async _readSnapshot(
    opts: MountOptions,
    metric: string,
  ): Promise<Parameters<QuotaStore['applyInitialSnapshot']>[1]> {
    const url = `${opts.apiBaseUrl.replace(/\/+$/, '')}/usage/quota/${encodeURIComponent(metric)}`;
    const body = await httpFetch<{
      metric: string;
      used: number;
      limit: number;
      remaining: number;
      warningLevel: null | 'approaching' | 'critical';
      /** US-12 — optional; server may omit on older builds. */
      policy?: 'hard' | 'metered';
      /** TBP-699 — optional; absent from servers that predate gauges. */
      kind?: 'counter' | 'gauge';
      /** TBP-763 — present on a gauge counted from membership (seats). */
      source?: 'membership';
      /** TBP-275 — optional overage fields for metered quotas. */
      unitAmount?: number;
      currency?: string;
      overageEstimate?: number;
      overcap?: boolean;
    } | null>(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          'x-app-id': opts.appId,
        },
        onTokenStale: opts.onTokenStale,
      },
      this._logger,
    );
    return body
      ? {
          metric: body.metric,
          used: body.used,
          limit: body.limit,
          remaining: body.remaining,
          warningLevel: body.warningLevel,
          policy: body.policy,
          kind: body.kind,
          source: body.source,
          unitAmount: body.unitAmount,
          currency: body.currency,
          overageEstimate: body.overageEstimate,
          overcap: body.overcap,
        }
      : null;
  }
}
