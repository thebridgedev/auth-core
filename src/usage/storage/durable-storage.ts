// Billing 2.0 US-19 (TBP-270) — Durable storage abstraction for the usage queue.
//
// The UsageReporter writes events through a `DurableStorage` implementation so
// they survive process crashes. Three impls are provided:
//   - `IndexedDBStorage` (browser)
//   - `NodeFsStorage` (Node — JSONL on disk)
//   - `InMemoryStorage` (SSR / edge / unknown env)
//
// Idempotency-key stability is a hard invariant: the `idempotencyKey` field on
// a `QueuedEvent` is generated at ENQUEUE time and persisted. Crash/restart
// must replay the exact same key so the server's dedupe layer rejects dupes.
// Implementations must never regenerate keys on read.
//
// Over-cap behavior: when `size()` reaches the configured max, the oldest
// event (by `enqueuedAt`) is dropped and a warning is logged. This is a
// last-resort safety valve — it should rarely fire in practice.

export interface QueuedEvent {
  /** Metric name (e.g. `messages.sent`). */
  metric: string;
  /** Numeric value associated with the metric (default 1). */
  value: number;
  /**
   * Idempotency key. Generated at ENQUEUE TIME, persisted with the event, and
   * sent to the server unchanged. Must remain stable across crash/restart so
   * the server's dedupe rejects duplicate replays.
   */
  idempotencyKey: string;
  /** Unix ms when the event was enqueued (used for over-cap "drop oldest"). */
  enqueuedAt: number;
  /** Number of failed flush attempts for this event. */
  retryCount: number;
  /** Last error message recorded on a failed flush attempt, if any. */
  lastError?: string;
}

export interface DurableStorage {
  /** Persist an event. Idempotency-key collisions overwrite (rare; same key = same logical event). */
  enqueue(event: QueuedEvent): Promise<void>;
  /** Read up to `limit` events without removing them. Oldest first. */
  peek(limit: number): Promise<QueuedEvent[]>;
  /** Remove events by idempotencyKey (called after a successful POST). */
  remove(keys: string[]): Promise<void>;
  /** Increment retryCount and record `lastError` for the given event. */
  markRetry(key: string, error: string): Promise<void>;
  /** Current queue depth. */
  size(): Promise<number>;
  /** Optional: configure runtime options post-construction. */
  configure?(opts: { maxSize?: number }): void;
  /** Optional: release any open handles. */
  close?(): Promise<void>;
}

export interface DurableStorageOptions {
  /** Max in-queue events. Over-cap drops oldest. Default 10000. */
  maxSize?: number;
  /** Node-only: directory for the queue file. Default `~/.bridge/usage-queue/`. */
  nodeDir?: string;
}

export const DEFAULT_MAX_SIZE = 10000;

/** Env detection — exported so the factory + impls can share. */
export function isBrowserEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
  );
}

export function isNodeEnv(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc !== 'undefined' && typeof proc.versions?.node === 'string';
}
