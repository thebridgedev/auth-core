// Billing 2.0 US-12 (TBP-264) — SDK entitlement cache + reactive surface.
//
// Backs `useBridge().entitlements.can(name)`. Holds the boolean map published
// by the bridge-api EntitlementService:
//   - `hydrate()` — `GET /entitlements` once on attach.
//   - `applyEntitlementsChanged(snapshot)` — replaces cache wholesale on every
//     `entitlements.changed` push from the workspace channel. Last-write-wins.
//   - `can(name)` — fail-closed: returns `false` until hydrated and only `true`
//     when the key is explicitly present and `true`.
//
// Framework-agnostic. Subscribers receive a snapshot notification on every
// cache mutation; the bridge-svelte/react wrappers wire those into reactive
// containers.

import { httpFetch } from '../http.js';
import type { Logger } from '../logger.js';

/** Public entitlement snapshot shape — a flat boolean map. */
export type EntitlementSnapshot = Record<string, boolean>;

type Listener = (snapshot: EntitlementSnapshot) => void;

interface ConfigureOptions {
  apiBaseUrl: string;
  /**
   * Returns the current Bearer access token, or null when unauthenticated
   * (hydrate is skipped). Lazy so the wrapper can rotate tokens without
   * reconfiguring the store.
   */
  getAccessToken: () => string | null;
}

const noopLogger: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export class EntitlementsStore {
  private _cache: EntitlementSnapshot = {};
  private _hydrated = false;
  private _hydrating = false;
  private _subscribers = new Set<Listener>();
  private _opts: ConfigureOptions | null = null;
  private _logger: Logger = noopLogger;

  /** Wire HTTP options + optional logger. Framework wrappers call this once. */
  configure(opts: ConfigureOptions, logger: Logger = noopLogger): void {
    this._opts = opts;
    this._logger = logger;
  }

  /** Has the initial REST fetch completed? Drives fail-closed reads. */
  isHydrated(): boolean {
    return this._hydrated;
  }

  /**
   * Initial-hydration fetch. Idempotent — concurrent callers share one
   * round-trip; subsequent calls after success are no-ops unless the caller
   * explicitly resets. Failures leave the store unhydrated; `can()` keeps
   * returning false until a live push or a retry succeeds.
   */
  async hydrate(): Promise<void> {
    if (this._hydrated || this._hydrating) return;
    if (!this._opts) return;
    const token = this._opts.getAccessToken();
    if (!token) return;
    this._hydrating = true;
    try {
      const url = `${this._opts.apiBaseUrl.replace(/\/+$/, '')}/entitlements`;
      const body = await httpFetch<{ entitlements?: EntitlementSnapshot }>(
        url,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
        this._logger,
      );
      this._cache = { ...(body?.entitlements ?? {}) };
      this._hydrated = true;
      this._notify();
    } catch (err) {
      this._logger.warn(
        '[bridge.entitlements] hydrate failed',
        err instanceof Error ? err.message : err,
      );
    } finally {
      this._hydrating = false;
    }
  }

  /**
   * Wholesale-replace the cache from a server-pushed snapshot. The server
   * publishes the FULL set on every change so the SDK never has to merge
   * partial deltas — last-write-wins.
   */
  applyEntitlementsChanged(snapshot: EntitlementSnapshot): void {
    this._cache = { ...snapshot };
    this._hydrated = true;
    this._notify();
  }

  /**
   * Fail-closed read.
   *   - Before hydration: returns `false`.
   *   - After hydration with a key NOT in the cache: returns `false`.
   *   - After hydration with a key in the cache: returns the boolean.
   *
   * Consumers gate UX with `{#if bridge.entitlements.can('ai_completions')}`
   * — fail-closed protects against showing privileged UX on a cold start.
   */
  can(name: string): boolean {
    if (!this._hydrated) return false;
    return this._cache[name] === true;
  }

  /** All cached entitlements (shallow copy). */
  all(): EntitlementSnapshot {
    return { ...this._cache };
  }

  /**
   * Subscribe to snapshot changes. Returns an unsubscribe fn.
   * Does NOT invoke immediately with the current snapshot — the consumer can
   * read `all()` synchronously if it needs the initial value.
   */
  subscribe(cb: Listener): () => void {
    this._subscribers.add(cb);
    return () => {
      this._subscribers.delete(cb);
    };
  }

  /** Test-only: clear cache + listeners. */
  __resetForTests(): void {
    this._cache = {};
    this._hydrated = false;
    this._hydrating = false;
    this._subscribers.clear();
    this._opts = null;
  }

  private _notify(): void {
    const snap = this.all();
    for (const cb of this._subscribers) {
      try {
        cb(snap);
      } catch {
        // ignore — listener errors must not break the cache
      }
    }
  }
}
