import type { BillingFacts, BillingStatus } from './billing.js';
import { BridgeError, isBridgeError } from './core/errors.js';
import { DEFAULT_MANAGE_ROUTE } from './quota.js';
import type { Session } from './session.js';

/**
 * Whether the workspace is locked for payment, as the 0.9 plugins told it:
 * `isLocked()`, `gateState()` and `assertNotLocked()`. The lock is Bridge's:
 * a workspace whose billing says `blocked` (the payment provider gave up
 * collecting, the app's server locked it, or its paid plan ended) can be read
 * but not changed. This is for showing and for refusing early; Bridge refuses
 * the write itself too.
 */

export type BillingSeverity = 'info' | 'warn' | 'critical' | 'locked';

/** What a billing notice would say, worked out from the workspace's billing facts. */
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

/** The gate as a screen needs it. */
export interface BillingGateState {
  readonly locked: boolean;
  readonly severity: BillingSeverity;
  readonly noticeState: BillingNoticeState;
  /** Where to send a locked workspace to pay and come back; set only while locked. */
  readonly recoveryUrl?: string;
}

/** What a lock says: the billing status it was found in, and where to recover. */
export interface BillingLockedPayload {
  readonly reason: 'billing_locked';
  readonly billing: {
    readonly status: BillingStatus;
    readonly gateEngaged: boolean;
    readonly recoveryUrl?: string;
  };
}

/**
 * The refusal of a change in a workspace locked for payment (402). Bridge
 * answers a write in such a workspace with `code: 'billing-locked'`; this is
 * also what `assertNotLocked()` throws.
 */
export class BillingLockedError extends BridgeError {
  readonly payload: BillingLockedPayload;
  constructor(payload: BillingLockedPayload) {
    super('plan-required', 'Billing gate engaged — workspace access is locked', { status: 402, code: 'billing-locked' });
    (this as { name: string }).name = 'BillingLockedError';
    this.payload = payload;
  }
}

/** True for a refusal because the workspace is locked for payment: a {@link BillingLockedError} or Bridge's 402 `billing-locked`. */
export function isBillingLocked(error: unknown): boolean {
  return isBridgeError(error) && error.status === 402 && error.code === 'billing-locked';
}

const TRIAL_ENDING_DAYS = 3;

/** The notice state for the workspace's facts; the facts are unknown (null) before the first read. */
export function deriveNoticeState(facts: BillingFacts | null, now = Date.now()): BillingNoticeState {
  if (facts === null) return 'active';
  if (facts.access === 'blocked') return 'dunning_exhausted';
  if (facts.status === 'canceled') return 'canceled';
  if (facts.cancelAtPeriodEnd) return 'cancel_at_period_end';
  if (facts.access === 'payment_due') return facts.status === 'trialing' ? 'past_due_trial' : 'past_due';
  if (facts.status === 'trialing') {
    const daysLeft = facts.trialEnd === null ? undefined : Math.ceil((Date.parse(facts.trialEnd) - now) / 86_400_000);
    return daysLeft !== undefined && daysLeft <= TRIAL_ENDING_DAYS ? 'trial_ending_soon' : 'trial_active';
  }
  return 'active';
}

const SEVERITY: Record<BillingNoticeState, BillingSeverity> = {
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

export function deriveSeverity(state: BillingNoticeState): BillingSeverity {
  return SEVERITY[state];
}

export interface BillingGateDeps {
  /** Reads the workspace's billing facts (`GET /payer`). */
  readonly state: () => Promise<BillingFacts>;
  readonly session: Session;
  readonly onError: (error: unknown) => void;
}

export type GateListener = (state: BillingGateState) => void;

/**
 * Holds the workspace's billing facts for the lock. Fail-closed the way 0.9
 * was: not locked until Bridge says so. Read again when Bridge says billing
 * changed, and dropped when the person or workspace changes.
 */
export class BillingGate {
  private facts: BillingFacts | null = null;
  private counter = 0;
  private shown = '';
  private readonly listeners = new Set<GateListener>();

  constructor(private readonly deps: BillingGateDeps) {}

  private contextNow(): string | null {
    const state = this.deps.session.state.get();
    if (state.status !== 'signed-in' || state.workspace === null) return null;
    return `${state.user.id}:${state.workspace.id}:${this.deps.session.sessionId() ?? ''}`;
  }

  /** True when the workspace is locked for payment; false until that is known. */
  isLocked(): boolean {
    return this.facts?.access === 'blocked';
  }

  gateState(now = Date.now()): BillingGateState {
    const noticeState = deriveNoticeState(this.facts, now);
    const locked = this.isLocked();
    return { locked, severity: deriveSeverity(noticeState), noticeState, ...(locked ? { recoveryUrl: DEFAULT_MANAGE_ROUTE } : {}) };
  }

  /** Throws a {@link BillingLockedError} when the workspace is locked. */
  assertNotLocked(): void {
    if (this.facts === null || !this.isLocked()) return;
    throw new BillingLockedError({ reason: 'billing_locked', billing: { status: this.facts.status, gateEngaged: true, recoveryUrl: DEFAULT_MANAGE_ROUTE } });
  }

  /** Called with the gate whenever it changes. Returns how to stop. */
  subscribe(listener: GateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads the facts now. A failed read keeps what is held and is reported, except a person who may not read billing, which leaves the gate open. */
  async refresh(renewed = false): Promise<void> {
    const context = this.contextNow();
    if (context === null) return;
    const mine = ++this.counter;
    try {
      const facts = await this.deps.state();
      if (mine !== this.counter || context !== this.contextNow()) return;
      this.facts = facts;
      this.announce();
    } catch (error) {
      if (mine !== this.counter) return;
      if (isBridgeError(error, 'signed-out') && !renewed && this.deps.session.state.get().status === 'signed-in') {
        // A token from before a change of plan is refused once Bridge has saved the change: renew it once and ask again.
        try {
          await this.deps.session.refresh({ force: true });
        } catch {
          return;
        }
        return this.refresh(true);
      }
      if (isBridgeError(error, 'forbidden')) return;
      this.deps.onError(error);
    }
  }

  /** Drops what is held, for another person or workspace, and reads again once someone is signed in. */
  reset(): void {
    this.counter += 1;
    this.facts = null;
    this.announce();
    if (this.contextNow() !== null) void this.refresh();
  }

  private announce(): void {
    const state = this.gateState();
    const key = JSON.stringify({ ...state });
    if (key === this.shown) return;
    this.shown = key;
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch {
        // A listener's own error is its own.
      }
    }
  }
}
