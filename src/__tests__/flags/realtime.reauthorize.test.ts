import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from '../../flags/realtime.js';

// ── Fake WebSocket factory (mirrors realtime.test.ts) ───────────────────────

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    // Simulate a late onclose firing — matches a real browser ws where the
    // close event arrives asynchronously. Tests that need to assert "the
    // late onclose was suppressed" trigger it manually via triggerClose().
  }
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  triggerClose(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  triggerMessage(data: any) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

const fakeWsFactory = (url: string): WebSocketLike => new FakeWebSocket(url);

// ── Mock fetch (vi.fn so we can inspect Authorization headers per call) ─────

interface FetchCall {
  url: string;
  init: any;
}

const mkFetch = (
  responses: Record<string, (init: any) => any>,
  calls: FetchCall[],
): ReturnType<typeof vi.fn> => {
  return vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const responder = responses[path];
    if (!responder) {
      return new Response(JSON.stringify({ kind: 'noop' }), { status: 404 });
    }
    const body = responder(init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
};

const CONFIG = {
  apiBaseUrl: 'https://api.test.local',
  apiKey: 'test-api-key',
  workspaceId: 'ws-1',
  userId: 'u-1',
  websocketFactory: fakeWsFactory,
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const STD_RESPONSES = {
  '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://realtime.test.local/ws' }),
  '/realtime/authorize': () => ({
    allowed: ['workspace:ws-1', 'user:ws-1:u-1'],
    denied: [],
    signedToken: 'sig.token.abc',
    expiresAt: Date.now() + 60_000,
  }),
};

function authorizeCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => new URL(c.url).pathname === '/realtime/authorize');
}

function authHeader(init: any): string | undefined {
  return init?.headers?.Authorization;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RealtimeClient.reauthorize() — disabled / stopped no-ops', () => {
  it('is a no-op when enabled=false', async () => {
    const calls: FetchCall[] = [];
    const client = new RealtimeClient({
      ...CONFIG,
      enabled: false,
      fetchFn: mkFetch(STD_RESPONSES, calls),
    });
    await client.reauthorize();
    expect(client.getState()).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('is a no-op after stop() has been called', async () => {
    const calls: FetchCall[] = [];
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch(STD_RESPONSES, calls),
    });
    await client.start();
    // open the socket so we exercise the "had a connection, then stopped" path
    FakeWebSocket.instances[0].triggerOpen();
    expect(client.getState()).toBe('open');
    await client.stop();
    expect(client.getState()).toBe('closed');

    const callsBefore = calls.length;
    const wsCountBefore = FakeWebSocket.instances.length;
    await client.reauthorize();
    await vi.runAllTimersAsync();

    // No additional fetches, no additional sockets — stopped clients stay dead.
    expect(calls.length).toBe(callsBefore);
    expect(FakeWebSocket.instances.length).toBe(wsCountBefore);
    expect(client.getState()).toBe('closed');
  });
});

describe('RealtimeClient.reauthorize() — idle state', () => {
  it('from idle state calls start() and opens the connection', async () => {
    const calls: FetchCall[] = [];
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch(STD_RESPONSES, calls),
    });
    expect(client.getState()).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);

    await client.reauthorize();

    // start() fired: config + authorize fetched, exactly one new ws opened.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(authorizeCalls(calls)).toHaveLength(1);

    FakeWebSocket.instances[0].triggerOpen();
    expect(client.getState()).toBe('open');
  });
});

