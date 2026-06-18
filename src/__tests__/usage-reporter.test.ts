import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsageReporter } from '../usage/usage-reporter.js';
import { InMemoryStorage } from '../usage/storage/index.js';

// ---------------------------------------------------------------------------
// Billing 2.0 — Phase C / US-10 (TBP-262)
// SDK usage-reporter unit tests. We inject a `fetchFn` mock so the reporter
// never hits the network. Fake timers control the debounce window.
//
// US-19 (TBP-270) — the reporter now persists events through a `DurableStorage`
// backend (NodeFsStorage in Node by default). We inject `InMemoryStorage` per
// test so each test starts with a clean queue and the storage ops resolve
// synchronously-enough to play nicely with vitest fake timers.
// ---------------------------------------------------------------------------

function makeReporter(opts: {
  fetchFn?: ReturnType<typeof vi.fn>;
  batchSize?: number;
  flushIntervalMs?: number;
  getAccessToken?: () => string | null;
  storage?: InMemoryStorage;
} = {}) {
  const fetchFn = opts.fetchFn ?? vi.fn().mockResolvedValue({ ok: true, status: 201 });
  const logger = { warn: vi.fn() };
  const storage = opts.storage ?? new InMemoryStorage();
  const reporter = new UsageReporter({
    apiBaseUrl: 'https://api.example.com',
    getAccessToken: opts.getAccessToken ?? (() => 'access-tok'),
    logger,
    batchSize: opts.batchSize ?? 10,
    flushIntervalMs: opts.flushIntervalMs ?? 1000,
    fetchFn,
    storage,
  });
  return { reporter, fetchFn, logger, storage };
}

describe('UsageReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // report() — non-blocking enqueue
  // -------------------------------------------------------------------------
  describe('report()', () => {
    it('returns synchronously without awaiting any flush', () => {
      const { reporter, fetchFn } = makeReporter();
      // No throw, no await — the call is intentionally sync.
      const result = reporter.report('ai_completions', 1);
      expect(result).toBeUndefined();
      // Fetch hasn't fired yet — debounce window is still open.
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('ignores empty or non-string metric values', () => {
      const { reporter, fetchFn } = makeReporter();
      // Should silently no-op (no enqueue, no throw).
      reporter.report('', 1);
      // @ts-expect-error — deliberately wrong type
      reporter.report(undefined, 1);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Debounced flush
  // -------------------------------------------------------------------------
  describe('debounced flush', () => {
    it('flushes after flushIntervalMs (1000ms) elapses', async () => {
      const { reporter, fetchFn } = makeReporter();
      reporter.report('ai_completions', 1);

      // Window not elapsed yet.
      expect(fetchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://api.example.com/usage/ingest');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers.Authorization).toBe('Bearer access-tok');
      const body = JSON.parse(init.body);
      expect(body.metric).toBe('ai_completions');
      expect(body.value).toBe(1);
      expect(body.idempotencyKey).toBeDefined();
      expect(typeof body.idempotencyKey).toBe('string');
    });

    it('drains the queue across multiple flushes when more than batchSize is queued', async () => {
      const { reporter, fetchFn } = makeReporter({ batchSize: 2 });
      reporter.report('ai_completions', 1);
      reporter.report('ai_completions', 1);
      reporter.report('ai_completions', 1);

      // First flush fires after the debounce — drains batchSize=2.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(2);

      // The remaining item triggers a second debounced flush.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Fire-and-forget on failure
  // -------------------------------------------------------------------------
  describe('fire-and-forget on failure', () => {
    it('does not throw when the POST returns non-2xx; logs at warn', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const { reporter, logger } = makeReporter({ fetchFn });

      reporter.report('ai_completions', 1);
      await vi.advanceTimersByTimeAsync(1000);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      // No throw bubbled out of the debounced flush.
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not throw when fetch itself rejects; logs at warn', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
      const { reporter, logger } = makeReporter({ fetchFn });

      reporter.report('ai_completions', 1);
      await vi.advanceTimersByTimeAsync(1000);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // flushNow()
  // -------------------------------------------------------------------------
  describe('flushNow()', () => {
    it('flushes the queue immediately (no need to wait the debounce window)', async () => {
      const { reporter, fetchFn } = makeReporter();
      reporter.report('ai_completions', 1);

      expect(fetchFn).not.toHaveBeenCalled();

      await reporter.flushNow();

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on an empty queue', async () => {
      const { reporter, fetchFn } = makeReporter();
      await reporter.flushNow();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // shutdown()
  // -------------------------------------------------------------------------
  describe('shutdown()', () => {
    it('cancels the pending debounce timer and performs a final flush', async () => {
      const { reporter, fetchFn } = makeReporter();
      reporter.report('ai_completions', 1);

      // shutdown() schedules a final void _flush internally.
      reporter.shutdown();

      // Drain microtasks so the final flush's await chain resolves.
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('after shutdown(), further report() calls are dropped silently', async () => {
      const { reporter, fetchFn } = makeReporter();
      reporter.shutdown();

      reporter.report('ai_completions', 1);

      await vi.advanceTimersByTimeAsync(2000);
      // The reporter is stopped; the latest report() was dropped on the floor.
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('is idempotent: calling shutdown() twice does not throw', () => {
      const { reporter } = makeReporter();
      reporter.shutdown();
      expect(() => reporter.shutdown()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Anonymous sessions (TBP-398) — usage is billed per workspace (JWT tenant
  // claim); tokenless events can never ingest. They must be dropped at the
  // door, and a stale queue must never be flushed without a token (a
  // tokenless POST is a guaranteed 401 that the retry machinery would
  // hot-loop forever).
  // -------------------------------------------------------------------------
  describe('anonymous sessions (TBP-398)', () => {
    it('report() drops events when getAccessToken() returns null — nothing queued, nothing fetched', async () => {
      const storage = new InMemoryStorage();
      const { reporter, fetchFn, logger } = makeReporter({
        getAccessToken: () => null,
        storage,
      });

      reporter.report('bridge.flag_evaluations', 1);
      reporter.report('bridge.flag_evaluations', 1);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchFn).not.toHaveBeenCalled();
      const status = await reporter.getQueueStatus();
      expect(status.queueDepth).toBe(0);
      // Warned once, not per event.
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('flush makes no network attempt while the token is null, keeps the queue, and drains after re-auth', async () => {
      const storage = new InMemoryStorage();
      let token: string | null = 'access-tok';
      const { reporter, fetchFn } = makeReporter({
        getAccessToken: () => token,
        storage,
      });

      // Enqueued while authenticated…
      reporter.report('bridge.flag_evaluations', 1, 'idem-anon-1');
      // …but the token expires before the debounce window closes.
      token = null;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchFn).not.toHaveBeenCalled();
      expect((await reporter.getQueueStatus()).queueDepth).toBe(1);

      // Token returns (refresh/login) — the next flush drains the queue.
      token = 'access-tok-2';
      await reporter.flushNow();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [, init] = fetchFn.mock.calls[0];
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
        'Bearer access-tok-2',
      );
      expect((await reporter.getQueueStatus()).queueDepth).toBe(0);
    });
  });
});
