// TBP-645 — the realtime client reports its health to Bridge so the admin UI
// can show per-app live-update status. The report is telemetry on the connect
// path: it must never be awaited, never throw, and never be able to change
// what the connection does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from '../../flags/realtime.js';

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  triggerMessage(data: any) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

interface Call {
  path: string;
  init: any;
}
type Responder = (init: any) => { status: number; body?: unknown } | Promise<never>;

const API = 'https://api.test.local';
const REPORT_PATH = '/account/auth/realtime-status';
const APPSYNC_HOST = 'svc.appsync-realtime-api.eu-west-1.amazonaws.com';
const AUTH_REFUSAL = {
  type: 'connection_error',
  errors: [{ errorType: 'UnauthorizedException', errorCode: 401 }],
};

function mkFetch(calls: Call[], routes: Record<string, Responder>): typeof fetch {
  return (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const r = routes[path];
    const res = r ? await r(init) : { status: 404, body: { message: 'Not Found' } };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bridgeToken(): string {
  const claims = { iss: `${API}/auth`, aid: 'app-1', sub: 'u-1', exp: Math.floor(Date.now() / 1000) + 3600 };
  return `${b64url(JSON.stringify({ alg: 'PS256' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

function setup(opts: { reportStatus?: boolean; routes?: Record<string, Responder>; fetchFn?: typeof fetch } = {}) {
  const calls: Call[] = [];
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const token = bridgeToken();
  const client = new RealtimeClient({
    apiBaseUrl: API,
    apiKey: 'test-api-key',
    appId: 'app-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    websocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
    fetchFn:
      opts.fetchFn ??
      mkFetch(calls, {
        '/realtime/config': () => ({ status: 200, body: { kind: 'appsync', endpoint: APPSYNC_HOST } }),
        ...opts.routes,
      }),
    logger,
    getAuthToken: () => token,
    diagnose: false,
    reportStatus: opts.reportStatus,
  });
  return { client, calls, logger };
}

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const reports = (calls: Call[]) => calls.filter((c) => c.path === REPORT_PATH);
const reportBodies = (calls: Call[]) => reports(calls).map((c) => JSON.parse(c.init.body));

function connectOk(ws: FakeWebSocket): void {
  ws.triggerOpen();
  ws.triggerMessage({ type: 'connection_ack' });
  for (const raw of ws.sent) {
    const f = JSON.parse(raw);
    if (f.type === 'subscribe') ws.triggerMessage({ type: 'subscribe_success', id: f.id });
  }
}

function rejectAllSubscribes(ws: FakeWebSocket): void {
  ws.triggerOpen();
  ws.triggerMessage({ type: 'connection_ack' });
  for (const raw of ws.sent) {
    const f = JSON.parse(raw);
    if (f.type === 'subscribe') {
      ws.triggerMessage({ type: 'subscribe_error', id: f.id, errors: [{ errorType: 'UnauthorizedException' }] });
    }
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Drop the socket and let the client reconnect to a healthy one. */
async function dropAndReconnect(): Promise<void> {
  lastWs().close(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  await flush();
  connectOk(lastWs());
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('realtime status reporting (TBP-645)', () => {
  it('reports once when the connection opens, attributed by x-app-id and carrying no token', async () => {
    const { client, calls } = setup();
    await client.start();
    connectOk(lastWs());
    await flush();

    const sent = reports(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0].init.method).toBe('POST');
    expect(sent[0].init.headers['x-app-id']).toBe('app-1');
    expect(sent[0].init.headers.Authorization).toBeUndefined();
    expect(sent[0].init.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(sent[0].init.body)).toEqual({ state: 'open' });
  });

  it('throttles open reports to one per 10 minutes per client', async () => {
    const { client, calls } = setup();
    await client.start();
    connectOk(lastWs());
    await flush();

    await dropAndReconnect();
    await dropAndReconnect();
    expect(client.getState()).toBe('open');
    expect(reports(calls)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await dropAndReconnect();
    expect(reportBodies(calls)).toEqual([{ state: 'open' }, { state: 'open' }]);
  });

  it('reports a refusal once per episode, with the reason, side and ref the status carries', async () => {
    const { client, calls } = setup();
    await client.start();
    lastWs().triggerOpen();
    lastWs().triggerMessage(AUTH_REFUSAL);
    await flush();

    const status = client.getStatus();
    expect(status.state).toBe('unauthorized');
    expect(reportBodies(calls)).toEqual([
      { state: 'unauthorized', reason: 'refused', side: 'bridge', ref: status.ref },
    ]);

    // Parked: time passes, nothing reconnects, nothing is re-reported.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports(calls)).toHaveLength(1);

    // A resume that ends in the IDENTICAL refusal is not new news.
    await client.reauthorize();
    lastWs().triggerOpen();
    lastWs().triggerMessage(AUTH_REFUSAL);
    await flush();
    expect(client.getState()).toBe('unauthorized');
    expect(reports(calls)).toHaveLength(1);
  });

  it('reports degraded once, even though both the reject path and the ack timer can mark it', async () => {
    const { client, calls } = setup();
    await client.start();
    rejectAllSubscribes(lastWs());
    await flush();
    expect(client.getState()).toBe('degraded');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reportBodies(calls)).toEqual([{ state: 'degraded', reason: 'no_channel_accepted' }]);
  });

  it('never throws or blocks the connection when the report endpoint misbehaves', async () => {
    for (const misbehave of [
      () => ({ status: 404, body: { message: 'Not Found' } }),
      () => ({ status: 500 }),
      () => Promise.reject(new Error('network down')),
    ] as Responder[]) {
      FakeWebSocket.instances = [];
      const { client, calls, logger } = setup({ routes: { [REPORT_PATH]: misbehave } });
      await expect(client.start()).resolves.toBeUndefined();
      connectOk(lastWs());
      await flush();
      expect(client.getState()).toBe('open');
      expect(reports(calls)).toHaveLength(1);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      await client.stop();
    }
  });

  it('survives a synchronously-throwing fetch', async () => {
    const base = mkFetch([], {
      '/realtime/config': () => ({ status: 200, body: { kind: 'appsync', endpoint: APPSYNC_HOST } }),
    });
    const fetchFn = ((url: string, init: any) => {
      if (url.endsWith(REPORT_PATH)) throw new TypeError('fetch exploded');
      return base(url, init);
    }) as unknown as typeof fetch;
    const { client } = setup({ fetchFn });
    await client.start();
    connectOk(lastWs());
    await flush();
    expect(client.getState()).toBe('open');
  });

  it('aborts a hung report after 3 s', async () => {
    let signal: AbortSignal | undefined;
    const { client, calls } = setup({
      routes: {
        [REPORT_PATH]: (init) => {
          signal = init.signal;
          return new Promise<never>(() => {});
        },
      },
    });
    await client.start();
    connectOk(lastWs());
    await flush();
    expect(reports(calls)).toHaveLength(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(signal?.aborted).toBe(true);
    expect(client.getState()).toBe('open');
  });

  it('sends nothing when reportStatus is false', async () => {
    const { client, calls } = setup({ reportStatus: false });
    await client.start();
    connectOk(lastWs());
    await flush();
    await dropAndReconnect();
    lastWs().triggerMessage(AUTH_REFUSAL);
    await flush();
    expect(reports(calls)).toHaveLength(0);
  });
});
