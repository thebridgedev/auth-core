import type { BillingLockedPayload } from './types.js';

// Decouples the low-level HTTP layer from the billing singleton: http.ts emits
// a lock signal without importing use-bridge.ts (which would create a cycle),
// and useBridge() registers a handler that flips the live subscription store.

type LockHandler = (payload: BillingLockedPayload) => void;

let handler: LockHandler | null = null;

export function setBillingLockHandler(fn: LockHandler | null): void {
  handler = fn;
}

export function emitBillingLock(payload: BillingLockedPayload): void {
  handler?.(payload);
}
