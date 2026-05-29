import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntitlementsStore } from '../billing/entitlements-store.js';

// ---------------------------------------------------------------------------
// Billing 2.0 — Phase C / US-12 (TBP-264)
// SDK EntitlementsStore — fail-closed boolean map.
// ---------------------------------------------------------------------------

vi.mock('../http.js', () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from '../http.js';
const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;

describe('EntitlementsStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Fail-closed reads
  // -------------------------------------------------------------------------
  describe('can() — fail-closed', () => {
    it('returns false for every name when not yet hydrated', () => {
      const store = new EntitlementsStore();
      expect(store.can('ai_completions')).toBe(false);
      expect(store.can('app_active')).toBe(false);
      expect(store.isHydrated()).toBe(false);
    });

    it('returns the boolean from the snapshot after applyEntitlementsChanged', () => {
      const store = new EntitlementsStore();
      store.applyEntitlementsChanged({ ai_completions: true, app_active: false });
      expect(store.can('ai_completions')).toBe(true);
      expect(store.can('app_active')).toBe(false);
      expect(store.isHydrated()).toBe(true);
    });

    it("returns false for keys NOT present in the snapshot (no phantom 'true')", () => {
      const store = new EntitlementsStore();
      store.applyEntitlementsChanged({ ai_completions: true });
      expect(store.can('not_in_snapshot')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // applyEntitlementsChanged
  // -------------------------------------------------------------------------
  describe('applyEntitlementsChanged', () => {
    it('wholesale-replaces the cache and notifies subscribers', () => {
      const store = new EntitlementsStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.applyEntitlementsChanged({ a: true, b: false });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ a: true, b: false });
    });

    it('subsequent applies replace the snapshot wholesale (no merge)', () => {
      const store = new EntitlementsStore();
      store.applyEntitlementsChanged({ a: true, b: true });
      store.applyEntitlementsChanged({ a: false }); // b is dropped

      expect(store.can('a')).toBe(false);
      expect(store.can('b')).toBe(false);
      expect(store.all()).toEqual({ a: false });
    });
  });

  // -------------------------------------------------------------------------
  // all()
  // -------------------------------------------------------------------------
  describe('all()', () => {
    it('returns the full cached snapshot as a shallow copy', () => {
      const store = new EntitlementsStore();
      store.applyEntitlementsChanged({ a: true, b: false });
      const snap = store.all();
      expect(snap).toEqual({ a: true, b: false });

      // Mutating the returned object must not affect the store.
      snap.a = false;
      expect(store.can('a')).toBe(true);
    });

    it('returns an empty object on a fresh store', () => {
      const store = new EntitlementsStore();
      expect(store.all()).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------
  describe('subscribe', () => {
    it('returns an unsubscribe function — listener stops firing after it is called', () => {
      const store = new EntitlementsStore();
      const listener = vi.fn();
      const off = store.subscribe(listener);

      store.applyEntitlementsChanged({ a: true });
      expect(listener).toHaveBeenCalledTimes(1);

      off();
      listener.mockClear();
      store.applyEntitlementsChanged({ a: false });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // hydrate() — REST hydration path
  // -------------------------------------------------------------------------
  describe('hydrate()', () => {
    it('populates the cache from GET /entitlements and notifies', async () => {
      mockHttpFetch.mockResolvedValue({
        entitlements: { ai_completions: true, app_active: true },
      });

      const store = new EntitlementsStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.configure({
        apiBaseUrl: 'https://api.example.com',
        getAccessToken: () => 'access-tok',
      });

      await store.hydrate();

      expect(store.isHydrated()).toBe(true);
      expect(store.can('ai_completions')).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      // URL + auth header are part of the public contract — pin them.
      const [url, opts] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/entitlements');
      expect(opts.headers.Authorization).toBe('Bearer access-tok');
    });

    it('skips hydration when no token is available', async () => {
      const store = new EntitlementsStore();
      store.configure({
        apiBaseUrl: 'https://api.example.com',
        getAccessToken: () => null,
      });
      await store.hydrate();
      expect(mockHttpFetch).not.toHaveBeenCalled();
      expect(store.isHydrated()).toBe(false);
    });
  });
});
