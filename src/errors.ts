import type { BillingLockedPayload } from './billing/types.js';

export class BridgeAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BridgeAuthError';
  }
}

export class HttpError extends BridgeAuthError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message, `HTTP_${status}`);
    this.name = 'HttpError';
  }
}

/**
 * Thrown when a Bridge API call returns a billing-locked 402. Carries the
 * canonical payload so callers (and the gate UI) can read status + recoveryUrl.
 * Isomorphic — fires on both client and server SDK calls.
 */
export class BillingLockedError extends BridgeAuthError {
  readonly status = 402;
  constructor(public readonly payload: BillingLockedPayload) {
    super('Billing gate engaged — workspace access is locked', 'BILLING_GATE_ENGAGED');
    this.name = 'BillingLockedError';
  }
}
