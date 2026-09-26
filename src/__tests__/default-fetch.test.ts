// TBP-722 — the default `fetch` must survive being stored on an object and
// called as a method. A browser's native `fetch` throws "Illegal invocation"
// when its `this` is anything but the Window (or undefined); Node's does not,
// so these tests install a stub that enforces the browser rule. Before the fix,
// the realtime client ended in `setup_failed` and the usage reporter never
// delivered a batch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from '../flags/realtime.js';
import { UsageReporter } from '../usage/usage-reporter.js';
import { InMemoryStorage } from '../usage/storage/index.js';
import { defaultFetch } from '../default-fetch.js';

/** A `fetch` that behaves like Chrome's about its receiver. */
function browserLikeFetch(respond: (url: string) => unknown) {
  const calls: string[] = [];
  const fn = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    const url = String(input);
    calls.push(url);
    const body = respond(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const noWebSocket = (() => {
  throw new Error('no socket expected');
}) as unknown as (url: string, protocols?: string | string[]) => WebSocketLike;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('defaultFetch (TBP-722)', () => {
  it('can be called as a method of another object', async () => {
    const { fn, calls } = browserLikeFetch(() => ({}));
    vi.stubGlobal('fetch', fn);
    const holder = { fetchFn: defaultFetch() };
    await expect(holder.fetchFn('https://api.test.local/x')).resolves.toBeDefined();
    expect(calls).toEqual(['https://api.test.local/x']);
  });

  it('keeps the fetch that existed when it was created, as the old default did', async () => {
    const first = browserLikeFetch(() => ({}));
    vi.stubGlobal('fetch', first.fn);
    const f = defaultFetch();
    const later = browserLikeFetch(() => ({}));
    vi.stubGlobal('fetch', later.fn);
    await f('https://api.test.local/y');
    expect(first.calls).toEqual(['https://api.test.local/y']);
    expect(later.calls).toEqual([]);
  });

  it('realtime client with no fetchFn reaches its config endpoint instead of setup_failed', async () => {
    const { fn, calls } = browserLikeFetch((url) =>
      url.endsWith('/realtime/config') ? { kind: 'noop' } : {},
    );
    vi.stubGlobal('fetch', fn);
    const client = new RealtimeClient({
      apiBaseUrl: 'https://api.test.local',
      apiKey: 'test-api-key',
      workspaceId: 'ws-1',
      userId: 'u-1',
      websocketFactory: noWebSocket,
      diagnose: false,
      reportStatus: false,
    });
    await client.start();
    expect(calls).toContain('https://api.test.local/realtime/config');
    expect(client.getState()).toBe('closed'); // the noop adapter's outcome, not a setup failure
  });

  it('usage reporter with no fetchFn delivers its batch', async () => {
    vi.useFakeTimers();
    const { fn, calls } = browserLikeFetch(() => ({}));
    vi.stubGlobal('fetch', fn);
    const reporter = new UsageReporter({
      apiBaseUrl: 'https://api.test.local',
      getAccessToken: () => 'access-tok',
      logger: { warn: vi.fn() },
      batchSize: 1,
      flushIntervalMs: 1000,
      storage: new InMemoryStorage(),
    });
    reporter.report('ai_completions', 1);
    await vi.advanceTimersByTimeAsync(1000); // the debounced flush
    expect(calls.some((u) => u.startsWith('https://api.test.local/'))).toBe(true);
    vi.useRealTimers();
  });
});
