import type {
  BillingLifecycleMessage,
  EntitlementsChangedMessage,
  QuotaUpdatedMessage,
  RealtimeClient,
  SubscriptionPlanChangedMessage,
} from '../flags/realtime.js';
import { BillingLockedError } from '../errors.js';
import { BridgeSubscription } from './bridge-subscription.js';
import { setBillingLockHandler } from './lock-signal.js';
import {
  EntitlementsStore,
  type EntitlementSnapshot,
} from './entitlements-store.js';
import { QuotaStore, type QuotaSnapshot } from './quota-store.js';
import { deriveNoticeState, deriveSeverity } from './types.js';
import type { BillingNoticeState, BillingSeverity } from './types.js';

/** Resolved billing-gate view for the current snapshot. */
export interface BillingGateState {
  locked: boolean;
  severity: BillingSeverity;
  noticeState: BillingNoticeState;
  recoveryUrl?: string;
}

/**
 * BillingLifecycleMessage's discriminator union includes `'entitlements.changed'`
 * as a signal-only kind. US-12 introduces a parallel payload-carrying variant
 * (EntitlementsChangedMessage) routed through `setOnEntitlementsChanged`. The
 * dev-handler table accepts either shape under that key — the dispatch site
 * routes per-message based on the presence of `entitlements`.
 */
type EntitlementsChangedHandlerArg =
  | BillingLifecycleMessage
  | EntitlementsChangedMessage;

export type BillingEventHandlers = {
  [K in Exclude<BillingLifecycleMessage['kind'], 'entitlements.changed'>]?: (
    msg: BillingLifecycleMessage,
  ) => void;
} & {
  /**
   * TBP-360 — handler for canonical plan-change pushes. Lives on its own kind
   * (SubscriptionPlanChangedMessage) outside `BillingLifecycleMessage`, but is
   * exposed through the same multi-subscriber dispatch so bridge-svelte's
   * `bridge.events.handle({ 'subscription.plan_changed': fn })` works.
   */
  'subscription.plan_changed'?: (msg: SubscriptionPlanChangedMessage) => void;
  /**
   * Billing 2.0 US-11 — handler for live quota counter pushes. Mirrors the
   * lifecycle-event handler pattern: framework wrappers + dev consumers can
   * both register; both fire on every matching event.
   */
  'quota.updated'?: (msg: QuotaUpdatedMessage) => void;
  /**
   * Billing 2.0 US-12 — handler for live entitlement snapshot pushes. Fires
   * alongside the EntitlementsStore cache replacement so dev consumers
   * (analytics, audit, etc.) can react to the same event the UI gates on.
   * Receives the payload-carrying `EntitlementsChangedMessage` (US-12 shape);
   * the legacy signal-only lifecycle variant fans out through the lifecycle
   * dispatch like other lifecycle kinds.
   */
  'entitlements.changed'?: (msg: EntitlementsChangedHandlerArg) => void;
};

/**
 * Billing 2.0 US-12 — top-level entitlements accessor. Mirrors the
 * fail-closed semantics of `EntitlementsStore.can` so consumers can write
 * `bridge.entitlements.can('ai_completions')` without holding a store ref.
 */
export interface UseBridgeEntitlementsApi {
  can(name: string): boolean;
  all(): EntitlementSnapshot;
}

