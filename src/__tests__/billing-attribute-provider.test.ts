import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillingAttributeProvider } from '../flags/attribute-providers.js';
import { BridgeSubscription } from '../billing/bridge-subscription.js';
import { QuotaStore } from '../billing/quota-store.js';
import { EntitlementsStore } from '../billing/entitlements-store.js';
import type { QuotaUpdatedMessage } from '../flags/realtime.js';

// ---------------------------------------------------------------------------
// Billing 2.0 — Phase C / US-13 (TBP-265)
// Unit tests for the store-backed `BillingAttributeProvider`. The existing
// spec under __tests__/flags/billing-attribute-provider.test.ts covers the
// legacy `getBillingSnapshot` callback path; this file covers the new
// `bindStores({ subscription, quotas, entitlements })` wiring.
// ---------------------------------------------------------------------------

function makeQuotaMsg(overrides: Partial<QuotaUpdatedMessage> = {}): QuotaUpdatedMessage {
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

describe('BillingAttributeProvider — bindStores (US-13)', () => {
  let provider: BillingAttributeProvider;
  let subscription: BridgeSubscription;
  let quotas: QuotaStore;
  let entitlements: EntitlementsStore;

  beforeEach(() => {
    provider = new BillingAttributeProvider();
    subscription = new BridgeSubscription();
    quotas = new QuotaStore();
    entitlements = new EntitlementsStore();
  });

  // -------------------------------------------------------------------------
  // Sync contract — provide() returns an object, not a Promise, when wired
  // through stores only (no async legacy callback).
  // -------------------------------------------------------------------------
  describe('sync return contract', () => {
    it('provide() returns an object (not a Promise) when only stores are wired', () => {
      subscription.hydrate({ plan: { slug: 'pro', name: 'Pro' }, status: 'active' });
      entitlements.applyEntitlementsChanged({ app_active: true });

      provider.bindStores({ subscription, quotas, entitlements });

      const result = provider.provide();
      expect(result).not.toBeInstanceOf(Promise);
      // Type guard for the synchronous branch.
      const sync = result as Record<string, unknown>;
      expect(sync['bridge:billing.plan']).toBe('pro');
    });
  });

  // -------------------------------------------------------------------------
  // Key namespace + canonical keys
  // -------------------------------------------------------------------------
  describe('namespaced keys', () => {
    it('emits the canonical bridge:billing.* keys for subscription + entitlements + quotas', () => {
      subscription.hydrate({
        plan: { slug: 'pro', name: 'Pro' },
        status: 'active',
      });
      quotas.applyQuotaUpdated(
        makeQuotaMsg({ metric: 'ai_completions', used: 30, limit: 100, remaining: 70 }),
      );
      entitlements.applyEntitlementsChanged({
        app_active: true,
        ai_completions: false,
      });

      provider.bindStores({ subscription, quotas, entitlements });

      const out = provider.provide() as Record<string, unknown>;

      // Subscription-derived.
      expect(out['bridge:billing.plan']).toBe('pro');
      expect(out['bridge:billing.subscription.status']).toBe('active');
      expect(out['bridge:billing.trial']).toBe(false);

      // Quota-derived (per-metric scoped).
      expect(out['bridge:billing.quota.ai_completions.used']).toBe(30);
      expect(out['bridge:billing.quota.ai_completions.limit']).toBe(100);
      expect(out['bridge:billing.quota.ai_completions.remaining']).toBe(70);
      expect(out['bridge:billing.quota.ai_completions.percent_used']).toBeCloseTo(0.3);

      // Entitlement-derived (boolean per name).
      expect(out['bridge:billing.entitlement.app_active']).toBe(true);
      expect(out['bridge:billing.entitlement.ai_completions']).toBe(false);
    });

    it("trial flag is true when subscription.status === 'trial'", () => {
      subscription.hydrate({ plan: { slug: 'pro-trial', name: 'Pro Trial' }, status: 'trial' });
      provider.bindStores({ subscription });
      const out = provider.provide() as Record<string, unknown>;
      expect(out['bridge:billing.trial']).toBe(true);
      expect(out['bridge:billing.subscription.status']).toBe('trial');
    });
  });

  // -------------------------------------------------------------------------
  // Graceful degradation when stores are unwired or empty
  // -------------------------------------------------------------------------
  describe('missing stores degrade gracefully', () => {
    it('returns an empty object when no stores have been bound', () => {
      const out = provider.provide() as Record<string, unknown>;
      expect(out).toEqual({});
    });

    it('binds only a subset of stores — others contribute no keys', () => {
      subscription.hydrate({ plan: { slug: 'pro', name: 'Pro' }, status: 'active' });
      provider.bindStores({ subscription });

      const out = provider.provide() as Record<string, unknown>;
      expect(out['bridge:billing.plan']).toBe('pro');
      // No quota / entitlement keys.
      const keys = Object.keys(out);
      expect(keys.some((k) => k.startsWith('bridge:billing.quota.'))).toBe(false);
      expect(keys.some((k) => k.startsWith('bridge:billing.entitlement.'))).toBe(false);
    });

    it('does not emit entitlement keys when the entitlements store is not hydrated yet', () => {
      // entitlements is a brand-new store; isHydrated() === false → no keys.
      provider.bindStores({ entitlements });
      const out = provider.provide() as Record<string, unknown>;
      const keys = Object.keys(out);
      expect(keys.some((k) => k.startsWith('bridge:billing.entitlement.'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Legacy `getBillingSnapshot` interop
  // -------------------------------------------------------------------------
  describe('legacy callback path still works', () => {
    it('emits keys from the legacy snapshot when no stores are bound', async () => {
      const legacy = new BillingAttributeProvider({
        getBillingSnapshot: () => ({ plan: 'FREE', trial: false }),
      });
      const out = await legacy.provide();
      expect(out['bridge:billing.plan']).toBe('FREE');
      expect(out['bridge:billing.trial']).toBe(false);
    });

    it('store-derived attrs WIN on key collision with the legacy callback', async () => {
      subscription.hydrate({ plan: { slug: 'PRO_STORE', name: 'Pro' }, status: 'active' });

      const hybrid = new BillingAttributeProvider({
        getBillingSnapshot: () => ({ plan: 'PRO_LEGACY' }),
      });
      hybrid.bindStores({ subscription });

      // Force the async branch by returning a Promise from the legacy callback.
      const out = await hybrid.provide();
      expect(out['bridge:billing.plan']).toBe('PRO_STORE');
    });
  });
});

// ---------------------------------------------------------------------------
// TBP-755 — a plan's included features arrive in the same entitlement
// snapshot as the quota-derived keys: `<key>: true` when the workspace's plan
// lists the feature, `<key>: false` when only another plan of the app does.
// A flag rule `bridge:billing.entitlement.<key> eq true` depends on BOTH values
// being emitted — a missing false would leave the rule unable to tell "not on
// your plan" from "not loaded yet".
// ---------------------------------------------------------------------------
describe('BillingAttributeProvider — plan features (TBP-755)', () => {
  it('emits bridge:billing.entitlement.<feature> true for an included feature and false for one another plan sells', () => {
    const provider = new BillingAttributeProvider();
    const subscription = new BridgeSubscription();
    const entitlements = new EntitlementsStore();
    subscription.hydrate({ plan: { slug: 'pro', name: 'Pro' }, status: 'active' });
    entitlements.applyEntitlementsChanged({
      app_active: true,
      analytics: true,
      sso: false,
    });
    provider.bindStores({ subscription, quotas: new QuotaStore(), entitlements });

    const out = provider.provide() as Record<string, unknown>;
    expect(out['bridge:billing.entitlement.analytics']).toBe(true);
    expect(out['bridge:billing.entitlement.sso']).toBe(false);
  });

  it('follows the plan when the feature list changes (entitlements.changed replaces the snapshot)', () => {
    const provider = new BillingAttributeProvider();
    const entitlements = new EntitlementsStore();
    entitlements.applyEntitlementsChanged({ app_active: true, analytics: false });
    provider.bindStores({ subscription: new BridgeSubscription(), quotas: new QuotaStore(), entitlements });
    expect((provider.provide() as Record<string, unknown>)['bridge:billing.entitlement.analytics']).toBe(false);

    entitlements.applyEntitlementsChanged({ app_active: true, analytics: true });
    expect((provider.provide() as Record<string, unknown>)['bridge:billing.entitlement.analytics']).toBe(true);
  });
});
