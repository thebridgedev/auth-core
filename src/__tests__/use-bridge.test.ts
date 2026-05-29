// Billing 2.0 / Phase B — `useBridge()` dev-handler API + RealtimeClient wiring.
//
// Covers:
//   - `handle(handlers)` registers callbacks and returns an unsubscribe fn.
//   - `attachToRealtimeClient(rt)` registers BOTH `setOnSubscriptionPlanChanged`
//     and `setOnBillingLifecycle` on the RealtimeClient.
//   - Lifecycle dispatch order: snapshot patch runs FIRST, then dev handlers
//     see the already-updated snapshot.
//
// We mock the RealtimeClient with a thin stub that just captures registered
// hooks — no network, no jose, no websocket factory needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBridge, __resetUseBridgeForTests } from '../billing/use-bridge.js';
import { httpFetch } from '../http.js';
import { BillingLockedError } from '../errors.js';
import type {
  BillingLifecycleMessage,
  RealtimeClient,
  SubscriptionPlanChangedMessage,
} from '../flags/realtime.js';
import type { BillingLockedPayload, BillingSubscriptionState } from '../billing/types.js';

// ---------------------------------------------------------------------------
// RealtimeClient stub — captures the hooks registered by attachToRealtimeClient.
// ---------------------------------------------------------------------------

interface RtStub {
  planHook?: (msg: SubscriptionPlanChangedMessage) => void;
  lifecycleHook?: (msg: BillingLifecycleMessage) => void;
  quotaHook?: (msg: unknown) => void;
  entitlementsHook?: (msg: unknown) => void;
  setOnSubscriptionPlanChanged: (
    hook: (msg: SubscriptionPlanChangedMessage) => void,
  ) => void;
  setOnBillingLifecycle: (
    hook: (msg: BillingLifecycleMessage) => void,
  ) => void;
  setOnQuotaUpdated: (hook: (msg: unknown) => void) => void;
  setOnEntitlementsChanged: (hook: (msg: unknown) => void) => void;
}

function makeRtStub(): RtStub {
  const stub: RtStub = {
    setOnSubscriptionPlanChanged(hook) {
      stub.planHook = hook;
    },
    setOnBillingLifecycle(hook) {
      // The RealtimeClient stores ONE hook per kind — replacing on re-register
      // matches the production behavior we want to exercise.
      stub.lifecycleHook = hook;
    },
    // Phase C US-11 / US-12 — useBridge().attachToRealtimeClient now wires
    // quota.updated + entitlements.changed handlers onto the realtime client.
    // Tests don't exercise those paths; the stub just records the hook.
    setOnQuotaUpdated(hook) {
      stub.quotaHook = hook;
    },
    setOnEntitlementsChanged(hook) {
      stub.entitlementsHook = hook;
    },
  };
  return stub;
}

const BASELINE: BillingSubscriptionState = {
  plan: { slug: 'pro', name: 'Pro' },
  status: 'active',
};

function makeLifecycleMsg(
  kind: BillingLifecycleMessage['kind'],
  overrides: Partial<BillingLifecycleMessage> = {},
): BillingLifecycleMessage {
  return {
    kind,
    tenantId: 'tenant-1',
    effectiveAt: '2026-05-19T12:00:00.000Z',
    ...overrides,
  } as BillingLifecycleMessage;
}

// ---------------------------------------------------------------------------
// handle(handlers)
// ---------------------------------------------------------------------------

