// Billing 2.0 reactive surface types — parallel to FF 2.0.
// Do NOT merge with existing `SubscriptionStatus` (Stripe-direct path);
// unification is REF-1 post-feature.

export type BillingSubscriptionStatus =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'cancel_at_period_end'
  | 'canceled';

export type BillingSeverity = 'info' | 'warn' | 'critical' | 'locked';

export type PastDueReason = 'card_declined' | 'trial_expired' | 'card_removed' | null;

export interface BillingPlanRef {
  slug: string;
  name: string;
}

/**
 * Snapshot of canonical billing state exposed by `useBridge().subscription`.
 * Phase A (US-1, US-2) ships `plan` + `status`. Phase B (US-5..US-9) adds
 * the optional fields below as lifecycle events arrive.
 */
export interface BillingSubscriptionState {
  plan: BillingPlanRef;
  status: BillingSubscriptionStatus;
  // Phase B fields — optional, populated by lifecycle events
  pastDueReason?: PastDueReason;
  cardLast4?: string;
  hasCardOnFile?: boolean;
  endsAt?: string;
  daysLeft?: number;
  nextRetryAt?: string;
  finalRetryAt?: string;
  gateEngaged?: boolean;
  renewsAt?: string;
  /** Where to send a locked workspace to recover access (e.g. `/billing`). */
  recoveryUrl?: string;
}

/**
 * Wire contract for a billing-locked 402 response. Single source of truth shared
 * by the SDK (detection) and bridge-api (emission, Step 2). `reason` is the
 * detection discriminator — any 402 carrying `reason: 'billing_locked'` is a lock.
 */
export interface BillingLockedPayload {
  reason: 'billing_locked';
  billing: {
    status: BillingSubscriptionStatus;
    gateEngaged: boolean;
    recoveryUrl?: string;
  };
}

export interface BillingSubscriptionSnapshot {
  state: BillingSubscriptionState | null;
  loading: boolean;
  error: string | null;
}

export interface MountOptions {
  apiBaseUrl: string;
  accessToken: string;
  appId: string;
}

/**
 * Canonical UI states derived from `BillingSubscriptionState` for the
 * `<BridgeBillingNotice />` component. Pure derivation — not stored on
 * the snapshot.
 */
export type BillingNoticeState =
  | 'active'
  | 'trial_active'
  | 'trial_ending_soon'
  | 'cancel_at_period_end'
  | 'canceled'
  | 'past_due'
  | 'past_due_trial'
  | 'dunning_active'
  | 'dunning_final_retry'
  | 'dunning_exhausted';

/**
 * Derive the UI state from the canonical subscription snapshot. Used by
 * `<BridgeBillingNotice />` and admin-ui badges to pick the right copy +
 * severity tokens. Pure function — no side effects.
 */
export function deriveNoticeState(state: BillingSubscriptionState | null): BillingNoticeState {
  if (!state) return 'active';
  if (state.gateEngaged) return 'dunning_exhausted';
  if (state.status === 'canceled') return 'canceled';
  if (state.status === 'cancel_at_period_end') return 'cancel_at_period_end';
  if (state.status === 'past_due') {
    if (state.pastDueReason === 'trial_expired') return 'past_due_trial';
    if (state.finalRetryAt) return 'dunning_final_retry';
    if (state.nextRetryAt) return 'dunning_active';
    return 'past_due';
  }
  if (state.status === 'trial') {
    if (state.daysLeft !== undefined && state.daysLeft <= 3) return 'trial_ending_soon';
    return 'trial_active';
  }
  return 'active';
}

const SEVERITY_BY_STATE: Record<BillingNoticeState, BillingSeverity> = {
  active: 'info',
  trial_active: 'info',
  trial_ending_soon: 'warn',
  cancel_at_period_end: 'info',
  canceled: 'warn',
  past_due: 'warn',
  past_due_trial: 'warn',
  dunning_active: 'warn',
  dunning_final_retry: 'critical',
  dunning_exhausted: 'locked',
};

export function deriveSeverity(noticeState: BillingNoticeState): BillingSeverity {
  return SEVERITY_BY_STATE[noticeState];
}
