import { isBridgeError, type BridgeError, type LimitReached } from './core/errors.js';

/**
 * A plan limit as the app shows it: what is used of a metric, and the limit.
 * The same shape the 0.9 plugins read, so a screen written against it keeps
 * working.
 */
export interface QuotaSnapshot {
  readonly metric: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  /** `used / limit`; 0 when the limit is 0. */
  readonly percent_used: number;
  /** `hard` refuses past the limit; `metered` allows it and bills the overage. */
  readonly policy: 'hard' | 'metered';
  /** `counter`: this period's total, reset each period. `gauge`: how many exist now. */
  readonly kind?: 'counter' | 'gauge';
  /** `membership`: a gauge Bridge counts from the workspace's members (seats). */
  readonly source?: 'membership';
  readonly warningLevel: null | 'approaching' | 'critical';
  /** The metric's name; a screen may show its own wording instead. */
  readonly label: string;
  /** A metered limit's price per unit, in whole currency units. */
  readonly unitAmount?: number;
  readonly currency?: string;
  /** A metered limit's estimated overage this period, in `currency` units. */
  readonly overageEstimate?: number;
  /** True once use has passed the limit. */
  readonly overcap?: boolean;
}

/** What Bridge answers when asked for a metric's quota. */
export interface QuotaRead {
  readonly metric: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly warningLevel?: null | 'approaching' | 'critical';
  readonly policy?: 'hard' | 'metered';
  readonly kind?: 'counter' | 'gauge';
  readonly source?: 'membership';
  readonly unitAmount?: number;
  readonly currency?: string;
  readonly overageEstimate?: number;
  readonly overcap?: boolean;
}

/** The snapshot for what Bridge answered, or undefined when the plan sets no limit on the metric. */
export function snapshotOf(metric: string, read: QuotaRead | null | undefined): QuotaSnapshot | undefined {
  if (read === null || read === undefined || typeof read !== 'object') return undefined;
  const { used, limit } = read;
  return {
    metric,
    used,
    limit,
    remaining: read.remaining,
    percent_used: limit > 0 ? used / limit : 0,
    policy: read.policy === 'hard' ? 'hard' : 'metered',
    kind: read.kind === 'gauge' ? 'gauge' : 'counter',
    ...(read.source === 'membership' ? { source: 'membership' as const } : {}),
    warningLevel: read.warningLevel ?? null,
    label: metric,
    ...(read.unitAmount === undefined ? {} : { unitAmount: read.unitAmount }),
    ...(read.currency === undefined ? {} : { currency: read.currency }),
    ...(read.overageEstimate === undefined ? {} : { overageEstimate: read.overageEstimate }),
    overcap: read.overcap ?? used > limit,
  };
}

/** The body a request at its plan limit is refused with (402), as the 0.9 plugins answer it. */
export interface QuotaExceededBody {
  readonly statusCode: 402;
  readonly code: 'QUOTA_EXCEEDED';
  readonly message: string;
  readonly metric: string;
  readonly used: number;
  readonly limit: number;
  /** Where to upgrade. */
  readonly fix: string;
}

/** Where `fix` points when none is given. */
export const DEFAULT_MANAGE_ROUTE = '/subscription';

/** Whether an error is Bridge refusing a hold because the plan's limit is reached. */
export function isLimitReached(error: unknown): error is BridgeError & { readonly quota: LimitReached } {
  return isBridgeError(error) && error.status === 402 && error.quota !== null;
}

/**
 * The 402 `QUOTA_EXCEEDED` body for a refused hold (or for a metric, used and
 * limit you already know), in the shape the 0.9 plugins answered with, so a
 * page's upgrade dialog reads it unchanged.
 */
export function quotaExceededBody(from: BridgeError | LimitReached, fix: string = DEFAULT_MANAGE_ROUTE): QuotaExceededBody {
  const reached = 'quota' in from ? from.quota : from;
  if (reached === null) throw new TypeError('This error is not a plan limit being reached.');
  return {
    statusCode: 402,
    code: 'QUOTA_EXCEEDED',
    message: `Your plan allows ${String(reached.limit)} ${reached.metric}; ${String(reached.used)} are in use.`,
    metric: reached.metric,
    used: reached.used,
    limit: reached.limit,
    fix,
  };
}

/**
 * Entitlements are flags: a plan feature `key` is the flag
 * `bridge:billing.entitlement.<key>`, whose rule Bridge keeps. Nothing reads
 * the plan itself.
 */
export const ENTITLEMENT_FLAG_PREFIX = 'bridge:billing.entitlement.';

/** The flag that says whether the workspace's plan includes the feature `key`. */
export function entitlementFlag(key: string): string {
  return `${ENTITLEMENT_FLAG_PREFIX}${key}`;
}
