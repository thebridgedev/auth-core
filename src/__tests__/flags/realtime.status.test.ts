// TBP-643 — refused realtime connections stop looping and explain themselves
// once; transient faults log once on the way down and once on the way up.
//
// Background: AppSync Events answers a refused connect with
// `connection_error` / errorType UnauthorizedException and NO reason. The
// client used to close, back off and retry with the same token forever — a
// stage app logged the same reason-less line 101 times.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REALTIME_DOCS_BASE_URL,
  RealtimeClient,
  type RealtimeStatus,
  type WebSocketLike,
} from '../../flags/realtime.js';

// ── Fake WebSocket (close fires onclose synchronously, like realtime.test.ts) ─

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  refused = false;
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

const fakeWsFactory = (url: string, protocols?: string | string[]): WebSocketLike =>
  new FakeWebSocket(url, protocols);

// ── Fetch mock — plain objects so every await is a microtask ────────────────

interface Call {
  path: string;
  init: any;
}
type Responder = (init: any) => { status: number; body?: unknown };

function mkFetch(calls: Call[], routes: Record<string, Responder>): typeof fetch {
  return (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const r = routes[path];
    const { status, body } = r ? r(init) : { status: 404, body: { message: 'Not Found' } };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

const API = 'https://api.test.local';
const APPSYNC_HOST = 'svc.appsync-realtime-api.eu-west-1.amazonaws.com';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'PS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function bridgeToken(overrides: Record<string, unknown> = {}): string {
  return makeJwt({
    iss: `${API}/auth`,
    aid: 'app-1',
    tid: 't-1',
    sub: 'u-1',
    aud: ['app-1'],
    exp: nowSec() + 3600,
    ...overrides,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const APPSYNC_CONFIG: Responder = () => ({ status: 200, body: { kind: 'appsync', endpoint: APPSYNC_HOST } });
const AUTH_REFUSAL = {
  type: 'connection_error',
  errors: [{ errorType: 'UnauthorizedException', errorCode: 401 }],
};

function mkLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function setup(
  opts: {
    getAuthToken?: () => string | undefined;
    refreshAuthToken?: () => Promise<string | undefined>;
    diagnose?: boolean;
    routes?: Record<string, Responder>;
  } = {},
) {
  const calls: Call[] = [];
  const logger = mkLogger();
  const statuses: RealtimeStatus[] = [];
  const token = bridgeToken();
  const client = new RealtimeClient({
    apiBaseUrl: API,
    apiKey: 'test-api-key',
    appId: 'app-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    websocketFactory: fakeWsFactory,
    fetchFn: mkFetch(calls, { '/realtime/config': APPSYNC_CONFIG, ...opts.routes }),
    logger,
    getAuthToken: 'getAuthToken' in opts ? opts.getAuthToken : () => token,
    refreshAuthToken: opts.refreshAuthToken,
    diagnose: opts.diagnose,
  });
  client.setOnStatusChange((s) => statuses.push(s));
  return { client, calls, logger, statuses, token };
}

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

function refuse(ws: FakeWebSocket, frame: unknown = AUTH_REFUSAL): void {
  ws.refused = true;
  ws.triggerOpen();
  ws.triggerMessage(frame);
}

function connectOk(ws: FakeWebSocket): void {
  ws.triggerOpen();
  ws.triggerMessage({ type: 'connection_ack' });
  for (const raw of ws.sent) {
    const f = JSON.parse(raw);
    if (f.type === 'subscribe') ws.triggerMessage({ type: 'subscribe_success', id: f.id });
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Authorization value the socket presented in its `header-…` subprotocol. */
function bearer(ws: FakeWebSocket): string {
  const list = Array.isArray(ws.protocols) ? ws.protocols : [ws.protocols ?? ''];
  const header = list.find((p) => p.startsWith('header-'))!.slice('header-'.length);
  const padded = header.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((header.length + 3) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')).Authorization;
}

const diagnoseCalls = (calls: Call[]) => calls.filter((c) => c.path === '/realtime/diagnose');
const errorText = (logger: ReturnType<typeof mkLogger>) =>
  logger.error.mock.calls.map((c) => String(c[0])).join('\n---\n');

/** Keep refusing whatever socket the client opens — what the old loop ran into forever. */
async function advanceRefusingEverything(ms: number, steps = 10): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(ms / steps);
    const ws = lastWs();
    if (ws && !ws.refused) refuse(ws);
    await flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── (1) no refresh hook ─────────────────────────────────────────────────────

describe('refused connect without a refresh hook', () => {
  it('logs ONE terminal message, parks in unauthorized, and never reconnects', async () => {
    const { client, logger, calls } = setup();
    await client.start();
    refuse(lastWs());
    await flush();

    await advanceRefusingEverything(10 * 60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe('unauthorized');
    expect(client.getStatus()).toMatchObject({ state: 'unauthorized', retrying: false });
    expect(diagnoseCalls(calls)).toHaveLength(1);
  });

  it('detects the refusal from errorType alone, nested under payload, with no message text', async () => {
    const { client } = setup({ diagnose: false });
    await client.start();
    refuse(lastWs(), { type: 'connection_error', payload: { errors: [{ errorType: 'Unauthorized' }] } });
    await flush();
    expect(client.getState()).toBe('unauthorized');
  });

  it('treats a Centrifugo /realtime/authorize 401 the same way — no backoff loop', async () => {
    const { client, logger } = setup({
      diagnose: false,
      routes: {
        '/realtime/config': () => ({ status: 200, body: { kind: 'centrifugo', endpoint: 'wss://x' } }),
        '/realtime/authorize': () => ({ status: 401 }),
      },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.getState()).toBe('unauthorized');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

// ── (2) + (3) refresh hook ──────────────────────────────────────────────────

describe('refused connect with a refresh hook', () => {
  it('refreshes once and reconnects immediately with the new token; success → open, no terminal log', async () => {
    const tokenA = bridgeToken({ jti: 'a' });
    const tokenB = bridgeToken({ jti: 'b' });
    let current = tokenA;
    const refresh = vi.fn(async () => {
      current = tokenB;
      return tokenB;
    });
    const { client, logger, calls } = setup({ getAuthToken: () => current, refreshAuthToken: refresh });
    await client.start();
    refuse(lastWs());
    await flush(); // no timer advanced — the reconnect must not wait for backoff

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(bearer(lastWs())).toBe(`Bearer ${tokenB}`);

    connectOk(lastWs());
    expect(client.getState()).toBe('open');
    expect(client.getStatus()).toMatchObject({ state: 'open', retrying: false });
    expect(client.getStatus().reason).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(diagnoseCalls(calls)).toHaveLength(0);
  });

  it('uses the refreshed token even if the host store has not caught up yet', async () => {
    const tokenA = bridgeToken({ jti: 'a' });
    const tokenB = bridgeToken({ jti: 'b' });
    const { client } = setup({ getAuthToken: () => tokenA, refreshAuthToken: async () => tokenB });
    await client.start();
    refuse(lastWs());
    await flush();
    expect(bearer(lastWs())).toBe(`Bearer ${tokenB}`);
  });

  it('refreshed token refused too → ONE diagnose call, ONE terminal log with the diagnosed reason/side', async () => {
    const tokenA = bridgeToken({ jti: 'a' });
    const tokenB = bridgeToken({ jti: 'b' });
    let current = tokenA;
    const refresh = vi.fn(async () => {
      current = tokenB;
      return tokenB;
    });
    const { client, logger, calls } = setup({
      getAuthToken: () => current,
      refreshAuthToken: refresh,
      routes: {
        '/realtime/diagnose': () => ({ status: 200, body: { ok: false, reason: 'session_revoked', side: 'app' } }),
      },
    });
    await client.start();
    refuse(lastWs());
    await flush();
    refuse(lastWs());
    await flush();
    await advanceRefusingEverything(10 * 60_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const diag = diagnoseCalls(calls);
    expect(diag).toHaveLength(1);
    const status = client.getStatus();
    expect(status).toMatchObject({
      state: 'unauthorized',
      reason: 'session_revoked',
      side: 'app',
      retrying: false,
      docsUrl: `${REALTIME_DOCS_BASE_URL}#session_revoked`,
    });
    expect(diag[0].init.method).toBe('POST');
    expect(diag[0].init.headers.Authorization).toBe(`Bearer ${tokenB}`);
    expect(diag[0].init.headers['x-app-id']).toBe('app-1');
    expect(diag[0].init.headers['x-bridge-realtime-ref']).toBe(status.ref);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const msg = errorText(logger);
    expect(msg).toContain("Bridge refused this session's realtime connection (session_revoked)");
    expect(msg).toContain(`${REALTIME_DOCS_BASE_URL}#session_revoked · ref ${status.ref}`);
  });
});

// ── (4) client-side pre-checks ──────────────────────────────────────────────

describe('client-side pre-checks name the fault without asking Bridge', () => {
  const cases: Array<{
    name: string;
    token: () => string | undefined;
    reason: string;
    side: string;
    mentions?: string[];
  }> = [
    { name: 'expired', token: () => bridgeToken({ exp: nowSec() - 60 }), reason: 'expired', side: 'app' },
    {
      name: 'wrong_environment',
      token: () => bridgeToken({ iss: 'https://api.other.local/auth' }),
      reason: 'wrong_environment',
      side: 'config',
      mentions: ['api.test.local', 'api.other.local'],
    },
    {
      name: 'wrong_app',
      token: () => bridgeToken({ aid: 'app-2' }),
      reason: 'wrong_app',
      side: 'config',
      mentions: ['app-1', 'app-2'],
    },
    { name: 'malformed', token: () => 'not-a-jwt', reason: 'malformed', side: 'app' },
    { name: 'no_token', token: () => undefined, reason: 'no_token', side: 'app' },
  ];

  for (const c of cases) {
    it(`${c.name} → reason '${c.reason}', side '${c.side}', no diagnose call`, async () => {
      const token = c.token();
      const { client, logger, calls } = setup({
        getAuthToken: () => token,
        routes: {
          '/realtime/diagnose': () => ({ status: 200, body: { ok: false, reason: 'other', side: 'bridge' } }),
        },
      });
      await client.start();
      refuse(lastWs());
      await flush();

      expect(client.getStatus()).toMatchObject({ state: 'unauthorized', reason: c.reason, side: c.side });
      expect(diagnoseCalls(calls)).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const msg = errorText(logger);
      expect(msg).toContain(`#${c.reason}`);
      for (const m of c.mentions ?? []) expect(msg).toContain(m);
    });
  }
});

// ── (5) diagnose unavailable ────────────────────────────────────────────────

describe('diagnose endpoint unavailable', () => {
  it("404 + token passes every pre-check → reason 'refused', side 'bridge'", async () => {
    const { client, logger, calls } = setup(); // no diagnose route → 404
    await client.start();
    refuse(lastWs());
    await flush();

    expect(diagnoseCalls(calls)).toHaveLength(1);
    const status = client.getStatus();
    expect(status).toMatchObject({ state: 'unauthorized', reason: 'refused', side: 'bridge' });
    const msg = errorText(logger);
    expect(msg).toContain("this is a problem on Bridge's side, not in your app");
    expect(msg).toContain(`include ref ${status.ref} if you contact support`);
  });

  it('a throwing fetch is tolerated the same way', async () => {
    const { client } = setup({
      routes: {
        '/realtime/diagnose': () => {
          throw new Error('network down');
        },
      },
    });
    await client.start();
    refuse(lastWs());
    await flush();
    expect(client.getStatus()).toMatchObject({ reason: 'refused', side: 'bridge' });
  });

  it('diagnose: false skips the call', async () => {
    const { client, calls } = setup({ diagnose: false });
    await client.start();
    refuse(lastWs());
    await flush();
    expect(diagnoseCalls(calls)).toHaveLength(0);
    expect(client.getStatus()).toMatchObject({ reason: 'refused', side: 'bridge' });
  });
});

// ── (6) resume ──────────────────────────────────────────────────────────────

describe('resuming a parked client', () => {
  it('start() with the same token stays parked; reauthorize() with a new token reconnects', async () => {
    const tokenA = bridgeToken({ jti: 'a' });
    const tokenB = bridgeToken({ jti: 'b' });
    let current = tokenA;
    const { client } = setup({ getAuthToken: () => current, diagnose: false });
    await client.start();
    refuse(lastWs());
    await flush();
    expect(client.getState()).toBe('unauthorized');

    await client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toBe('unauthorized');

    current = tokenB;
    await client.reauthorize();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(bearer(lastWs())).toBe(`Bearer ${tokenB}`);
    connectOk(lastWs());
    expect(client.getStatus()).toMatchObject({ state: 'open', retrying: false });
    expect(client.getStatus().side).toBeUndefined();
  });

  it('start() with a different token resumes on its own', async () => {
    let current = bridgeToken({ jti: 'a' });
    const { client } = setup({ getAuthToken: () => current, diagnose: false });
    await client.start();
    refuse(lastWs());
    await flush();
    current = bridgeToken({ jti: 'b' });
    await client.start();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("the browser 'online' event resumes; an identical refusal is not logged at error again", async () => {
    const handlers: Record<string, () => void> = {};
    vi.stubGlobal('addEventListener', (type: string, h: () => void) => (handlers[type] = h));
    vi.stubGlobal('removeEventListener', () => {});
    const { client, logger } = setup({ diagnose: false });
    await client.start();
    refuse(lastWs());
    await flush();
    expect(handlers.online).toBeTypeOf('function');

    handlers.online();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    refuse(lastWs());
    await flush();
    expect(client.getState()).toBe('unauthorized');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});

// ── (7) transient faults ────────────────────────────────────────────────────

describe('transient faults log once down, once up', () => {
  it('repeated non-auth connection_error → one "retrying" log and one "restored" log', async () => {
    const { client, logger } = setup();
    await client.start();
    for (let i = 0; i < 5; i++) {
      const ws = lastWs();
      ws.triggerOpen();
      ws.triggerMessage({ type: 'connection_error', errors: [{ errorType: 'InternalFailure', message: 'boom' }] });
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('Retrying in the background');
    expect(String(logger.error.mock.calls[0][0])).toContain('boom');
    expect(client.getStatus()).toMatchObject({ side: 'network', retrying: true });

    connectOk(lastWs());
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(String(logger.error.mock.calls[1][0])).toBe('[bridge] Live updates restored after 5 attempts.');
    expect(client.getStatus()).toMatchObject({ state: 'open', retrying: false });
  });

  it('dropped socket + failing config fetches → one warn down, one warn up, nothing at error', async () => {
    let failures = 0;
    const { client, logger } = setup({
      routes: {
        '/realtime/config': () =>
          failures-- > 0
            ? { status: 500 }
            : { status: 200, body: { kind: 'centrifugo', endpoint: 'wss://x' } },
        '/realtime/authorize': () => ({
          status: 200,
          body: { allowed: [], denied: [], signedToken: 't', expiresAt: 1 },
        }),
      },
    });
    await client.start();
    lastWs().triggerOpen();
    failures = 3;
    lastWs().close(); // unexpected drop
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    lastWs().triggerOpen();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(String(logger.warn.mock.calls[0][0])).toContain('Live updates interrupted');
    expect(String(logger.warn.mock.calls[1][0])).toBe('[bridge] Live updates restored after 4 attempts.');
  });

  it('an intentional reconnect (setUserId) is not reported as a fault', async () => {
    const { client, logger } = setup({
      routes: {
        '/realtime/config': () => ({ status: 200, body: { kind: 'centrifugo', endpoint: 'wss://x' } }),
        '/realtime/authorize': () => ({
          status: 200,
          body: { allowed: [], denied: [], signedToken: 't', expiresAt: 1 },
        }),
      },
    });
    await client.start();
    lastWs().triggerOpen();
    client.setUserId('u-2');
    await vi.advanceTimersByTimeAsync(5_000);
    lastWs().triggerOpen();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ── (8) onStatusChange ──────────────────────────────────────────────────────

describe('onStatusChange', () => {
  it('receives the transitions through to unauthorized', async () => {
    const { client, statuses } = setup({ diagnose: false });
    await client.start();
    refuse(lastWs());
    await flush();

    expect(statuses[0]).toMatchObject({ state: 'connecting', retrying: false });
    expect(statuses.some((s) => s.state === 'connecting' && s.retrying)).toBe(true);
    const last = statuses[statuses.length - 1];
    expect(last).toMatchObject({
      state: 'unauthorized',
      reason: 'refused',
      side: 'bridge',
      retrying: false,
      docsUrl: `${REALTIME_DOCS_BASE_URL}#refused`,
    });
    expect(last.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof last.since).toBe('number');
    expect(client.getStatus()).toEqual(last);
  });

  it('a throwing hook is swallowed', async () => {
    const { client } = setup({ diagnose: false });
    client.setOnStatusChange(() => {
      throw new Error('indicator blew up');
    });
    await client.start();
    connectOk(lastWs());
    expect(client.getState()).toBe('open');
  });

  it('getState() keeps working unchanged alongside getStatus()', async () => {
    const { client } = setup();
    expect(client.getState()).toBe('idle');
    expect(client.getStatus()).toMatchObject({ state: 'idle', retrying: false });
    await client.start();
    connectOk(lastWs());
    expect(client.getState()).toBe('open');
  });
});
