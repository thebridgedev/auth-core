// Billing 2.0 US-10 (TBP-262) + US-19 (TBP-270) — SDK usage reporter with
// durable, crash-safe queue.
//
// `bridge.usage.report(metric, value?, idempotencyKey?)` enqueues a usage
// event for the workspace and the SDK fire-and-forgets it to bridge-api's
// `/usage/ingest` endpoint. The server's idempotency-key dedupe makes safe
// retries acceptable.
//
// US-19 adds a `DurableStorage` layer underneath the in-memory hot path:
//   - browser: IndexedDB-backed queue
//   - Node:    JSONL on disk under ~/.bridge/usage-queue/
//   - else:    in-memory fallback
//
// Zero-loss bar: every event accepted into `report()` is persisted via
// `storage.enqueue()` (fire-and-forget — non-blocking). On crash/restart the
// next UsageReporter construction sees `storage.size() > 0` and triggers an
// immediate replay flush. Idempotency keys are generated AT ENQUEUE TIME and
// persisted as part of the QueuedEvent — replays send the exact same key so
// the server dedupes duplicate deliveries.
//
// Framework-agnostic: uses global `fetch`, `setTimeout`, and `crypto.randomUUID`.
// Constructed lazily by `BridgeAuth` on first access of `bridge.usage`.

import {
  createDurableStorage,
  type DurableStorage,
  type QueuedEvent,
} from './storage/index.js';

export interface UsageReporterOptions {
  /** Bridge API base URL (e.g. https://api.thebridge.dev or http://localhost:3500). */
  apiBaseUrl: string;
  /** Accessor for the current user's access token. Returns null when unauthenticated. */
  getAccessToken: () => string | null;
  /** Optional logger. Defaults to a `console`-shaped stub that warns on failures. */
  logger?: { warn(...args: unknown[]): void };
  /** Maximum events drained per flush. Default 10. */
  batchSize?: number;
  /** Debounce window before flushing the queue. Default 1000ms. */
  flushIntervalMs?: number;
  /** Optional fetch override — primarily for tests. */
  fetchFn?: typeof fetch;
  /**
   * Durable storage backend. Defaults to `createDurableStorage()` which
   * auto-detects browser / Node / fallback. Tests can inject `InMemoryStorage`.
   */
  storage?: DurableStorage;
}

export interface QueueStatus {
  /** Current queue depth (events awaiting flush). */
  queueDepth: number;
  /** Sum of retryCount across all queued events. */
  retryCount: number;
  /** Unix ms of the last flush attempt (success or failure). Null if never flushed. */
  lastFlushTimestamp: number | null;
  /** Last error message recorded during a flush, or null if last flush was clean. */
  lastFlushError: string | null;
}

const noopWarn = (..._args: unknown[]): void => {};

export class UsageReporter {
  private readonly apiBaseUrl: string;
  private readonly getAccessToken: () => string | null;
  private readonly logger: { warn(...args: unknown[]): void };
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly storage: DurableStorage;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private anonDropWarned = false;

  // Observability state — surfaced via getQueueStatus().
  private _lastFlushTimestamp: number | null = null;
  private _lastFlushError: string | null = null;

  constructor(opts: UsageReporterOptions) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.logger = opts.logger ?? { warn: noopWarn };
    this.batchSize = opts.batchSize ?? 10;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.fetchFn = opts.fetchFn ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.storage = opts.storage ?? createDurableStorage();