export interface UseBridgeApi {
  subscription: BridgeSubscription;
  /**
   * Billing 2.0 US-11 — reactive quota snapshot for a single metric. The
   * first call for a given metric kicks off a `GET /usage/quota/:metric`
   * hydration; while in flight, returns `undefined`. Once hydrated (and on
   * every subsequent `quota.updated` push), returns the full snapshot.
   *
   * Framework wrappers (bridge-svelte's `useBridge().quota(metric)`) wrap
   * this in a runes-aware proxy so Svelte components re-render on push.
   */
  quota(metric: string): QuotaSnapshot | undefined;
  /**
   * Direct access to the underlying QuotaStore — framework wrappers use this
   * to subscribe to push notifications and re-render on cache mutations.
   */
  readonly quotas: QuotaStore;
  /**
   * Billing 2.0 US-12 — top-level entitlements accessor (`bridge.entitlements.can(name)`).
   * Fail-closed: returns false until hydration completes and the key is
   * explicitly true.
   */
  readonly entitlements: UseBridgeEntitlementsApi;
  /**
   * Direct access to the underlying EntitlementsStore — framework wrappers
   * use this to subscribe to snapshot replacements and re-render UI.
   */
  readonly entitlementsStore: EntitlementsStore;
  /**
   * Register dev-supplied side-effect handlers for canonical lifecycle events
   * (analytics, Slack, audit, etc.) — separate from the UI rendering path
   * which is owned by `<BridgeBillingNotice />`. Per locked decision #9, dev
   * handlers run alongside UI handlers; both fire on every matching event.
   *
   * Caller must call `attachToRealtimeClient(rt)` once (typically done by
   * the framework wrapper) before any handlers can fire.
   */
  handle(handlers: BillingEventHandlers): () => void;
  /**
   * Wire the surface to a Milestone K RealtimeClient. Framework wrappers
   * (bridge-svelte / bridge-react / ...) call this once during init.
   */
  attachToRealtimeClient(rt: RealtimeClient): void;
  /**
   * Billing 2.0 soft gate — true when the workspace is billing-locked
   * (`gateEngaged`). Fail-closed: false until state is known. Use for
   * proactively disabling write actions in the UI.
   */
  isLocked(): boolean;
  /**
   * Resolved gate view (locked + severity + notice state + recoveryUrl) derived
   * from the current snapshot. Drives custom lockscreens without re-deriving.
   */
  gateState(): BillingGateState;
  /**
   * Imperative guard — throws `BillingLockedError` if the workspace is locked.
   * Node-safe; use to wrap a write before it leaves the client/server.
   */
  assertNotLocked(): void;
}

let _singleton: UseBridgeApi | null = null;
let _devHandlers: BillingEventHandlers[] = [];
let _attachedRt: RealtimeClient | undefined;
let _quotaStore: QuotaStore | null = null;
let _entitlementsStore: EntitlementsStore | null = null;

/**
 * Billing 2.0 reactive SDK shell. Phase A exposes `.subscription` reactivity;
 * Phase B adds `.handle(...)` for dev-supplied side-effect handlers + the
 * `attachToRealtimeClient(rt)` wiring entry point.
 *
 * Parallel to FF 2.0's existing reactive surface — do NOT unify. REF-1
 * (post-feature) folds them together.
 */
