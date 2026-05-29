import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuotaStore } from '../billing/quota-store.js';
import type { QuotaUpdatedMessage } from '../flags/realtime.js';

// ---------------------------------------------------------------------------
// Billing 2.0 — Phase C / US-11 (TBP-263)
// SDK QuotaStore — in-memory snapshot cache + reactive surface.
// ---------------------------------------------------------------------------

vi.mock('../http.js', () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from '../http.js';
const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;

function makeMsg(overrides: Partial<QuotaUpdatedMessage> = {}): QuotaUpdatedMessage {
  return {
    kind: 'quota.updated',
    tenantId: 'ws-1',
    effectiveAt: '2026-05-19T12:00:00.000Z',
    metric: 'ai_completions',
    used: 30,
    limit: 100,
    remaining: 70,
    warningLevel: null,
    policy: 'metered',
    ...overrides,
  };
}

describe('QuotaStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // applyQuotaUpdated
  // -------------------------------------------------------------------------
  describe('applyQuotaUpdated', () => {
    it('replaces the cached snapshot and notifies subscribers', () => {
      const store = new QuotaStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.applyQuotaUpdated(makeMsg({ used: 50 }));

      const snap = store.get('ai_completions');
      expect(snap).toMatchObject({
        metric: 'ai_completions',
        used: 50,
        limit: 100,
        remaining: 70,
        warningLevel: null,
        policy: 'metered',
        label: 'ai_completions',
      });
      // percent_used derived from used/limit.
      expect(snap!.percent_used).toBeCloseTo(0.5);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('ai_completions', snap);
    });

    it("consumes `policy: 'hard'` from the message", () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg({ policy: 'hard' }));
      expect(store.get('ai_completions')!.policy).toBe('hard');
    });

    it("defaults to `policy: 'metered'` when the message omits it (older bridge-api builds)", () => {
      const store = new QuotaStore();
      // policy left undefined in the wire message.
      const msg = makeMsg({ policy: undefined });
      store.applyQuotaUpdated(msg);
      expect(store.get('ai_completions')!.policy).toBe('metered');
    });

    it('successive applies are last-write-wins', () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg({ used: 10 }));
      store.applyQuotaUpdated(makeMsg({ used: 90, warningLevel: 'critical' }));
      const snap = store.get('ai_completions');
      expect(snap!.used).toBe(90);
      expect(snap!.warningLevel).toBe('critical');
    });
  });

  // -------------------------------------------------------------------------
  // applyInitialSnapshot — REST hydration path
  // -------------------------------------------------------------------------
  describe('applyInitialSnapshot', () => {
    it('seeds the cache from a hydration payload and derives percent_used', () => {
      const store = new QuotaStore();
      store.applyInitialSnapshot('ai_completions', {
        metric: 'ai_completions',
        used: 80,
        limit: 100,
        remaining: 20,
        warningLevel: 'approaching',
        policy: 'hard',
      });
      const snap = store.get('ai_completions');
      expect(snap).toMatchObject({
        metric: 'ai_completions',
        used: 80,
        limit: 100,
        remaining: 20,
        warningLevel: 'approaching',
        policy: 'hard',
      });
      expect(snap!.percent_used).toBeCloseTo(0.8);
    });

    it('removes the entry from the cache when the server returns null (no quota configured)', () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg());
      expect(store.get('ai_completions')).toBeDefined();

      const listener = vi.fn();
      store.subscribe(listener);

      store.applyInitialSnapshot('ai_completions', null);
      expect(store.get('ai_completions')).toBeUndefined();
      expect(listener).toHaveBeenCalledWith('ai_completions', undefined);
    });
  });

  // -------------------------------------------------------------------------
  // ensureHydrated — lazy fetch
  // -------------------------------------------------------------------------
  describe('ensureHydrated', () => {
    it('triggers a fetch on first access; idempotent on the second access while still hydrating', () => {
      const store = new QuotaStore();
      // Make the fetch pend so the second call sees the hydrating mark.
      let resolveFetch!: (v: any) => void;
      mockHttpFetch.mockReturnValue(
        new Promise((res) => {
          resolveFetch = res;
        }),
      );

      store.configure({
        apiBaseUrl: 'https://api.example.com',
        accessToken: 'access-tok',
        appId: 'app-1',
      });

      const a = store.ensureHydrated('ai_completions');
      const b = store.ensureHydrated('ai_completions');

      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
      // Only the first call triggered a fetch — the second was idempotent.
      expect(mockHttpFetch).toHaveBeenCalledTimes(1);

      // Unblock the pending promise so vitest can settle.
      resolveFetch(null);
    });

    it('returns the cached snapshot without re-fetching when one is already present', () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg());

      store.configure({
        apiBaseUrl: 'https://api.example.com',
        accessToken: 'access-tok',
        appId: 'app-1',
      });

      const result = store.ensureHydrated('ai_completions');
      expect(result).toBeDefined();
      expect(mockHttpFetch).not.toHaveBeenCalled();
    });

    it('does not fetch when not configured', () => {
      const store = new QuotaStore();
      // No configure() call — store is unwired.
      const result = store.ensureHydrated('ai_completions');
      expect(result).toBeUndefined();
      expect(mockHttpFetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // percent_used derivation
  // -------------------------------------------------------------------------
  describe('percent_used derivation', () => {
    it('used 0 / limit 100 → 0', () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg({ used: 0, limit: 100 }));
      expect(store.get('ai_completions')!.percent_used).toBe(0);
    });

    it('used 50 / limit 100 → 0.5', () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg({ used: 50, limit: 100 }));
      expect(store.get('ai_completions')!.percent_used).toBeCloseTo(0.5);
    });

    it('limit 0 → 0 (no division-by-zero)', () => {
      const store = new QuotaStore();
      store.applyQuotaUpdated(makeMsg({ used: 5, limit: 0 }));
      expect(store.get('ai_completions')!.percent_used).toBe(0);
    });
  });
});
