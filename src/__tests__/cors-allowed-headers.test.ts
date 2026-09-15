// TBP-669 — every request header auth-core sends to Bridge from a browser
// must be in bridge-api's CORS allow-list. One unlisted header fails the
// preflight: the request never leaves the browser (net::ERR_FAILED), and a
// unit test that mocks fetch can't see it. That is how `x-bridge-realtime-ref`
// on POST /realtime/diagnose shipped in 0.7.0-beta.0 and broke every
// diagnosed realtime refusal in every browser.
//
// The allow-list is a checked-in copy: fixtures/bridge-api-cors-allowed-headers.ts
// (source and update rule are documented there).
//
// Two checks:
//   1. Behaviour: the realtime client's refusal path (the one that broke)
//      really calls /realtime/diagnose, and every header it sends is allowed.
//   2. Sweep: every header name written into a request anywhere in the
//      browser-reachable source is allowed. This catches the next new header
//      on any code path, not only the ones test 1 drives.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from '../flags/realtime.js';
import { BRIDGE_API_CORS_ALLOWED_HEADERS } from './fixtures/bridge-api-cors-allowed-headers.js';

// Header names are case-insensitive on the wire.
const ALLOWED = new Set(BRIDGE_API_CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase()));
const notAllowed = (names: Iterable<string>) => [...names].filter((n) => !ALLOWED.has(n.toLowerCase()));

// ── 1. behaviour: the diagnose call ─────────────────────────────────────────

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const API = 'https://api.test.local';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  return `${b64(JSON.stringify({ alg: 'PS256' }))}.${b64(JSON.stringify(claims))}.sig`;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('realtime refusal → /realtime/diagnose sends only CORS-allowed headers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it('every header on every request the refusal path makes is in bridge-api’s allow-list', async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init: any) => {
      const path = new URL(url).pathname;
      calls.push({ path, headers: { ...(init?.headers ?? {}) } });
      if (path === '/realtime/config') {
        return { ok: true, status: 200, json: async () => ({ kind: 'appsync', endpoint: 'svc.appsync-realtime-api.eu-west-1.amazonaws.com' }) };
      }
      if (path === '/realtime/diagnose') {
        return { ok: true, status: 200, json: async () => ({ ok: false, reason: 'origin_not_allowed', side: 'config' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const token = jwt({ iss: `${API}/auth`, aid: 'app-1', sub: 'u-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const client = new RealtimeClient({
      apiBaseUrl: API,
      apiKey: 'test-api-key',
      appId: 'app-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      websocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
      fetchFn,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getAuthToken: () => token,
    });

    await client.start();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.readyState = 1;
    ws.onopen?.({});
    ws.onmessage?.({
      data: JSON.stringify({ type: 'connection_error', errors: [{ errorType: 'UnauthorizedException', errorCode: 401 }] }),
    });
    await flush();

    // Not vacuous: the call that broke really happened, and its verdict landed.
    const diagnose = calls.filter((c) => c.path === '/realtime/diagnose');
    expect(diagnose).toHaveLength(1);
    expect(client.getStatus()).toMatchObject({ reason: 'origin_not_allowed', side: 'config' });

    for (const call of calls) {
      expect({ path: call.path, notAllowed: notAllowed(Object.keys(call.headers)) }).toEqual({
        path: call.path,
        notAllowed: [],
      });
    }
  });
});

// ── 2. sweep: every header name the browser-side source sends ───────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// Server-only code: never runs in a browser, so CORS never applies. Each
// entry says why. Anything not listed here is treated as browser-reachable.
const SERVER_ONLY = [
  'backend/', // JWKS verification for customer backends
  'management/', // BridgeManagement: x-api-key + x-tenant-id, server-side by contract
  'management-http.ts', // its HTTP client
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

// `'x-foo': …` / `"Authorization": …` object keys, and `headers['x-foo'] =` /
// `headers.Authorization =` assignments.
const HEADER_KEY = /['"]([A-Za-z][A-Za-z0-9-]*)['"]\s*:/g;
const HEADER_ASSIGN = /headers(?:\[['"]([A-Za-z0-9-]+)['"]\]|\.([A-Za-z][A-Za-z0-9]*))\s*=[^=]/g;
// Only header-shaped keys: x-*, or a standard name we know is sent.
const looksLikeHeader = (name: string) => /^x-/i.test(name) || /^(authorization|content-type|accept)$/i.test(name);

function headersSentBy(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const m of text.matchAll(HEADER_KEY)) if (looksLikeHeader(m[1])) found.add(m[1]);
  for (const m of text.matchAll(HEADER_ASSIGN)) found.add(m[1] ?? m[2]);
  return [...found];
}

describe('browser-reachable source sends only CORS-allowed header names', () => {
  const files = sourceFiles(SRC)
    .map((f) => relative(SRC, f).split(sep).join('/'))
    .filter((rel) => !SERVER_ONLY.some((p) => rel === p || rel.startsWith(p)));

  it('finds the headers it is supposed to police (the sweep is not blind)', () => {
    const all = new Set(files.flatMap((rel) => headersSentBy(join(SRC, rel))).map((h) => h.toLowerCase()));
    expect(all).toContain('x-app-id');
    expect(all).toContain('authorization');
    expect(all).toContain('content-type');
  });

  it('no browser-side file writes a header bridge-api would refuse in a preflight', () => {
    const offenders = files
      .map((rel) => ({ file: rel, notAllowed: notAllowed(headersSentBy(join(SRC, rel))) }))
      .filter((o) => o.notAllowed.length > 0);
    expect(offenders).toEqual([]);
  });
});
