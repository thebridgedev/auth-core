// Billing 2.0 / Phase A / US-2 (TBP-248) — unit tests for the reactive
// BridgeSubscription surface and the useBridge() singleton factory.
//
// Mirrors the FF 2.0 reactive-surface conventions used by
// feature-flag-service.test.ts. httpFetch is mocked at module level via
// vi.mock so the test never hits the network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeSubscription } from '../billing/bridge-subscription.js';
import { useBridge, __resetUseBridgeForTests } from '../billing/use-bridge.js';
import type {
  BillingSubscriptionSnapshot,
  BillingSubscriptionState,
  MountOptions,
} from '../billing/types.js';
import type {
  RealtimeClient,
  SubscriptionPlanChangedMessage,
} from '../flags/realtime.js';

// ---------------------------------------------------------------------------
// Mock httpFetch — parallel to feature-flag-service.test.ts.
// ---------------------------------------------------------------------------

vi.mock('../http.js', () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from '../http.js';

const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE: BillingSubscriptionState = {
  plan: { slug: 'free', name: 'Free' },
  status: 'active',
};

const MOUNT_OPTS: MountOptions = {
  apiBaseUrl: 'https://api.example.com',
  accessToken: 'access-tok',
  appId: 'app1',
};

describe('BridgeSubscription', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetUseBridgeForTests();
  });

  // -------------------------------------------------------------------------
  // snapshot()
  // -------------------------------------------------------------------------

  describe('snapshot()', () => {
    it('returns default snapshot { state: null, loading: false, error: null }', () => {
      const sub = new BridgeSubscription();
      expect(sub.snapshot()).toEqual({ state: null, loading: false, error: null });
    });
  });

  // -------------------------------------------------------------------------
  // subscribe(listener)
  // -------------------------------------------------------------------------

  describe('subscribe(listener)', () => {
    it('invokes the listener immediately with the current snapshot', () => {
      const sub = new BridgeSubscription();
      const listener = vi.fn();
      sub.subscribe(listener);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        state: null,
        loading: false,
        error: null,
      });
    });

    it('returns an unsubscribe function — after calling it, further changes do not reach the listener', () => {
      const sub = new BridgeSubscription();
      const listener = vi.fn();
      const unsubscribe = sub.subscribe(listener);

      // initial-call from subscribe() — clear that out of the way
      expect(listener).toHaveBeenCalledTimes(1);
      listener.mockClear();

      unsubscribe();

      sub.setLoading(true);
      sub.hydrate(STATE);
      sub.setError('boom');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // hydrate(state)
  // -------------------------------------------------------------------------

  describe('hydrate(state)', () => {
    it('updates snapshot.state, clears error, and notifies subscribers', () => {
      const sub = new BridgeSubscription();
      sub.setError('previous error');

      const listener = vi.fn();
      sub.subscribe(listener);
      listener.mockClear();

      sub.hydrate(STATE);

      const snap = sub.snapshot();
      expect(snap.state).toEqual(STATE);
      expect(snap.error).toBeNull();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        state: STATE,
        loading: false,
        error: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // setLoading / setError notifications
  // -------------------------------------------------------------------------

  describe('setLoading / setError', () => {
    it('setLoading(true) notifies subscribers', () => {
      const sub = new BridgeSubscription();
      const listener = vi.fn();
      sub.subscribe(listener);
      listener.mockClear();

      sub.setLoading(true);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].loading).toBe(true);
    });

    it('setError("foo") notifies subscribers', () => {
      const sub = new BridgeSubscription();
      const listener = vi.fn();
      sub.subscribe(listener);
      listener.mockClear();

      sub.setError('foo');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].error).toBe('foo');
    });

    it('setLoading(true) when already loading is a no-op (no extra notification)', () => {
      const sub = new BridgeSubscription();
      sub.setLoading(true); // first transition, listener not yet attached

      const listener = vi.fn();
      sub.subscribe(listener);
      // subscribe() invokes once with current snapshot.
      expect(listener).toHaveBeenCalledTimes(1);
      listener.mockClear();

      sub.setLoading(true); // already true → no-op per source `if (this._loading === loading) return;`

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // mount(opts) — happy path
  // -------------------------------------------------------------------------

  describe('mount(opts) happy path', () => {
    it('hydrates snapshot with the fetched state and ends loading=false', async () => {
      mockHttpFetch.mockResolvedValue(STATE);

      const sub = new BridgeSubscription();
      await sub.mount(MOUNT_OPTS);

      const snap = sub.snapshot();
      expect(snap.state).toEqual(STATE);
      expect(snap.loading).toBe(false);
      expect(snap.error).toBeNull();

      // The httpFetch URL and headers are part of the public contract that
      // consumers rely on. Pin them.
      const [url, opts] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/billing/state');
      expect(opts.method).toBe('GET');
      expect(opts.headers).toMatchObject({
        Authorization: 'Bearer access-tok',
        'x-app-id': 'app1',
      });
    });
  });

  // -------------------------------------------------------------------------
  // mount(opts) — failure path
  // -------------------------------------------------------------------------

  describe('mount(opts) failure path', () => {
    it('sets snapshot.error on failure and does NOT throw to the caller', async () => {
      mockHttpFetch.mockRejectedValue(new Error('network down'));

      const sub = new BridgeSubscription();
      // Must resolve — failure path is contained inside mount().
      await expect(sub.mount(MOUNT_OPTS)).resolves.toBeUndefined();

      const snap = sub.snapshot();
      expect(snap.error).toBe('network down');
      expect(snap.loading).toBe(false);
      // state remains untouched (null on a fresh instance)
      expect(snap.state).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // markLocked(payload) — Billing 2.0 soft gate. Flips the store into the
  // locked state from a caught BillingLockedError, even with no prior mount
  // baseline.
  // -------------------------------------------------------------------------

  describe('markLocked(payload)', () => {
    const lockedPayload = {
      reason: 'billing_locked' as const,
      billing: { status: 'past_due' as const, gateEngaged: true, recoveryUrl: '/billing' },
    };

    it('flips gateEngaged to true with no prior mount baseline', () => {
      const sub = new BridgeSubscription();
      expect(sub.snapshot().state).toBeNull();

      sub.markLocked(lockedPayload);

      expect(sub.snapshot().state?.gateEngaged).toBe(true);
    });

    it('sets recoveryUrl from the payload', () => {
      const sub = new BridgeSubscription();
      sub.markLocked(lockedPayload);
      expect(sub.snapshot().state?.recoveryUrl).toBe('/billing');
    });

    it('sets status from the payload', () => {
      const sub = new BridgeSubscription();
      sub.markLocked(lockedPayload);
      expect(sub.snapshot().state?.status).toBe('past_due');
    });

    it('synthesizes a plan placeholder when no baseline exists', () => {
      const sub = new BridgeSubscription();
      sub.markLocked(lockedPayload);
      expect(sub.snapshot().state?.plan).toEqual({ slug: 'unknown', name: 'Unknown' });
    });

    it('preserves the existing plan when a baseline already exists', () => {
      const sub = new BridgeSubscription();
      sub.hydrate({ plan: { slug: 'pro', name: 'Pro' }, status: 'active' });
      sub.markLocked(lockedPayload);
      const state = sub.snapshot().state;
      expect(state?.plan).toEqual({ slug: 'pro', name: 'Pro' });
      expect(state?.gateEngaged).toBe(true);
    });

    it('notifies subscribers when the store is locked', () => {
      const sub = new BridgeSubscription();
      const listener = vi.fn();
      sub.subscribe(listener); // fires once immediately with the null baseline
      listener.mockClear();

      sub.markLocked(lockedPayload);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].state?.gateEngaged).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// useBridge() singleton
// ---------------------------------------------------------------------------

describe('useBridge() singleton', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetUseBridgeForTests();
  });

  it('returns the SAME subscription instance across calls', () => {
    const a = useBridge();
    const b = useBridge();
    expect(a).toBe(b);
    expect(a.subscription).toBe(b.subscription);
  });

  it('snapshot survives across calls (singleton state is preserved)', () => {
    const first = useBridge();
    first.subscription.hydrate(STATE);

    const second = useBridge();
    const snap: BillingSubscriptionSnapshot = second.subscription.snapshot();
    expect(snap.state).toEqual(STATE);
  });

  it('__resetUseBridgeForTests() drops the singleton — subsequent useBridge() returns a fresh subscription', () => {
    const before = useBridge();
    before.subscription.hydrate(STATE);

    __resetUseBridgeForTests();

    const after = useBridge();
    expect(after).not.toBe(before);
    expect(after.subscription).not.toBe(before.subscription);
    expect(after.subscription.snapshot().state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Billing 2.0 / Phase A / US-3 (TBP-249) — `attach(rt)` plan-change handler.
//
// `BridgeSubscription.attach(rt)` registers a hook on a RealtimeClient that
// hydrates the reactive store when a `subscription.plan_changed` message
// arrives on the workspace channel. These tests mock a minimal
// RealtimeClient-like object that exposes `setOnSubscriptionPlanChanged`,
// capture the registered hook, then invoke it directly with synthetic
// messages. The full Centrifugo+websocket transport is covered separately by
// the RealtimeClient subscription spec.
// ---------------------------------------------------------------------------

function makePlanChangedMessage(
  overrides: Partial<SubscriptionPlanChangedMessage> = {},
): SubscriptionPlanChangedMessage {
  return {
    kind: 'subscription.plan_changed',
    tenantId: 'tenant-1',
    from: { slug: 'free' },
    to: { slug: 'pro', name: 'Pro' },
    status: 'active',
    effectiveAt: '2026-05-19T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Minimal stub matching the RealtimeClient surface that BridgeSubscription
 * touches in `attach()`. Casting to `RealtimeClient` lets us call the real
 * method without spinning up the full client (websocket, fetch, reconnect
 * scheduler, etc.). The real client's `setOnSubscriptionPlanChanged` simply
 * stores the hook on a private field — exactly what we mimic here.
 */
interface RtStub {
  hook?: (msg: SubscriptionPlanChangedMessage) => void;
  lifecycleHook?: (msg: unknown) => void;
  setOnSubscriptionPlanChanged: (hook: (msg: SubscriptionPlanChangedMessage) => void) => void;
  setOnBillingLifecycle: (hook: (msg: unknown) => void) => void;
}

function makeRtStub(): RtStub {
  const stub: RtStub = {
    setOnSubscriptionPlanChanged(hook) {
      stub.hook = hook;
    },
    setOnBillingLifecycle(hook) {
      stub.lifecycleHook = hook;
    },
  };
  return stub;
}

describe('BridgeSubscription.attach(rt) — US-3 plan_changed handler', () => {
  it('registers a subscription.plan_changed hook on the RealtimeClient', () => {
    const sub = new BridgeSubscription();
    const rt = makeRtStub();
    const spy = vi.spyOn(rt, 'setOnSubscriptionPlanChanged');

    sub.attach(rt as unknown as RealtimeClient);

    expect(spy).toHaveBeenCalledTimes(1);
    // The hook itself is a function — the real RealtimeClient stores this for
    // later invocation from handleMessage().
    expect(typeof rt.hook).toBe('function');
  });

  it('invoking the captured hook hydrates snapshot.state with { plan: msg.to, status: msg.status }', () => {
    const sub = new BridgeSubscription();
    const rt = makeRtStub();
    sub.attach(rt as unknown as RealtimeClient);

    const msg = makePlanChangedMessage();
    rt.hook!(msg);

    const snap = sub.snapshot();
    expect(snap.state).toEqual({
      plan: msg.to,
      status: msg.status,
    });
    // hydrate() clears any pre-existing error.
    expect(snap.error).toBeNull();
  });

  it('multiple attach() calls — re-registering the hook is fine; latest hook wins', () => {
    const sub = new BridgeSubscription();
    const rt = makeRtStub();

    sub.attach(rt as unknown as RealtimeClient);
    const firstHook = rt.hook;

    sub.attach(rt as unknown as RealtimeClient);
    const secondHook = rt.hook;

    // The real RealtimeClient stores the latest hook on a single private
    // field — the second registration overwrites the first. Both hooks
    // should be functions; their identity may or may not differ depending
    // on whether attach() creates a fresh closure each call.
    expect(typeof firstHook).toBe('function');
    expect(typeof secondHook).toBe('function');

    // Invoking the latest hook updates the subscription.
    const msg = makePlanChangedMessage({ to: { slug: 'enterprise', name: 'Enterprise' } });
    secondHook!(msg);
    expect(sub.snapshot().state).toEqual({ plan: msg.to, status: msg.status });
  });

  it('attach() notifies subscribed listeners when a plan_changed message arrives', () => {
    const sub = new BridgeSubscription();
    const rt = makeRtStub();
    sub.attach(rt as unknown as RealtimeClient);

    const listener = vi.fn();
    sub.subscribe(listener);
    // subscribe() invokes once immediately with the current snapshot — clear
    // that out before exercising the hook.
    listener.mockClear();

    const msg = makePlanChangedMessage();
    rt.hook!(msg);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].state).toEqual({ plan: msg.to, status: msg.status });
  });

  it('a malformed message (missing to.slug) does not crash the hook — no throw escapes', () => {
    const sub = new BridgeSubscription();
    const rt = makeRtStub();
    sub.attach(rt as unknown as RealtimeClient);

    // Construct a half-built message — TS cast lets us simulate the wire
    // payload a future server bug or rogue test fixture might send. The
    // current hydrate() implementation does not validate the shape, so
    // this will write a partial state into the snapshot. Either way, the
    // critical invariant is: nothing throws.
    const badMsg = {
      kind: 'subscription.plan_changed',
      tenantId: 'tenant-1',
      from: { slug: 'free' },
      to: { name: 'NoSlug' }, // ← missing slug
      status: 'active',
      effectiveAt: '2026-05-19T12:00:00.000Z',
    } as unknown as SubscriptionPlanChangedMessage;

    expect(() => rt.hook!(badMsg)).not.toThrow();
  });

  it('an unknown status string still hydrates — no client-side rejection', () => {
    // The BillingSubscriptionStatus union in types.ts only allows a fixed
    // set of strings, but the hook performs a `status as BillingSubscriptionStatus`
    // cast — there is no runtime check. This documents the current
    // behavior: if the server publishes a status the SDK doesn't know
    // about (e.g. future "paused"), it will still appear in snapshot.state.
    const sub = new BridgeSubscription();
    const rt = makeRtStub();
    sub.attach(rt as unknown as RealtimeClient);

    const msg = makePlanChangedMessage({ status: 'paused' });
    rt.hook!(msg);

    expect(sub.snapshot().state).toEqual({ plan: msg.to, status: 'paused' });
  });
});

// ---------------------------------------------------------------------------
// Billing 2.0 / Phase B (US-5..US-9, TBP-249+) — `_applyLifecycle(msg)` patches.
//
// `BridgeSubscription.attach(rt)` registers a billing-lifecycle hook on the
// RealtimeClient. When the server publishes a `BillingLifecycleMessage` of
// any kind, the hook patches the cached snapshot conservatively — touching
// only the fields the event semantically affects.
//
// These tests cover all 15 kinds in the union (see src/flags/realtime.ts).
// For each kind we mount a baseline state, fire the lifecycle message through
// the captured hook, and assert the resulting snapshot reflects the patch.
// ---------------------------------------------------------------------------

import type { BillingLifecycleMessage } from '../flags/realtime.js';

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

/**
 * Helper: hydrate a fresh subscription with `baseline`, attach an RtStub,
 * then return both the subscription and the captured lifecycle hook so a
 * test can fire arbitrary messages through it.
 */
function makeAttachedSub(
  baseline: BillingSubscriptionState = BASELINE,
): { sub: BridgeSubscription; fire: (msg: BillingLifecycleMessage) => void } {
  const sub = new BridgeSubscription();
  sub.hydrate(baseline);
  const rt = makeRtStub();
  sub.attach(rt as unknown as RealtimeClient);
  return {
    sub,
    fire: (msg) => rt.lifecycleHook!(msg),
  };
}

describe('BridgeSubscription._applyLifecycle(msg) — Phase B coverage', () => {
  // -------------------------------------------------------------------------
  // No-baseline guard: lifecycle events arriving before the first hydrate()
  // are dropped — the docblock says "consumer should mount first".
  // -------------------------------------------------------------------------

  it('drops lifecycle messages when no baseline state exists (state stays null)', () => {
    const sub = new BridgeSubscription();
    const rt = makeRtStub();
    sub.attach(rt as unknown as RealtimeClient);

    expect(() => rt.lifecycleHook!(makeLifecycleMsg('payment.failed'))).not.toThrow();
    expect(sub.snapshot().state).toBeNull();
  });

  // -------------------------------------------------------------------------
  // payment.*
  // -------------------------------------------------------------------------

  describe('payment.failed', () => {
    it('sets status=past_due, pastDueReason=card_declined by default, copies cardLast4', () => {
      const { sub, fire } = makeAttachedSub();
      fire(makeLifecycleMsg('payment.failed', { cardLast4: '4242' }));
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        pastDueReason: 'card_declined',
        cardLast4: '4242',
      });
    });

    it('honors an explicit pastDueReason on the message', () => {
      const { sub, fire } = makeAttachedSub();
      fire(makeLifecycleMsg('payment.failed', { pastDueReason: 'card_removed' }));
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        pastDueReason: 'card_removed',
      });
    });
  });

  describe('payment.succeeded', () => {
    it('sets status=active, clears pastDueReason / retries / gateEngaged', () => {
      const { sub, fire } = makeAttachedSub({
        ...BASELINE,
        status: 'past_due',
        pastDueReason: 'card_declined',
        nextRetryAt: '2026-05-20T00:00:00.000Z',
        finalRetryAt: '2026-05-25T00:00:00.000Z',
        gateEngaged: true,
      });
      fire(makeLifecycleMsg('payment.succeeded'));
      expect(sub.snapshot().state).toMatchObject({
        status: 'active',
        pastDueReason: null,
        nextRetryAt: undefined,
        finalRetryAt: undefined,
        gateEngaged: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // subscription.*
  // -------------------------------------------------------------------------

  describe('subscription.created', () => {
    it('does not mutate snapshot.state (mount() refetches the full state)', () => {
      const { sub, fire } = makeAttachedSub();
      const before = sub.snapshot().state;
      fire(makeLifecycleMsg('subscription.created'));
      const after = sub.snapshot().state;
      // Reference may differ (hydrate() clones via `...current`) — equality on shape.
      expect(after).toEqual(before);
    });
  });

  describe('subscription.updated', () => {
    it('does not mutate snapshot.state (mount() refetches the full state)', () => {
      const { sub, fire } = makeAttachedSub();
      const before = sub.snapshot().state;
      fire(makeLifecycleMsg('subscription.updated'));
      const after = sub.snapshot().state;
      expect(after).toEqual(before);
    });
  });

  describe('subscription.canceled', () => {
    it('sets status=canceled and copies endsAt', () => {
      const { sub, fire } = makeAttachedSub();
      fire(
        makeLifecycleMsg('subscription.canceled', {
          endsAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      expect(sub.snapshot().state).toMatchObject({
        status: 'canceled',
        endsAt: '2026-06-01T00:00:00.000Z',
      });
    });
  });

  describe('subscription.reactivated', () => {
    it('sets status=active and clears endsAt', () => {
      const { sub, fire } = makeAttachedSub({
        ...BASELINE,
        status: 'canceled',
        endsAt: '2026-06-01T00:00:00.000Z',
      });
      fire(makeLifecycleMsg('subscription.reactivated'));
      expect(sub.snapshot().state).toMatchObject({
        status: 'active',
        endsAt: undefined,
      });
    });
  });

  describe('subscription.trial_started', () => {
    it('sets status=trial and copies endsAt / daysLeft / hasCardOnFile', () => {
      const { sub, fire } = makeAttachedSub();
      fire(
        makeLifecycleMsg('subscription.trial_started', {
          endsAt: '2026-06-01T00:00:00.000Z',
          daysLeft: 14,
          hasCardOnFile: true,
        }),
      );
      expect(sub.snapshot().state).toMatchObject({
        status: 'trial',
        endsAt: '2026-06-01T00:00:00.000Z',
        daysLeft: 14,
        hasCardOnFile: true,
      });
    });
  });

  describe('subscription.trial_ending_soon', () => {
    it('updates daysLeft without changing status', () => {
      const { sub, fire } = makeAttachedSub({
        ...BASELINE,
        status: 'trial',
        daysLeft: 14,
      });
      fire(makeLifecycleMsg('subscription.trial_ending_soon', { daysLeft: 3 }));
      expect(sub.snapshot().state).toMatchObject({
        status: 'trial',
        daysLeft: 3,
      });
    });
  });

  describe('subscription.trial_converted', () => {
    it('sets status=active and clears endsAt + daysLeft', () => {
      const { sub, fire } = makeAttachedSub({
        ...BASELINE,
        status: 'trial',
        endsAt: '2026-06-01T00:00:00.000Z',
        daysLeft: 5,
      });
      fire(makeLifecycleMsg('subscription.trial_converted'));
      expect(sub.snapshot().state).toMatchObject({
        status: 'active',
        endsAt: undefined,
        daysLeft: undefined,
      });
    });
  });

  describe('subscription.trial_expired', () => {
    it('sets status=past_due and pastDueReason=trial_expired', () => {
      const { sub, fire } = makeAttachedSub({
        ...BASELINE,
        status: 'trial',
      });
      fire(makeLifecycleMsg('subscription.trial_expired'));
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        pastDueReason: 'trial_expired',
      });
    });
  });

  // -------------------------------------------------------------------------
  // dunning.*
  // -------------------------------------------------------------------------

  describe('dunning.entered', () => {
    it('sets status=past_due and copies retry timestamps', () => {
      const { sub, fire } = makeAttachedSub();
      fire(
        makeLifecycleMsg('dunning.entered', {
          nextRetryAt: '2026-05-20T00:00:00.000Z',
          finalRetryAt: '2026-05-25T00:00:00.000Z',
        }),
      );
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        nextRetryAt: '2026-05-20T00:00:00.000Z',
        finalRetryAt: '2026-05-25T00:00:00.000Z',
      });
    });
  });

  describe('dunning.retry_scheduled', () => {
    it('sets status=past_due and updates nextRetryAt', () => {
      const { sub, fire } = makeAttachedSub();
      fire(
        makeLifecycleMsg('dunning.retry_scheduled', {
          nextRetryAt: '2026-05-21T00:00:00.000Z',
        }),
      );
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        nextRetryAt: '2026-05-21T00:00:00.000Z',
      });
    });
  });

  describe('dunning.recovered', () => {
    it('sets status=active, clears pastDueReason / retries / gateEngaged', () => {
      const { sub, fire } = makeAttachedSub({
        ...BASELINE,
        status: 'past_due',
        pastDueReason: 'card_declined',
        nextRetryAt: '2026-05-20T00:00:00.000Z',
        finalRetryAt: '2026-05-25T00:00:00.000Z',
        gateEngaged: true,
      });
      fire(makeLifecycleMsg('dunning.recovered'));
      expect(sub.snapshot().state).toMatchObject({
        status: 'active',
        pastDueReason: null,
        nextRetryAt: undefined,
        finalRetryAt: undefined,
        gateEngaged: false,
      });
    });
  });

  describe('dunning.exhausted', () => {
    it('sets status=past_due and gateEngaged=true by default', () => {
      const { sub, fire } = makeAttachedSub();
      fire(makeLifecycleMsg('dunning.exhausted'));
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        gateEngaged: true,
      });
    });

    it('honors an explicit gateEngaged=false on the message', () => {
      const { sub, fire } = makeAttachedSub();
      fire(makeLifecycleMsg('dunning.exhausted', { gateEngaged: false }));
      expect(sub.snapshot().state).toMatchObject({
        status: 'past_due',
        gateEngaged: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // entitlements.*
  // -------------------------------------------------------------------------

  describe('entitlements.changed', () => {
    it('is a pure signal — no status mutation', () => {
      const { sub, fire } = makeAttachedSub();
      const before = sub.snapshot().state;
      fire(makeLifecycleMsg('entitlements.changed'));
      const after = sub.snapshot().state;
      expect(after).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Listener fan-out — every lifecycle that mutates the state should notify
  // subscribers via _notify() (called from hydrate()).
  // -------------------------------------------------------------------------

  it('every mutating lifecycle notifies snapshot subscribers', () => {
    const { sub, fire } = makeAttachedSub();
    const listener = vi.fn();
    sub.subscribe(listener);
    listener.mockClear();

    fire(makeLifecycleMsg('payment.failed'));
    fire(makeLifecycleMsg('payment.succeeded'));
    fire(makeLifecycleMsg('subscription.canceled', { endsAt: '2026-06-01T00:00:00.000Z' }));
    fire(makeLifecycleMsg('subscription.reactivated'));

    expect(listener).toHaveBeenCalledTimes(4);
  });
});
