// Phase 6 (TBP-290/340) — runtime-mode abstraction.
//
// `BridgeRuntimeMode` is orthogonal to `BridgeFlagsMode` (which governs the
// flag-eval semantics on backend vs frontend). Runtime mode governs HOW the
// SDK stays fresh:
//
//   'channel' — open a WebSocket and consume push events (live updates).
//               Use for long-running processes: SvelteKit SSR servers, NestJS
//               services, Express APIs serving many users from one process.
//
//   'pull'    — never open a WebSocket. Every read may hit REST with a small
//               TTL cache to deduplicate close-in-time reads. Use for
//               ephemeral runtimes: cron jobs, serverless functions, webhook
//               handlers, CLI scripts.
//
// In 'pull' mode `bridge.events.handle()` is a no-op (push events don't exist
// — for server-side event reactions, use Bridge webhooks instead).
//
// In 'channel' mode `bridge.refresh()` is supported but rarely needed (the
// channel keeps state fresh automatically); in 'pull' mode `bridge.refresh()`
// explicitly invalidates the cache so the next read re-fetches.

export type BridgeRuntimeMode = 'channel' | 'pull';

export interface PullCacheOptions {
  /** TTL for cached values in ms. Default 30000 (30s). */
  ttlMs?: number;
  /** Optional override for the default "now" clock — useful in tests. */
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  inflight?: Promise<T>;
}

/**
 * Tiny TTL-bounded read cache for pull-mode SDKs.
 *
 * Semantics:
 *   - `get(key, fetcher)` returns the cached value if not expired; otherwise
 *     awaits `fetcher()` to populate and returns the fresh value.
 *   - Concurrent `get(key, ...)` calls share the in-flight promise (no
 *     thundering-herd against the upstream REST endpoint).
 *   - `invalidate(key?)` clears a specific key or the entire cache.
 *
 * Best-effort: a fetcher rejection clears the in-flight promise so the next
 * `get()` retries instead of returning a stale value forever.
 */
export class BridgePullCache {
  private readonly _entries = new Map<string, CacheEntry<unknown>>();
  private readonly _ttlMs: number;
  private readonly _now: () => number;

  constructor(opts?: PullCacheOptions) {
    this._ttlMs = opts?.ttlMs ?? 30_000;
    this._now = opts?.now ?? (() => Date.now());
  }

  async get<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this._entries.get(key) as CacheEntry<T> | undefined;
    if (existing) {
      if (existing.inflight) return existing.inflight;
      if (existing.expiresAt > this._now()) return existing.value;
    }

    const inflight = fetcher()
      .then((v) => {
        this._entries.set(key, {
          value: v,
          expiresAt: this._now() + this._ttlMs,
        });
        return v;
      })
      .catch((err) => {
        // Clear so the next call retries instead of returning stale forever.
        this._entries.delete(key);
        throw err;
      });

    this._entries.set(key, {
      value: existing?.value as T,
      expiresAt: 0,
      inflight,
    });
    return inflight;
  }

  /** Force a re-fetch on the next get(). Pass no args to clear all keys. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this._entries.clear();
      return;
    }
    this._entries.delete(key);
  }

  /** Number of cached entries currently held (test/diagnostic). */
  size(): number {
    return this._entries.size;
  }
}
