import type { Logger } from '../logger.js';
import type {
  BillingLifecycleMessage,
  RealtimeClient,
  SubscriptionPlanChangedMessage,
} from '../flags/realtime.js';
import { fetchBillingState } from './fetch-billing-state.js';
import type {
  BillingLockedPayload,
  BillingSubscriptionSnapshot,
  BillingSubscriptionState,
  BillingSubscriptionStatus,
  MountOptions,
  PastDueReason,
} from './types.js';

type Listener = (snapshot: BillingSubscriptionSnapshot) => void;

const noopLogger: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Reactive container for the canonical Billing 2.0 subscription state.
 * Framework-agnostic; consumers attach a listener via `subscribe()` and read
 * the current value via `snapshot()`. Compatible with the Svelte store
 * contract (`subscribe(listener) => unsubscribe`).
 *
 * Parallel to the FF 2.0 `BridgeFlags` reactive surface — do NOT unify yet.
 * REF-1 (post-feature) will fold them together.
 */
export class BridgeSubscription {
  private _state: BillingSubscriptionState | null = null;
  private _loading = false;
  private _error: string | null = null;
  private _listeners = new Set<Listener>();

  /** Current snapshot. */
  snapshot(): BillingSubscriptionSnapshot {
    return {
      state: this._state,
      loading: this._loading,
      error: this._error,
    };
  }

  /**
   * Subscribe to snapshot changes. Invokes the listener immediately with the
   * current snapshot (Svelte-store compatible). Returns an unsubscribe fn.
   */
  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Replace the cached state and notify subscribers. */
  hydrate(state: BillingSubscriptionState): void {
    this._state = state;
    this._error = null;
    this._notify();
  }

  setLoading(loading: boolean): void {
    if (this._loading === loading) return;
    this._loading = loading;
    this._notify();
  }

  setError(error: string | null): void {
    this._error = error;
    this._notify();
  }

  /**
   * Fetch `GET /billing/state` once and hydrate. Idempotent on success — the
   * SDK caches the result in memory and any subsequent `mount()` call is
   * effectively a manual refetch. US-3 adds the live push that updates the
   * cache without a refetch.
   *
   * HTTP is intentionally inside auth-core here (per US-2 AC) so framework
   * wrappers don't each reimplement the fetch.
   */
  async mount(opts: MountOptions, logger: Logger = noopLogger): Promise<void> {
    this.setLoading(true);
    this.setError(null);
    try {
      const state = await fetchBillingState(opts, logger);
      this.hydrate(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load billing state';
      this.setError(message);
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * Flip the store into the locked state from a caught `BillingLockedError`.
   * Patches `gateEngaged`/`status`/`recoveryUrl` so the notice + gate react
   * immediately even when no prior `mount()` baseline exists.
   */
  markLocked(payload: BillingLockedPayload): void {
    const current = this._state;
    const next: BillingSubscriptionState = current
      ? { ...current }
      : { plan: { slug: 'unknown', name: 'Unknown' }, status: payload.billing.status };
    next.status = payload.billing.status;
    next.gateEngaged = payload.billing.gateEngaged;
    if (payload.billing.recoveryUrl) next.recoveryUrl = payload.billing.recoveryUrl;
    this.hydrate(next);
  }

  /**
   * Billing 2.0 — attach to a Milestone K RealtimeClient so canonical
   * lifecycle events on the workspace channel patch the reactive store.
   * Handles US-3 plan-change + US-4+ lifecycle (payment.*, subscription.*,
   * dunning.*, entitlements.*). Idempotent: re-attaching replaces hooks.
   * Framework SDKs call this once after constructing both the RealtimeClient
   * and the BridgeSubscription instance.
   */
  attach(rt: RealtimeClient): void {
    rt.setOnSubscriptionPlanChanged((msg) => this._applyPlanChanged(msg));
    rt.setOnBillingLifecycle((msg) => this._applyLifecycle(msg));
  }

  /**
   * TBP-360 — Hydrate from a `subscription.plan_changed` push. Extracted into
   * a public-but-internal method so `useBridge().attachToRealtimeClient` can
   * install a composite hook (subscription hydrate + dev-handler fan-out)
   * without re-implementing the patch logic.
   */
  _applyPlanChanged(msg: SubscriptionPlanChangedMessage): void {
    this.hydrate({
      plan: msg.to,
      status: msg.status as BillingSubscriptionStatus,
    });
  }

  /**
   * Patch the snapshot based on a lifecycle event. Conservative — only
   * touches the fields the event semantically affects. Callers can still
   * trigger a full refetch via `mount(opts)` to re-sync from the server.
   */
  private _applyLifecycle(msg: BillingLifecycleMessage): void {
    const current = this._state;
    if (!current) {
      // No baseline yet; lifecycle events can't reconstruct a full state
      // from scratch — they're patches. Skip; consumer should mount first.
      return;
    }
    const next: BillingSubscriptionState = { ...current };

    switch (msg.kind) {
      case 'payment.failed':
        next.status = 'past_due';
        next.pastDueReason = (msg.pastDueReason as PastDueReason) ?? 'card_declined';
        if (msg.cardLast4) next.cardLast4 = msg.cardLast4;
        break;
      case 'payment.succeeded':
      case 'dunning.recovered':
        next.status = 'active';
        next.pastDueReason = null;
        next.nextRetryAt = undefined;
        next.finalRetryAt = undefined;
        next.gateEngaged = false;
        break;
      case 'subscription.canceled':
        next.status = 'canceled';
        if (msg.endsAt) next.endsAt = msg.endsAt;
        break;
      case 'subscription.reactivated':
        next.status = 'active';
        next.endsAt = undefined;
        break;
      case 'subscription.trial_started':
        next.status = 'trial';
        if (msg.endsAt) next.endsAt = msg.endsAt;
        if (msg.daysLeft !== undefined) next.daysLeft = msg.daysLeft;
        if (msg.hasCardOnFile !== undefined) next.hasCardOnFile = msg.hasCardOnFile;
        break;
      case 'subscription.trial_ending_soon':
        if (msg.daysLeft !== undefined) next.daysLeft = msg.daysLeft;
        break;
      case 'subscription.trial_converted':
        next.status = 'active';
        next.endsAt = undefined;
        next.daysLeft = undefined;
        break;
      case 'subscription.trial_expired':
        next.status = 'past_due';
        next.pastDueReason = 'trial_expired';
        break;
      case 'dunning.entered':
      case 'dunning.retry_scheduled':
        next.status = 'past_due';
        if (msg.nextRetryAt) next.nextRetryAt = msg.nextRetryAt;
        if (msg.finalRetryAt) next.finalRetryAt = msg.finalRetryAt;
        break;
      case 'dunning.exhausted':
        next.status = 'past_due';
        next.gateEngaged = msg.gateEngaged ?? true;
        break;
      case 'entitlements.changed':
        // Pure signal — consumer apps re-read entitlements. No status mutation here.
        break;
      case 'subscription.created':
      case 'subscription.updated':
        // No-op on the cached snapshot. Mount fetches the full state if the
        // consumer needs the new values.
        break;
    }

    this.hydrate(next);
  }

  private _notify(): void {
    const snap = this.snapshot();
    for (const listener of this._listeners) {
      listener(snap);
    }
  }
}