export function useBridge(): UseBridgeApi {
  if (!_singleton) {
    const subscription = new BridgeSubscription();
    const quotaStore = new QuotaStore();
    const entitlementsStore = new EntitlementsStore();
    _quotaStore = quotaStore;
    _entitlementsStore = entitlementsStore;
    _singleton = {
      subscription,
      quotas: quotaStore,
      quota(metric: string): QuotaSnapshot | undefined {
        return quotaStore.ensureHydrated(metric);
      },
      entitlementsStore,
      entitlements: {
        can(name: string): boolean {
          return entitlementsStore.can(name);
        },
        all(): EntitlementSnapshot {
          return entitlementsStore.all();
        },
      },
      handle(handlers) {
        _devHandlers.push(handlers);
        // Idempotent attach to existing rt if available
        return () => {
          _devHandlers = _devHandlers.filter((h) => h !== handlers);
        };
      },
      attachToRealtimeClient(rt) {
        if (_attachedRt === rt) return;
        _attachedRt = rt;
        subscription.attach(rt);
        // TBP-360 — RealtimeClient stores ONE hook per kind; subscription.attach
        // above already set the plan-change hook. Replace it with a composite
        // that applies the subscription patch AND fans out to dev handlers
        // registered via `useBridge().handle({ 'subscription.plan_changed' })`.
        rt.setOnSubscriptionPlanChanged((msg) => {
          (subscription as unknown as { _applyPlanChanged: (m: SubscriptionPlanChangedMessage) => void })._applyPlanChanged(msg);
          for (const handlers of _devHandlers) {
            const fn = handlers['subscription.plan_changed'];
            if (fn) {
              try {
                fn(msg);
              } catch {
                // ignore — dev handler errors don't affect SDK state
              }
            }
          }
        });
        // Funnel lifecycle events to dev handlers AFTER the subscription
        // surface has patched its own state.
        rt.setOnBillingLifecycle((msg) => {
          // Patch the snapshot first (BridgeSubscription.attach above already
          // registered its own hook; the RealtimeClient stores ONE hook per
          // kind, so re-set means we replace it). We replicate the snapshot
          // patch + dev fan-out here so both run.
          (subscription as unknown as { _applyLifecycle: (m: BillingLifecycleMessage) => void })._applyLifecycle(msg);
          for (const handlers of _devHandlers) {
            // `handlers[msg.kind]` is union-typed across kinds; cast at the
            // call site so each handler receives its declared message shape.
            const fn = (handlers as Record<string, ((m: BillingLifecycleMessage) => void) | undefined>)[
              msg.kind
            ];
            if (fn) {
              try {
                fn(msg);
              } catch {
                // ignore — dev handler errors don't affect SDK state
              }
            }
          }
        });
        // US-11 — wire quota.updated pushes into the store AND fan out to
        // dev handlers that registered for 'quota.updated'.
        rt.setOnQuotaUpdated((msg) => {
          quotaStore.applyQuotaUpdated(msg);
          for (const handlers of _devHandlers) {
            const fn = handlers['quota.updated'];
            if (fn) {
              try {
                fn(msg);
              } catch {
                // ignore — dev handler errors don't affect SDK state
              }
            }
          }
        });
        // US-12 — wire entitlements.changed pushes into the store AND fan
        // out to dev handlers that registered for 'entitlements.changed'.
        rt.setOnEntitlementsChanged((msg) => {
          entitlementsStore.applyEntitlementsChanged(msg.entitlements);
          for (const handlers of _devHandlers) {
            const fn = handlers['entitlements.changed'];
            if (fn) {
              try {
                fn(msg);
              } catch {
                // ignore — dev handler errors don't affect SDK state
              }
            }
          }
        });
        // US-12 — initial REST hydration on attach. Fire-and-forget; failures
        // are logged at warn inside the store. Subsequent pushes overwrite.
        void entitlementsStore.hydrate();
      },
      isLocked(): boolean {
        return subscription.snapshot().state?.gateEngaged ?? false;
      },
      gateState(): BillingGateState {
        const state = subscription.snapshot().state;
        const noticeState = deriveNoticeState(state);
        return {
          locked: state?.gateEngaged ?? false,
          severity: deriveSeverity(noticeState),
          noticeState,
          recoveryUrl: state?.recoveryUrl,
        };
      },
      assertNotLocked(): void {
        const state = subscription.snapshot().state;
        if (state?.gateEngaged) {
          throw new BillingLockedError({
            reason: 'billing_locked',
            billing: {
              status: state.status,
              gateEngaged: true,
              recoveryUrl: state.recoveryUrl,
            },
          });
        }
      },
    };
    // Auto-flip the store when any SDK call hits a billing-locked 402, so a
    // caught BillingLockedError surfaces in the notice/gate with no extra wiring.
    setBillingLockHandler((payload) => subscription.markLocked(payload));
  }
  return _singleton;
}

/**
 * Test-only: drop the singleton so each test starts with a fresh surface.
 * Not exported from the package entry — internal to the test suite.
 */
export function __resetUseBridgeForTests(): void {
  _singleton = null;
  _devHandlers = [];
  _attachedRt = undefined;
  setBillingLockHandler(null);
  if (_quotaStore) {
    _quotaStore.__resetForTests();
  }
  _quotaStore = null;
  if (_entitlementsStore) {
    _entitlementsStore.__resetForTests();
  }
  _entitlementsStore = null;
}
