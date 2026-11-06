import type { Endpoints } from './core/discovery.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES, type Route } from './core/routes.js';
import type { Session } from './session.js';

/**
 * Billing for the signed-in person's workspace: the plans on offer, the
 * workspace's billing facts, checkout and the billing portal.
 *
 * The facts are for showing (the plan's name, a trial's end, a limit and
 * what is used of it). They are never a gate: whether a page or button is
 * open is a flag, whose rule can name a plan feature. Whether the person may
 * manage billing is a flag too (by default `bridge-billing-manage`).
 */

export interface Price {
  readonly currency: string;
  readonly interval?: string | null;
  readonly amount: number;
  readonly [field: string]: unknown;
}

export interface Plan {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly archived: boolean;
  readonly prices: readonly Price[];
  readonly features: readonly string[] | Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, number | null>>;
  readonly trial: unknown;
  readonly free: boolean;
  readonly [field: string]: unknown;
}

export type BillingStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';
/** Whether the workspace can be used: `ok`, needs a plan, has a payment due, or is blocked. */
export type BillingAccess = 'ok' | 'needs_plan' | 'payment_due' | 'blocked';

export interface BillingFacts {
  readonly plan: { readonly key: string; readonly name: string } | null;
  readonly status: BillingStatus;
  readonly access: BillingAccess;
  readonly limits: Readonly<Record<string, number | null>>;
  readonly usage: Readonly<Record<string, number>>;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly trialEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly waiting: { readonly plan: string; readonly waitsFor: 'period_end' | 'payment'; readonly at: string | null } | null;
  readonly locked: boolean;
  readonly [field: string]: unknown;
}

export interface UsageNumbers {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly metrics: readonly { readonly metric: string; readonly used: number; readonly limit: number | null }[];
}

/** What choosing a plan came to: done (or scheduled), or a checkout to send the person to. */
export type PlanChange =
  | { readonly status: 'changed' | 'scheduled' | 'waiting_for_payment' }
  | { readonly status: 'payment_required'; readonly checkout: { readonly session: string; readonly url: string } };

/** A notice to show about the workspace's billing, worked out from its facts. */
export type BillingNotice =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'payment-due' }
  | { readonly kind: 'needs-plan' }
  | { readonly kind: 'trial-ending'; readonly trialEnd: string; readonly daysLeft: number }
  | { readonly kind: 'ending'; readonly periodEnd: string | null }
  | { readonly kind: 'waiting'; readonly plan: string; readonly waitsFor: 'period_end' | 'payment' };

/** A trial ending within this many days gets a notice. */
const TRIAL_NOTICE_DAYS = 7;

/** The one notice worth showing now, the most urgent first, or null. */
export function billingNotice(facts: BillingFacts, now = Date.now()): BillingNotice | null {
  if (facts.access === 'blocked') return { kind: 'blocked' };
  if (facts.access === 'payment_due') return { kind: 'payment-due' };
  if (facts.access === 'needs_plan') return { kind: 'needs-plan' };
  if (facts.status === 'trialing' && facts.trialEnd !== null) {
    const daysLeft = Math.ceil((Date.parse(facts.trialEnd) - now) / 86_400_000);
    if (daysLeft <= TRIAL_NOTICE_DAYS) return { kind: 'trial-ending', trialEnd: facts.trialEnd, daysLeft: Math.max(0, daysLeft) };
  }
  if (facts.cancelAtPeriodEnd) return { kind: 'ending', periodEnd: facts.periodEnd };
  if (facts.waiting !== null) return { kind: 'waiting', plan: facts.waiting.plan, waitsFor: facts.waiting.waitsFor };
  return null;
}

/**
 * Reads a return from checkout from the page's address: the checkout
 * session to confirm, or null when the address is not one.
 */
export function readCheckoutReturn(url: string): { readonly session: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const session = parsed.searchParams.get('session_id');
  return session !== null && /^[A-Za-z0-9_-]{1,255}$/.test(session) ? { session } : null;
}

export interface BillingDeps {
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly session: Session;
  /** Called after anything that may change the facts, so flags whose rules read the plan are fetched again. */
  readonly changed: () => void;
}

export function createBilling(deps: BillingDeps) {
  async function send<T>(route: Route, options: { params?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const token = await deps.session.accessToken();
    return (await call<T>(deps.fetch, deps.endpoints().url(route, options.params), { method: route.method, token, ...(options.body === undefined ? {} : { body: options.body }) })).body;
  }
  async function changing<T>(work: Promise<T>): Promise<T> {
    const result = await work;
    deps.changed();
    return result;
  }

  return {
    /** The plans on offer. */
    plans: () => send<Plan[]>(ROUTES.plans),
    /** The workspace's billing facts. */
    state: () => send<BillingFacts>(ROUTES.payer),
    /** This period's usage of each metric, with its limit. */
    usage: () => send<UsageNumbers>(ROUTES.payerUsage),
    /**
     * Chooses or changes the plan. A paid plan without a payment method
     * answers `payment_required` with a checkout: send the person to its
     * `url`, and confirm the session when they come back.
     */
    choosePlan: (choice: { readonly plan: string; readonly currency?: string; readonly interval?: string }) => changing(send<PlanChange>(ROUTES.payerPlan, { body: choice })),
    /** Confirms a checkout the person came back from (see `readCheckoutReturn`). */
    confirmCheckout: (session: string) => changing(send<BillingFacts>(ROUTES.checkoutConfirm, { params: { session } })),
    /** The billing portal's address, to send the person to. */
    portal: () => send<{ url: string }>(ROUTES.portal),
    startTrial: (plan: string) => changing(send<BillingFacts>(ROUTES.payerTrial, { body: { plan } })),
    cancel: () => changing(send<BillingFacts>(ROUTES.payerCancel)),
    reactivate: () => changing(send<BillingFacts>(ROUTES.payerReactivate)),
    /** Asks Bridge to read the subscription from the payment provider again. */
    refresh: () => changing(send<BillingFacts>(ROUTES.payerRefresh)),
  };
}
