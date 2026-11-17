import type { BillingGateFacts } from './billing.js';
import { BillingLockedError, errorFromAnswer, isBillingLocked, isBridgeError } from './core/errors.js';
export { BillingLockedError, isBillingLocked };
export type { BillingLockedPayload } from './core/errors.js';
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

const TRIAL_ENDING_DAYS = 3;

/** The notice state for the workspace's facts; the facts are unknown (null) before the first read. */
export function deriveNoticeState(facts: BillingGateFacts | null, now = Date.now()): BillingNoticeState {
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

/**
 * A fetch that tells `locked` when an answer is Bridge's (or the Child App's own) 402 for a workspace locked for payment,
 * and hands the answer on untouched. This is how a caught lock shows without a read, as in 0.9.
 */
export function watchLock(fetchFn: typeof fetch, locked: (status: BillingGateFacts['status'] | undefined) => void): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetchFn(input, init);
    if (response.status === 402) {
      try {
        const body: unknown = JSON.parse(await response.clone().text());
        const error = errorFromAnswer(402, body);
        if (isBillingLocked(error)) locked(error instanceof BillingLockedError ? error.payload.billing.status : undefined);
      } catch {
        // Not a JSON answer, or not a lock: nothing to tell.
      }
    }
    return response;
  }) as typeof fetch;
}

export interface BillingGateDeps {
  /** Reads whether the workspace is locked, and why (`GET /payer/gate`): open to every person of the workspace. */
  readonly state: () => Promise<BillingGateFacts>;
  readonly session: Session;
  readonly onError: (error: unknown) => void;
}

export type GateListener = (state: BillingGateState) => void;

/**
 * Holds whether the workspace is locked, from the read every person of it may make. Fail-closed the way 0.9
 * was: not locked until Bridge says so. Read again when Bridge says billing
 * changed, and dropped when the person or workspace changes.
 */
export class BillingGate {
  private facts: BillingGateFacts | null = null;
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

  /**
   * A Bridge answer or the Child App's own refused a change with 402 because the workspace is locked for payment: show the
   * lock now, as 0.9 did, without waiting for the next read. The next read of the gate (Bridge's own notice of a change)
   * says whether it still holds. `status` is the billing status the refusal named, when it did.
   */
  markLocked(status?: BillingGateFacts['status']): void {
    if (this.contextNow() === null) return;
    // A read already on its way began before the refusal: its answer is older and must not unlock what was just locked.
    this.counter += 1;
    this.facts = { locked: true, access: 'blocked', status: status ?? this.facts?.status ?? 'past_due', cancelAtPeriodEnd: this.facts?.cancelAtPeriodEnd ?? false, trialEnd: this.facts?.trialEnd ?? null };
    this.announce();
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

  /** Reads the gate now. A failed read keeps what is held and is reported. */
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
