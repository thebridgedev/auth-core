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
}

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
   * Wire the store to a RealtimeClient so `quota.updated` pushes flow into
   * `applyQuotaUpdated`. Idempotent: re-attaching replaces the hook.
   */
  attach(rt: RealtimeClient): void {
    rt.setOnQuotaUpdated((msg) => this.applyQuotaUpdated(msg));
  }

  /** Test-only: clear cache + listeners. */
  __resetForTests(): void {
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

  private async _fetchSnapshot(metric: string): Promise<void> {
    if (!this._opts || !this._opts.accessToken) {
      this._hydrating.delete(metric);
      return;
    }
    const url = `${this._opts.apiBaseUrl.replace(/\/+$/, '')}/usage/quota/${encodeURIComponent(metric)}`;
    try {
      const body = await httpFetch<{
        metric: string;
        used: number;
        limit: number;
        remaining: number;
        warningLevel: null | 'approaching' | 'critical';
        /** US-12 — optional; server may omit on older builds. */
        policy?: 'hard' | 'metered';
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
            Authorization: `Bearer ${this._opts.accessToken}`,
            'x-app-id': this._opts.appId,
          },
        },
        this._logger,
      );
      this.applyInitialSnapshot(
        metric,
        body
          ? {
              metric: body.metric,
              used: body.used,
              limit: body.limit,
              remaining: body.remaining,
              warningLevel: body.warningLevel,
              policy: body.policy,
              unitAmount: body.unitAmount,
              currency: body.currency,
              overageEstimate: body.overageEstimate,
              overcap: body.overcap,
            }
          : null,
      );
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
}