    // Hydrate on init: if storage carries unsent events from a previous
    // session, schedule an immediate replay flush (no debounce).
    void this._maybeHydrate();
  }

  /**
   * Enqueue a usage event. Non-blocking — schedules a debounced flush.
   * `idempotencyKey` is auto-generated via `crypto.randomUUID()` when omitted
   * and persisted with the event so crash/restart replays use the SAME key.
   */
  public report(metric: string, value: number = 1, idempotencyKey?: string): void {
    if (this.stopped) return;
    if (typeof metric !== 'string' || metric.length === 0) return;
    // Anonymous sessions are dropped at the door: /usage/ingest derives the
    // billed workspace from the JWT, so a tokenless event can never ingest —
    // and buffering it until a later login would mis-attribute it to whatever
    // workspace that user lands in. (TBP-398)
    if (this.getAccessToken() === null) {
      if (!this.anonDropWarned) {
        this.anonDropWarned = true;
        this.logger.warn(
          '[bridge.usage] dropping usage events from an unauthenticated session — usage is billed per workspace and requires a logged-in user',
        );
      }
      return;
    }
    const key = idempotencyKey ?? generateIdempotencyKey();
    const event: QueuedEvent = {
      metric,
      value,
      idempotencyKey: key,
      enqueuedAt: Date.now(),
      retryCount: 0,
    };
    // Fire-and-forget: preserve non-blocking semantics of report().
    void this.storage.enqueue(event).catch((err) => {
      this.logger.warn('[bridge.usage] storage.enqueue failed', err);
    });
    this._scheduleFlush();
  }

  /** Force an immediate drain of the queue. Resolves once all in-flight POSTs settle. */
  public async flushNow(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this._flush();
  }

  /** Read-only queue observability — for dev-facing monitoring. */
  public async getQueueStatus(): Promise<QueueStatus> {
    const events = await this.storage.peek(Number.MAX_SAFE_INTEGER).catch(() => [] as QueuedEvent[]);
    const queueDepth = events.length;
    const retryCount = events.reduce((sum, e) => sum + (e.retryCount ?? 0), 0);
    return {
      queueDepth,
      retryCount,
      lastFlushTimestamp: this._lastFlushTimestamp,
      lastFlushError: this._lastFlushError,
    };
  }

  /** Cancel pending timer and drain. Idempotent — safe to call multiple times. */
  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Fire-and-forget final flush, then close storage. We don't await because
    // shutdown() is synchronous; callers that need to await should call
    // flushNow() first.
    void this._flush().finally(() => {
      void this.storage.close?.();
    });
  }

  private async _maybeHydrate(): Promise<void> {
    try {
      const depth = await this.storage.size();
      if (depth > 0 && !this.stopped) {
        // Immediate flush — no debounce — to replay survived events.
        void this._flush();
      }
    } catch (err) {
      this.logger.warn('[bridge.usage] hydrate check failed', err);
    }
  }

  private _scheduleFlush(): void {
    if (this.timer !== undefined) return;
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this._flush();
    }, this.flushIntervalMs);
  }

  private async _flush(): Promise<void> {
    // Serialize concurrent flushes — peek/remove must not race.
    if (this.flushing) return this.flushing;
    this.flushing = this._flushInner().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async _flushInner(): Promise<void> {
    let batch: QueuedEvent[];
    try {
      batch = await this.storage.peek(this.batchSize);
    } catch (err) {
      this.logger.warn('[bridge.usage] storage.peek failed', err);
      return;
    }
    if (batch.length === 0) return;

    this._lastFlushTimestamp = Date.now();

    if (!this.fetchFn) {
      const msg = 'fetch is not available in this environment';
      this.logger.warn(`[bridge.usage] ${msg}`);
      this._lastFlushError = msg;
      // Mark retries so getQueueStatus surfaces the problem; don't drop —
      // a different host may carry the same storage forward later.
      for (const event of batch) {
        await this.storage.markRetry(event.idempotencyKey, msg).catch(() => undefined);
      }
      return;
    }

    const token = this.getAccessToken();
    if (token === null) {
      // No token, no attempt: a tokenless POST is a guaranteed 401 and the
      // retry machinery would hot-loop it (~1 Hz) forever. The queue is left
      // intact — these are events enqueued WHILE authenticated whose token
      // expired before the flush; they drain after the next refresh/login.
      // (Anonymous events never reach the queue — see report().) (TBP-398)
      return;
    }
    const url = `${this.apiBaseUrl}/usage/ingest`;
    const succeeded: string[] = [];
    const failures: Array<{ key: string; error: string }> = [];

    await Promise.all(
      batch.map(async (event) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };
          const res = await this.fetchFn(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              metric: event.metric,
              value: event.value,
              idempotencyKey: event.idempotencyKey,
            }),
          });
          if (!res.ok) {
            const msg = `ingest failed (${res.status}) for metric=${event.metric}`;
            this.logger.warn(`[bridge.usage] ${msg}`);
            failures.push({ key: event.idempotencyKey, error: `HTTP ${res.status}` });
            return;
          }
          succeeded.push(event.idempotencyKey);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn('[bridge.usage] ingest error', err);
          failures.push({ key: event.idempotencyKey, error: msg });
        }
      }),
    );

    if (succeeded.length > 0) {
      try {
        await this.storage.remove(succeeded);
      } catch (err) {
        // If we can't remove acknowledged events, the server's dedupe will
        // still reject the next replay — log and move on.
        this.logger.warn('[bridge.usage] storage.remove failed', err);
      }
    }
    for (const { key, error } of failures) {
      await this.storage.markRetry(key, error).catch(() => undefined);
    }

    this._lastFlushError = failures.length > 0 ? failures[failures.length - 1].error : null;

    // If items remain (more than batchSize were queued or some failed),
    // schedule another flush. Failures will be retried on the next pass.
    if (!this.stopped) {
      const remaining = await this.storage.size().catch(() => 0);
      if (remaining > 0) this._scheduleFlush();
    }
  }
}

function generateIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through to manual generator
    }
  }
  // RFC4122-ish fallback for environments without crypto.randomUUID.
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rnd()}-${rnd().slice(0, 4)}-4${rnd().slice(1, 4)}-a${rnd().slice(1, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}
