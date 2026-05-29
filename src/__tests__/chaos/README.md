# Usage queue chaos suite — DEFERRED to end-of-phase test pass

US-19 (TBP-270) defined five chaos scenarios that verify the durable usage
queue's zero-loss guarantee under realistic failure modes. These tests are
NOT written in the US-19 implementation commit because they require a real
bridge-api container plus scripted process kills via a Playwright / Jest
harness. They will be authored together in the Phase E end-of-phase test
pass, alongside the rest of Billing 2.0's E2E coverage.

## The five scenarios

1. **Kill-mid-batch.** Enqueue N events. While the SDK is in the middle of
   POSTing the first batch to `/usage/ingest`, SIGKILL the process. On next
   init, verify all N events arrive on the server with their original
   idempotency keys and that the server's dedupe accepts each exactly once.

2. **6h offline.** Take the network down. Enqueue events for a simulated
   6-hour window (clock-advanced via test fakes). Bring the network back up.
   Verify the queue replays every event and that retryCount values match the
   number of failed attempts.

3. **Force-quit.** In browser mode, navigate the tab while a flush is in
   flight. Reopen the page. Verify IndexedDB still contains the un-acked
   events and that the next UsageReporter construction triggers an immediate
   replay flush (hydration path).

4. **Tab close.** Like force-quit but via `window.close()` — exercises the
   `beforeunload` codepath if/when we add one. For v1 the bar is: events
   already persisted via `storage.enqueue()` survive; events still in the
   in-process call stack between `report()` and `storage.enqueue()` are
   acceptable losses (microsecond window).

5. **Page nav.** SPA route change while a flush is pending. Same bar as
   tab close — anything that made it into IndexedDB must replay.

## Pass criteria (zero-loss bar)

For every scenario:
- No event accepted into `bridge.usage.report()` is lost AFTER it has reached
  `storage.enqueue()`.
- Every replayed event carries its original `idempotencyKey` so the server
  dedupes duplicate deliveries.
- `getQueueStatus()` reflects the state accurately at each checkpoint.

## TODO (test phase)

- Author `chaos.queue-kill-mid-batch.spec.ts` (Playwright + bridge-api)
- Author `chaos.queue-offline-6h.spec.ts` (Vitest + fake timers + storage stub)
- Author `chaos.queue-force-quit.spec.ts` (Playwright)
- Author `chaos.queue-tab-close.spec.ts` (Playwright)
- Author `chaos.queue-page-nav.spec.ts` (Playwright)
