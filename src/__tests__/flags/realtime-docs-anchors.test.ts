// TBP-675 — every "live updates off" link must land on a real entry.
//
// The SDK links each realtime fault to
// `https://thebridge.dev/docs/live-updates/troubleshooting/#<reason>` (console
// message, `status.docsUrl`, the framework dev badges, and the sign-in origin
// error). That page shipped as a 404: nothing tied the reasons the client can
// emit to the anchors the page publishes. The page lives in bridge-web, so the
// published anchor list is checked in next to this test
// (fixtures/realtime-troubleshooting-anchors.ts) — see that file for how to
// keep the two in step.
//
// Each case drives the real RealtimeClient into the state that emits a reason
// and checks the reason AND the link it prints. A source scan on top catches a
// reason added later without a case here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN_NOT_ALLOWED_DOCS_URL } from '../../errors.js';
import { REALTIME_DOCS_BASE_URL, RealtimeClient, type WebSocketLike } from '../../flags/realtime.js';
import {
  BRIDGE_SERVER_REASONS,
  TROUBLESHOOTING_ANCHORS,
  TROUBLESHOOTING_PAGE_URL,
} from './fixtures/realtime-troubleshooting-anchors.js';

// ── Harness (same shapes as realtime.status.test.ts) ────────────────────────

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
  triggerMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

type Responder = (init: any) => { status: number; body?: unknown };