describe('useBridge().handle(handlers)', () => {
  beforeEach(() => {
    __resetUseBridgeForTests();
  });

  it('returns an unsubscribe function', () => {
    const api = useBridge();
    const off = api.handle({ 'payment.failed': vi.fn() });
    expect(typeof off).toBe('function');
  });

  it('registered handler fires when a matching lifecycle message arrives after attach', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const onPaymentFailed = vi.fn();
    api.handle({ 'payment.failed': onPaymentFailed });

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    const msg = makeLifecycleMsg('payment.failed', { cardLast4: '4242' });
    rt.lifecycleHook!(msg);

    expect(onPaymentFailed).toHaveBeenCalledTimes(1);
    expect(onPaymentFailed).toHaveBeenCalledWith(msg);
  });

  it('after unsubscribe, handler no longer fires', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const onPaymentFailed = vi.fn();
    const off = api.handle({ 'payment.failed': onPaymentFailed });

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    off();

    rt.lifecycleHook!(makeLifecycleMsg('payment.failed'));
    expect(onPaymentFailed).not.toHaveBeenCalled();
  });

  it('handlers registered before attach still fire after attach', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const onRecovered = vi.fn();
    api.handle({ 'dunning.recovered': onRecovered });

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    rt.lifecycleHook!(makeLifecycleMsg('dunning.recovered'));
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('handlers registered AFTER attach still fire (devHandlers list is live)', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    const onRecovered = vi.fn();
    api.handle({ 'dunning.recovered': onRecovered });

    rt.lifecycleHook!(makeLifecycleMsg('dunning.recovered'));
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('multiple registered handler sets all fire for the same kind', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const a = vi.fn();
    const b = vi.fn();
    api.handle({ 'payment.succeeded': a });
    api.handle({ 'payment.succeeded': b });

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    rt.lifecycleHook!(makeLifecycleMsg('payment.succeeded'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('handler errors do not propagate — other handlers still fire', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const throwing = vi.fn(() => {
      throw new Error('handler boom');
    });
    const ok = vi.fn();
    api.handle({ 'payment.failed': throwing });
    api.handle({ 'payment.failed': ok });

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    expect(() =>
      rt.lifecycleHook!(makeLifecycleMsg('payment.failed')),
    ).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// attachToRealtimeClient(rt)
// ---------------------------------------------------------------------------

describe('useBridge().attachToRealtimeClient(rt)', () => {
  beforeEach(() => {
    __resetUseBridgeForTests();
  });

  it('registers BOTH setOnSubscriptionPlanChanged AND setOnBillingLifecycle', () => {
    const api = useBridge();
    const rt = makeRtStub();
    const planSpy = vi.spyOn(rt, 'setOnSubscriptionPlanChanged');
    const lifecycleSpy = vi.spyOn(rt, 'setOnBillingLifecycle');

    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    // Both setOnSubscriptionPlanChanged and setOnBillingLifecycle are called
    // twice in production: once by `subscription.attach(rt)` (registers the
    // snapshot patcher), once by `attachToRealtimeClient` itself (replaces
    // them with the patch-then-fan-out wrapper). The last registration is
    // what the RealtimeClient stores.
    expect(planSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(lifecycleSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(typeof rt.planHook).toBe('function');
    expect(typeof rt.lifecycleHook).toBe('function');
  });

  it('is idempotent on the same rt — re-attaching the same instance is a no-op', () => {
    const api = useBridge();
    const rt = makeRtStub();

    api.attachToRealtimeClient(rt as unknown as RealtimeClient);
    const planSpy = vi.spyOn(rt, 'setOnSubscriptionPlanChanged');
    const lifecycleSpy = vi.spyOn(rt, 'setOnBillingLifecycle');

    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    expect(planSpy).not.toHaveBeenCalled();
    expect(lifecycleSpy).not.toHaveBeenCalled();
  });

  it('plan-changed hook hydrates the subscription snapshot', () => {
    const api = useBridge();
    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    const msg: SubscriptionPlanChangedMessage = {
      kind: 'subscription.plan_changed',
      tenantId: 'tenant-1',
      from: { slug: 'free' },
      to: { slug: 'pro', name: 'Pro' },
      status: 'active',
      effectiveAt: '2026-05-19T12:00:00.000Z',
    };
    rt.planHook!(msg);

    expect(api.subscription.snapshot().state).toEqual({
      plan: msg.to,
      status: msg.status,
    });
  });

  // -------------------------------------------------------------------------
  // Dispatch order: snapshot patch FIRST, dev handler SECOND — so handlers
  // observe the already-updated snapshot.
  // -------------------------------------------------------------------------

  it('lifecycle dispatch order: subscription snapshot is patched BEFORE dev handlers fire', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    let observed: BillingSubscriptionState | null = null;
    api.handle({
      'payment.failed': () => {
        // When the dev handler fires, the snapshot must already reflect the
        // payment.failed patch (status=past_due, pastDueReason=card_declined).
        observed = api.subscription.snapshot().state;
      },
    });

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    rt.lifecycleHook!(makeLifecycleMsg('payment.failed', { cardLast4: '4242' }));

    expect(observed).not.toBeNull();
    expect(observed).toMatchObject({
      status: 'past_due',
      pastDueReason: 'card_declined',
      cardLast4: '4242',
    });
  });

  it('lifecycle hook patches snapshot even when no dev handlers are registered', () => {
    const api = useBridge();
    api.subscription.hydrate(BASELINE);

    const rt = makeRtStub();
    api.attachToRealtimeClient(rt as unknown as RealtimeClient);

    rt.lifecycleHook!(
      makeLifecycleMsg('subscription.canceled', {
        endsAt: '2026-06-01T00:00:00.000Z',
      }),
    );

    expect(api.subscription.snapshot().state).toMatchObject({
      status: 'canceled',
      endsAt: '2026-06-01T00:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Billing 2.0 soft gate — gate primitives: isLocked / gateState / assertNotLocked
// ---------------------------------------------------------------------------

const LOCKED_PAYLOAD: BillingLockedPayload = {
  reason: 'billing_locked',
  billing: { status: 'past_due', gateEngaged: true, recoveryUrl: '/billing' },
};

describe('useBridge() gate primitives', () => {
  beforeEach(() => {
    __resetUseBridgeForTests();
  });

  describe('when not locked', () => {
    it('isLocked() is false on a fresh surface (fail-closed default)', () => {
      const api = useBridge();
      expect(api.isLocked()).toBe(false);
    });

    it('isLocked() is false when hydrated with an active subscription', () => {
      const api = useBridge();
      api.subscription.hydrate(BASELINE);
      expect(api.isLocked()).toBe(false);
    });

    it('assertNotLocked() does not throw when not locked', () => {
      const api = useBridge();
      api.subscription.hydrate(BASELINE);
      expect(() => api.assertNotLocked()).not.toThrow();
    });

    it('gateState() reports locked=false for an active subscription', () => {
      const api = useBridge();
      api.subscription.hydrate(BASELINE);
      expect(api.gateState().locked).toBe(false);
    });
  });

  describe('after the subscription store is locked', () => {
    it('isLocked() is true', () => {
      const api = useBridge();
      api.subscription.markLocked(LOCKED_PAYLOAD);
      expect(api.isLocked()).toBe(true);
    });

    it('gateState() returns locked + severity "locked" + recoveryUrl', () => {
      const api = useBridge();
      api.subscription.markLocked(LOCKED_PAYLOAD);
      expect(api.gateState()).toMatchObject({
        locked: true,
        severity: 'locked',
        recoveryUrl: '/billing',
      });
    });

    it('assertNotLocked() throws BillingLockedError', () => {
      const api = useBridge();
      api.subscription.markLocked(LOCKED_PAYLOAD);
      expect(() => api.assertNotLocked()).toThrow(BillingLockedError);
    });

    it('the thrown BillingLockedError carries status + gateEngaged + recoveryUrl', () => {
      const api = useBridge();
      api.subscription.markLocked(LOCKED_PAYLOAD);
      const err = (() => {
        try {
          api.assertNotLocked();
        } catch (e) {
          return e as BillingLockedError;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(BillingLockedError);
      expect(err!.payload).toMatchObject({
        reason: 'billing_locked',
        billing: { status: 'past_due', gateEngaged: true, recoveryUrl: '/billing' },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// http chokepoint auto-lock — once useBridge() is initialized it registers a
// lock handler on the lock-signal singleton, so a billing-locked 402 surfacing
// through httpFetch flips the live subscription store with no extra wiring.
// ---------------------------------------------------------------------------

describe('http chokepoint auto-locks the subscription store', () => {
  beforeEach(() => {
    __resetUseBridgeForTests();
    (globalThis as any).fetch = undefined;
  });

  afterEach(() => {
    __resetUseBridgeForTests();
    (globalThis as any).fetch = undefined;
  });

  it('a 402 billing_locked from httpFetch leaves useBridge().isLocked() true', async () => {
    // Initialize the singleton FIRST — this is what registers the lock handler.
    const api = useBridge();
    expect(api.isLocked()).toBe(false);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      json: vi.fn().mockResolvedValue(LOCKED_PAYLOAD),
      text: vi.fn().mockResolvedValue(JSON.stringify(LOCKED_PAYLOAD)),
    } as unknown as Response);

    await expect(
      httpFetch('https://api.example.com/billing/state', {}, {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(BillingLockedError);

    expect(api.isLocked()).toBe(true);
    expect(api.subscription.snapshot().state).toMatchObject({
      gateEngaged: true,
      recoveryUrl: '/billing',
    });
  });
});
