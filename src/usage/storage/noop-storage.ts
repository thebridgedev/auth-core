// Billing 2.0 US-19 (TBP-270) — In-memory `DurableStorage` impl.
//
// Used as a fallback when neither browser nor Node env is detected (SSR
// edge runtimes, sandboxed iframes with IndexedDB disabled, etc.). NOT
// durable across process crashes — but matches the API surface so the
// UsageReporter doesn't need to branch.

import {
  DEFAULT_MAX_SIZE,
  type DurableStorage,
  type DurableStorageOptions,
  type QueuedEvent,
} from './durable-storage.js';

export class InMemoryStorage implements DurableStorage {
  private readonly map = new Map<string, QueuedEvent>();
  private maxSize: number;

  constructor(opts: DurableStorageOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  }

  async enqueue(event: QueuedEvent): Promise<void> {
    this.map.set(event.idempotencyKey, event);
    this._enforceMaxSize();
  }

  async peek(limit: number): Promise<QueuedEvent[]> {
    // Iteration order on Map is insertion order, which matches enqueuedAt for
    // typical use. We still sort defensively in case `enqueue` was called with
    // historical timestamps (e.g. hydrated-from-elsewhere).
    const all = Array.from(this.map.values()).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    return all.slice(0, Math.max(0, limit));
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.map.delete(k);
  }

  async markRetry(key: string, error: string): Promise<void> {
    const existing = this.map.get(key);
    if (!existing) return;
    existing.retryCount += 1;
    existing.lastError = error;
  }

  async size(): Promise<number> {
    return this.map.size;
  }

  configure(opts: { maxSize?: number }): void {
    if (typeof opts.maxSize === 'number' && opts.maxSize > 0) {
      this.maxSize = opts.maxSize;
      this._enforceMaxSize();
    }
  }

  async close(): Promise<void> {
    // no-op
  }

  private _enforceMaxSize(): void {
    while (this.map.size > this.maxSize) {
      // Drop oldest by enqueuedAt
      let oldestKey: string | undefined;
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const ev of this.map.values()) {
        if (ev.enqueuedAt < oldestTs) {
          oldestTs = ev.enqueuedAt;
          oldestKey = ev.idempotencyKey;
        }
      }
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
      // eslint-disable-next-line no-console
      console.warn(
        `[bridge-usage] queue at max-size (${this.maxSize}); dropping oldest event`,
      );
    }
  }
}
