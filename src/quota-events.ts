import type { QuotaSnapshot } from './quota.js';
import type { QuotaStore } from './quota-store.js';

/**
 * What a `quota.updated` handler receives: the shape the 0.9 plugins passed.
 * Bridge's notice carries no numbers, so the numbers are the quota read again
 * just before the handler runs.
 */
export interface QuotaUpdatedMessage {
  readonly kind: 'quota.updated';
  /** The workspace the numbers are for. */
  readonly tenantId: string;
  readonly appId?: string;
  readonly effectiveAt: string;
  readonly metric: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly warningLevel: null | 'approaching' | 'critical';
  readonly policy?: 'hard' | 'metered';
  readonly unitAmount?: number;
  readonly currency?: string;
  readonly overageEstimate?: number;
  readonly overcap?: boolean;
}

export interface BillingEventHandlers {
  /** A metric's numbers changed, told by Bridge's `billing.quota_updated` notice. Runs once per metric that changed. */
  'quota.updated'?: (message: QuotaUpdatedMessage) => void;
}

export function messageOf(snapshot: QuotaSnapshot, tenantId: string, now = new Date()): QuotaUpdatedMessage {
  return {
    kind: 'quota.updated',
    tenantId,
    effectiveAt: now.toISOString(),
    metric: snapshot.metric,
    used: snapshot.used,
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    warningLevel: snapshot.warningLevel,
    policy: snapshot.policy,
    ...(snapshot.unitAmount === undefined ? {} : { unitAmount: snapshot.unitAmount }),
    ...(snapshot.currency === undefined ? {} : { currency: snapshot.currency }),
    ...(snapshot.overageEstimate === undefined ? {} : { overageEstimate: snapshot.overageEstimate }),
    ...(snapshot.overcap === undefined ? {} : { overcap: snapshot.overcap }),
  };
}

/**
 * Runs `handle({'quota.updated': fn})` handlers. On a `billing.quota_updated`
 * notice every metric a screen asked for is read again, and each one whose
 * numbers differ from what was held is passed to the handlers, once. A
 * metric read for the first time is not an update.
 */
export class QuotaEvents {
  private readonly handlers = new Set<BillingEventHandlers>();
  private readonly seen = new Map<string, string>();
  private listening = 0;

  constructor(
    private readonly quotas: QuotaStore,
    private readonly tenant: () => string,
  ) {
    quotas.subscribe((metric, snapshot) => {
      if (snapshot === undefined) {
        this.seen.delete(metric);
        return;
      }
      const key = JSON.stringify(snapshot);
      const before = this.seen.get(metric);
      this.seen.set(metric, key);
      if (this.listening === 0 || before === undefined || before === key) return;
      this.fire(messageOf(snapshot, this.tenant()));
    });
  }

  /** Registers handlers; returns how to remove them. */
  handle(handlers: BillingEventHandlers): () => void {
    this.handlers.add(handlers);
    return () => {
      this.handlers.delete(handlers);
    };
  }

  /** A `billing.quota_updated` notice arrived: read the quotas again and tell the handlers what changed. */
  async noticed(): Promise<void> {
    this.listening += 1;
    try {
      await this.quotas.refresh();
    } finally {
      this.listening -= 1;
    }
  }

  private fire(message: QuotaUpdatedMessage): void {
    for (const each of [...this.handlers]) {
      const fn = each['quota.updated'];
      if (fn === undefined) continue;
      try {
        fn(message);
      } catch {
        // A handler's own error does not affect the client.
      }
    }
  }
}