function mkFetch(routes: Record<string, Responder>): typeof fetch {
  return (async (url: string, init: any) => {
    const r = routes[new URL(url).pathname];
    const { status, body } = r ? r(init) : { status: 404, body: { message: 'Not Found' } };
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const API = 'https://api.test.local';
const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const nowSec = () => Math.floor(Date.now() / 1000);
function bridgeToken(overrides: Record<string, unknown> = {}): string {
  const claims = { iss: `${API}/auth`, aid: 'app-1', tid: 't-1', sub: 'u-1', aud: ['app-1'], exp: nowSec() + 3600, ...overrides };
  return `${b64url(JSON.stringify({ alg: 'PS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

const APPSYNC_CONFIG: Responder = () => ({
  status: 200,
  body: { kind: 'appsync', endpoint: 'svc.appsync-realtime-api.eu-west-1.amazonaws.com' },
});
const AUTH_REFUSAL = { type: 'connection_error', errors: [{ errorType: 'UnauthorizedException', errorCode: 401 }] };
const UNAUTHORIZED = [{ errorType: 'UnauthorizedException', message: 'not authorized' }];

function setup(
  opts: { token?: string | null; routes?: Record<string, Responder>; diagnose?: boolean; anonymous?: boolean } = {},
) {
  const token = opts.token === null ? undefined : (opts.token ?? bridgeToken());
  const client = new RealtimeClient({
    apiBaseUrl: API,
    apiKey: 'test-api-key',
    appId: 'app-1',
    // Signed-out sessions only subscribe to the app channel.
    workspaceId: opts.anonymous ? undefined : 'ws-1',
    userId: opts.anonymous ? undefined : 'u-1',
    websocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
    fetchFn: mkFetch({ '/realtime/config': APPSYNC_CONFIG, ...opts.routes }),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getAuthToken: () => token,
    diagnose: opts.diagnose,
  });
  return client;
}

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
function refuseConnect(ws: FakeWebSocket): void {
  ws.triggerOpen();
  ws.triggerMessage(AUTH_REFUSAL);
}
/** Ack the connection, then answer every subscribe with `errors` (or success when null). */
function answerSubscribes(ws: FakeWebSocket, errors: unknown[] | null): void {
  ws.triggerOpen();
  ws.triggerMessage({ type: 'connection_ack' });
  for (const raw of ws.sent) {
    const f = JSON.parse(raw);
    if (f.type !== 'subscribe') continue;
    ws.triggerMessage(errors ? { type: 'subscribe_error', id: f.id, errors } : { type: 'subscribe_success', id: f.id });
  }
}
const verdict = (reason: string): Responder => () => ({ status: 200, body: { ok: false, reason, side: 'app' } });

/** The assertion every case makes: the reason is published, and the link points at it. */
function expectPublished(status: { reason?: string; docsUrl?: string }, reason: string, linked: boolean): void {
  expect(status.reason).toBe(reason);
  expect(TROUBLESHOOTING_ANCHORS).toContain(reason);
  if (linked) expect(status.docsUrl).toBe(`${TROUBLESHOOTING_PAGE_URL}#${reason}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The URL itself ──────────────────────────────────────────────────────────

describe('links point at the published page', () => {
  it('the realtime docs base URL is the published troubleshooting page', () => {
    expect(REALTIME_DOCS_BASE_URL).toBe(TROUBLESHOOTING_PAGE_URL);
  });

  it("the sign-in origin error links the page's origin_not_allowed entry", () => {
    expect(ORIGIN_NOT_ALLOWED_DOCS_URL).toBe(`${TROUBLESHOOTING_PAGE_URL}#origin_not_allowed`);
    expect(TROUBLESHOOTING_ANCHORS).toContain('origin_not_allowed');
  });
});

// ── Refused connection: client-side pre-checks and fallbacks ────────────────

describe('refused connection — every client-side reason has an entry', () => {
  const cases: Array<{ reason: string; token: string | null; anonymous?: boolean }> = [
    { reason: 'expired', token: bridgeToken({ exp: nowSec() - 60 }) },
    { reason: 'wrong_environment', token: bridgeToken({ iss: 'https://api.other.local/auth' }) },
    { reason: 'wrong_app', token: bridgeToken({ aid: 'app-2' }) },
    { reason: 'malformed', token: 'not-a-jwt' },
    { reason: 'no_token', token: null },
    // Token passes every pre-check and Bridge can't say why (diagnose 404).
    { reason: 'refused', token: bridgeToken() },
    { reason: 'anonymous_refused', token: null, anonymous: true },
  ];
  for (const c of cases) {
    it(c.reason, async () => {
      const client = setup({ token: c.token, anonymous: c.anonymous });
      await client.start();
      refuseConnect(lastWs());
      await flush();
      expect(client.getState()).toBe('unauthorized');
      expectPublished(client.getStatus(), c.reason, true);
    });
  }
});

// ── Refusals Bridge explains (/realtime/diagnose) ───────────────────────────

describe('every reason Bridge can send has an entry', () => {
  it.each(BRIDGE_SERVER_REASONS)('refused connection, Bridge says %s', async (reason) => {
    const client = setup({ routes: { '/realtime/diagnose': verdict(reason) } });
    await client.start();
    refuseConnect(lastWs());
    await flush();
    expect(client.getState()).toBe('unauthorized');
    expectPublished(client.getStatus(), reason, true);
  });

  it.each(BRIDGE_SERVER_REASONS)('refused channel, Bridge says %s', async (reason) => {
    vi.stubGlobal('location', { origin: 'http://localhost:5180' });
    const client = setup({ token: null, anonymous: true, routes: { '/realtime/diagnose': verdict(reason) } });
    await client.start();
    answerSubscribes(lastWs(), UNAUTHORIZED);
    await flush();
    expect(client.getState()).toBe('degraded');
    expectPublished(client.getStatus(), reason, true);
  });
});

// ── Connection faults (status only; no console link) ────────────────────────

describe('connection faults have entries too', () => {
  it('setup_failed — Bridge unreachable while setting up', async () => {
    const client = setup({
      routes: {
        '/realtime/config': () => {
          throw new Error('fetch failed');
        },
      },
    });
    await client.start();
    await flush();
    expectPublished(client.getStatus(), 'setup_failed', false);
  });

  it('server_error — the realtime server reports a non-auth error', async () => {
    const client = setup();
    await client.start();
    const ws = lastWs();
    ws.triggerOpen();
    ws.triggerMessage({ type: 'error', errors: [{ errorType: 'InternalFailureException', message: 'boom' }] });
    await flush();
    expectPublished(client.getStatus(), 'server_error', false);
  });

  it('connection_lost — an open connection drops', async () => {
    const client = setup();
    await client.start();
    answerSubscribes(lastWs(), null);
    expect(client.getState()).toBe('open');
    lastWs().close();
    await flush();
    expectPublished(client.getStatus(), 'connection_lost', false);
  });

  it('no_channel_accepted — connected, every channel refused, no explanation', async () => {
    const client = setup({ diagnose: false });
    await client.start();
    answerSubscribes(lastWs(), UNAUTHORIZED);
    await flush();
    expect(client.getState()).toBe('degraded');
    expectPublished(client.getStatus(), 'no_channel_accepted', false);
  });
});

// ── Drift guard: a reason added to the client later ─────────────────────────

describe('no reason in the realtime client is missing from the page', () => {
  it('every reason literal in realtime.ts is a published anchor', () => {
    const src = readFileSync(fileURLToPath(new URL('../../flags/realtime.ts', import.meta.url)), 'utf-8');
    const found = new Set<string>();
    // `reason: 'x'` — skipping type unions such as `reason: 'a' | 'b'` (message kinds, not statuses).
    for (const m of src.matchAll(/reason: '([a-z0-9_]+)'(?!\s*\|)/g)) found.add(m[1]);
    for (const m of src.matchAll(/beginTransient\(\s*'([a-z0-9_]+)'/g)) found.add(m[1]);

    // Never pass on an empty scan: these are emitted today and must be seen.
    for (const known of ['no_token', 'refused', 'anonymous_refused', 'setup_failed', 'server_error', 'connection_lost', 'no_channel_accepted']) {
      expect(found).toContain(known);
    }
    const missing = [...found].filter((r) => !TROUBLESHOOTING_ANCHORS.includes(r));
    expect(missing, 'add an entry to the bridge-web troubleshooting page, then the anchor to the fixture').toEqual([]);
  });
});

// ── Optional: the fixture against the live page ─────────────────────────────

describe.skipIf(!process.env.BRIDGE_DOCS_LIVE_CHECK)('live page (BRIDGE_DOCS_LIVE_CHECK=1)', () => {
  it('is served and publishes every anchor', async () => {
    vi.useRealTimers();
    const res = await fetch(TROUBLESHOOTING_PAGE_URL);
    expect(res.status).toBe(200);
    const html = await res.text();
    const missing = TROUBLESHOOTING_ANCHORS.filter((a) => !html.includes(`id="${a}"`));
    expect(missing).toEqual([]);
  }, 30_000);
});
