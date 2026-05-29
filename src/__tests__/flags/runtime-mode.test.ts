// Phase 6 (TBP-290/340) — BridgePullCache unit tests.
//
// Verifies:
//   1. Cache hit: second get within TTL returns cached value without fetching.
//   2. Cache miss: first get / post-expiry get invokes fetcher.
//   3. Concurrent get(key, ...) calls share the in-flight promise.
//   4. invalidate(key) forces a re-fetch on the next get.
//   5. invalidate() (no arg) clears all keys.
//   6. Fetcher rejection clears in-flight so next get retries.
//   7. Different keys cache independently.

import { describe, expect, it, vi } from 'vitest';
import { BridgePullCache } from '../../flags/runtime-mode.js';

describe('BridgePullCache (Phase 6, TBP-340)', () => {
  it('caches the first fetch and returns it within TTL', async () => {
    const fetcher = vi.fn(async () => ({ value: 42 }));
    const cache = new BridgePullCache({ ttlMs: 60_000 });
    const a = await cache.get('k', fetcher);
    const b = await cache.get('k', fetcher);
    expect(a).toEqual({ value: 42 });
    expect(b).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refetches after expiry', async () => {
    let nowMs = 1000;
    const cache = new BridgePullCache({ ttlMs: 100, now: () => nowMs });
    const fetcher = vi.fn(async () => ({ v: nowMs }));
    await cache.get('k', fetcher);
    nowMs = 1500; // past expiry
    await cache.get('k', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent get calls — single in-flight promise', async () => {
    let resolver!: (v: unknown) => void;
    const fetcher = vi.fn(() => new Promise((r) => { resolver = r; }));
    const cache = new BridgePullCache();
    const p1 = cache.get('k', fetcher);
    const p2 = cache.get('k', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    resolver({ ok: true });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it('invalidate(key) forces a re-fetch on the next get', async () => {
    const fetcher = vi.fn(async () => ({ v: Math.random() }));
    const cache = new BridgePullCache({ ttlMs: 60_000 });
    await cache.get('k', fetcher);
    cache.invalidate('k');
    await cache.get('k', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate() with no arg clears every key', async () => {
    const cache = new BridgePullCache({ ttlMs: 60_000 });
    await cache.get('a', async () => 1);
    await cache.get('b', async () => 2);
    expect(cache.size()).toBe(2);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });

  it('fetcher rejection clears in-flight so the next get retries', async () => {
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('first-fails');
      return 'ok';
    });
    const cache = new BridgePullCache();
    await expect(cache.get('k', fetcher)).rejects.toThrow('first-fails');
    const v = await cache.get('k', fetcher);
    expect(v).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('different keys cache independently', async () => {
    const cache = new BridgePullCache({ ttlMs: 60_000 });
    const fA = vi.fn(async () => 'A');
    const fB = vi.fn(async () => 'B');
    await cache.get('a', fA);
    await cache.get('b', fB);
    expect(await cache.get('a', fA)).toBe('A');
    expect(await cache.get('b', fB)).toBe('B');
    expect(fA).toHaveBeenCalledOnce();
    expect(fB).toHaveBeenCalledOnce();
  });
});