describe('RealtimeClient.reauthorize() — while open', () => {
  it('closes the existing socket with code 1000 / reason sdk.reauthorize', async () => {
    const calls: FetchCall[] = [];
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch(STD_RESPONSES, calls),
    });
    await client.start();
    const oldWs = FakeWebSocket.instances[0] as FakeWebSocket;
    oldWs.triggerOpen();
    expect(client.getState()).toBe('open');

    await client.reauthorize();

    expect(oldWs.closeCalls).toHaveLength(1);
    expect(oldWs.closeCalls[0]).toEqual({ code: 1000, reason: 'sdk.reauthorize' });
  });

  it('opens a new socket and re-fires /realtime/authorize with the CURRENT token', async () => {
    const calls: FetchCall[] = [];
    // The captured token mutates between the initial start() and reauthorize().
    let currentToken: string | undefined = 'token-v1';
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch(STD_RESPONSES, calls),
      getAuthToken: () => currentToken,
    });

    await client.start();
    const firstWs = FakeWebSocket.instances[0] as FakeWebSocket;
    firstWs.triggerOpen();
    expect(client.getState()).toBe('open');

    // First authorize used token-v1.
    const authCallsAfterStart = authorizeCalls(calls);
    expect(authCallsAfterStart).toHaveLength(1);
    expect(authHeader(authCallsAfterStart[0].init)).toBe('Bearer token-v1');

    // Rotate the token, then reauthorize.
    currentToken = 'token-v2';
    await client.reauthorize();

    // Second authorize fired with the rotated token.
    const authCallsAfterReauth = authorizeCalls(calls);
    expect(authCallsAfterReauth).toHaveLength(2);
    expect(authHeader(authCallsAfterReauth[1].init)).toBe('Bearer token-v2');

    // A fresh socket was opened (in addition to the original).
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const newWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;
    expect(newWs).not.toBe(firstWs);
  });

  it('does NOT fire onCloseHook for the replaced (old) socket — identity guard suppresses it', async () => {
    const calls: FetchCall[] = [];
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch(STD_RESPONSES, calls),
    });
    const onCloseHook = vi.fn();
    client.setOnClose(onCloseHook);

    await client.start();
    const oldWs = FakeWebSocket.instances[0] as FakeWebSocket;
    oldWs.triggerOpen();
    expect(client.getState()).toBe('open');

    await client.reauthorize();

    // Reauthorize replaced the ws ref BEFORE asking the old socket to close.
    // Simulate the late onclose event that a real browser would fire.
    oldWs.triggerClose(1000);

    // The new socket comes up and triggers open — but its open path must not
    // cause onCloseHook to fire either.
    const newWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;
    newWs.triggerOpen();

    expect(onCloseHook).not.toHaveBeenCalled();
  });

  it("the old socket's late onclose does NOT call scheduleReconnect (no extra ws spawned)", async () => {
    const calls: FetchCall[] = [];
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch(STD_RESPONSES, calls),
      reconnectBaseMs: 10,
    });

    await client.start();
    const firstWs = FakeWebSocket.instances[0] as FakeWebSocket;
    firstWs.triggerOpen();

    await client.reauthorize();

    // After reauthorize: exactly two sockets — the original + the one
    // reauthorize() spun up. Bring the new one to open so any stray reconnect
    // would be visible.
    const newWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;
    newWs.triggerOpen();
    const wsCountBeforeStaleClose = FakeWebSocket.instances.length;
    expect(wsCountBeforeStaleClose).toBe(2);

    // Now the old socket's onclose fires late. If the identity guard works,
    // scheduleReconnect() is NEVER called and no third ws appears.
    firstWs.triggerClose(1000);
    await vi.runAllTimersAsync();

    expect(FakeWebSocket.instances.length).toBe(wsCountBeforeStaleClose);
    expect(client.getState()).toBe('open');
  });
});

describe('RealtimeClient.reauthorize() — while connecting', () => {
  it("is a no-op when state is 'connecting'; the in-flight authorize finishes once", async () => {
    // Use real timers for this test — we orchestrate the connecting-state
    // window via a manually-resolvable authorize promise, not via timer math.
    vi.useRealTimers();

    const calls: FetchCall[] = [];
    // Hang /realtime/config on the first call so the client stays in
    // 'connecting' state when we invoke reauthorize() — that's the
    // simplest gate that puts us mid-start() before any authorize fires.
    let resolveConfig!: (value: any) => void;
    const configPromise = new Promise<any>((resolve) => {
      resolveConfig = resolve;
    });
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === '/realtime/config') {
        const body = await configPromise;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (path === '/realtime/authorize') {
        return new Response(
          JSON.stringify({
            allowed: [],
            denied: [],
            signedToken: 'sig.token.first',
            expiresAt: Date.now() + 60_000,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // Kick off start() but DO NOT await — leaves us mid-fetchServerConfig.
    const startPromise = client.start();
    // Let microtasks run so the fetch mock registers the config call.
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getState()).toBe('connecting');
    // No authorize yet — config is still hanging.
    expect(authorizeCalls(calls)).toHaveLength(0);

    // Reauthorize during connecting → no-op.
    await client.reauthorize();
    expect(client.getState()).toBe('connecting');
    // Still no authorize — reauthorize did NOT bypass the connecting gate.
    expect(authorizeCalls(calls)).toHaveLength(0);

    // Unblock the in-flight config; start() proceeds to authorize and opens ws.
    resolveConfig({ kind: 'centrifugo', endpoint: 'wss://realtime.test.local/ws' });
    await startPromise;
    // Flush a few microtasks for the post-authorize ws-open path.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Exactly ONE authorize call ever — reauthorize during connecting did
    // not cause a second authorize.
    expect(authorizeCalls(calls)).toHaveLength(1);
    // Exactly one socket opened (no duplicate spawn).
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
