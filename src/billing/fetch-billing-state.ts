import { httpFetch } from '../http.js';
import type { Logger } from '../logger.js';
import type { BillingSubscriptionState, MountOptions } from './types.js';

const noopLogger: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Pure, isomorphic read of `GET /billing/state`. No store, no realtime — server
 * plugins (bridge-nextjs) call this directly; the client store's `mount()` wraps
 * it. A billing-locked workspace throws `BillingLockedError` via the http chokepoint.
 */
export async function fetchBillingState(
  opts: MountOptions,
  logger: Logger = noopLogger,
): Promise<BillingSubscriptionState> {
  const url = `${opts.apiBaseUrl}/billing/state`;
  return httpFetch<BillingSubscriptionState>(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'x-app-id': opts.appId,
      },
    },
    logger,
  );
}
