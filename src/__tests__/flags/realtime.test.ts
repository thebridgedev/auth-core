import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeFlags } from '../../flags/flag.js';
import {
  RealtimeClient,
  type WebSocketLike,
  type UserStateMessage,
  type SessionSnapshotMessage,
} from '../../flags/realtime.js';

// ── Fake WebSocket factory ──────────────────────────────────────────────────

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
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

// ── Mock fetch ──────────────────────────────────────────────────────────────

const mkFetch = (responses: Record<string, (init: any) => any>): typeof fetch => {
  return (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    const responder = responses[path];
    if (!responder) {
      return new Response(JSON.stringify({ kind: 'noop' }), { status: 404 });
    }
    const body = responder(init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
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

describe('RealtimeClient — disabled / noop server', () => {
  it('does nothing when enabled=false', async () => {
    const client = new RealtimeClient({
      ...CONFIG,
      enabled: false,
      fetchFn: mkFetch({}),
    });
    await client.start();
    expect(client.getState()).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does not connect when server reports noop adapter', async () => {
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => ({ kind: 'noop' }),
      }),
    });
    await client.start();
    expect(client.getState()).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('closes cleanly when server reports an unknown protocol', async () => {
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => ({ kind: 'mqtt' as any, endpoint: 'wss://x' }),
      }),
    });
    await client.start();
    expect(client.getState()).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('RealtimeClient — channel selection (Phase 2, TBP-307)', () => {
  it('subscribes to all three channels when appId + workspaceId + userId are set', () => {
    const client = new RealtimeClient({ ...CONFIG, appId: 'app-1' });
    expect(client.channelsToSubscribe()).toEqual([
      'app:app-1',
      'workspace:ws-1',
      'user:u-1',
    ]);
  });

  it('falls back to workspace + user (two-part) when no appId is configured', () => {
    // Backward-compat: pre-Phase-2 callers pass workspaceId only (= appId in
    // the old topology). SDK skips the app channel but still hits the
    // workspace channel where server keeps dual-publishing during the shim.
    const client = new RealtimeClient(CONFIG);
    expect(client.channelsToSubscribe()).toEqual(['workspace:ws-1', 'user:u-1']);
  });

  it('skips user channel when no userId', () => {
    const client = new RealtimeClient({ ...CONFIG, appId: 'app-1', userId: undefined });
    expect(client.channelsToSubscribe()).toEqual(['app:app-1', 'workspace:ws-1']);
  });

  it('subscribes to nothing when no ids at all', () => {
    const client = new RealtimeClient({
      ...CONFIG,
      workspaceId: undefined,
      userId: undefined,
    });
    expect(client.channelsToSubscribe()).toEqual([]);
  });

  it('emits only app channel when appId is the only id', () => {
    const client = new RealtimeClient({
      ...CONFIG,
      appId: 'app-1',
      workspaceId: undefined,
      userId: undefined,
    });
    expect(client.channelsToSubscribe()).toEqual(['app:app-1']);
  });
});

describe('RealtimeClient — setAppId / setWorkspaceId (Phase 2, TBP-307)', () => {
  it('setAppId() is a no-op when value unchanged', () => {
    const client = new RealtimeClient({ ...CONFIG, appId: 'app-1' });
    const before = client.channelsToSubscribe();
    client.setAppId('app-1');
    expect(client.channelsToSubscribe()).toEqual(before);
  });

  it('setAppId() updates the channels list when value changes', () => {
    const client = new RealtimeClient({ ...CONFIG, appId: 'app-1' });
    client.setAppId('app-2');
    expect(client.channelsToSubscribe()).toContain('app:app-2');
    expect(client.channelsToSubscribe()).not.toContain('app:app-1');
  });

  it('setWorkspaceId() updates the channels list when value changes', () => {
    const client = new RealtimeClient({ ...CONFIG, appId: 'app-1' });
    client.setWorkspaceId('ws-2');
    expect(client.channelsToSubscribe()).toContain('workspace:ws-2');
    expect(client.channelsToSubscribe()).not.toContain('workspace:ws-1');
  });
});

describe('RealtimeClient — Centrifugo handshake', () => {
  it('fetches config + authorize, opens WS, sends connect token', async () => {
    const fetchSpy = vi.fn(
      mkFetch({
        '/realtime/config': () => ({
          kind: 'centrifugo',
          endpoint: 'wss://realtime.test.local/connection/websocket',
          protocol: 'wss',
        }),
        '/realtime/authorize': () => ({
          allowed: ['workspace:ws-1', 'user:ws-1:u-1'],
          denied: [],
          signedToken: 'sig.token.abc',
          expiresAt: Date.now() + 60_000,
        }),
      }),
    );
    const client = new RealtimeClient({ ...CONFIG, fetchFn: fetchSpy });
    await client.start();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://realtime.test.local/connection/websocket');

    ws.triggerOpen();
    expect(client.getState()).toBe('open');
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ id: 1, connect: { token: 'sig.token.abc' } });
  });

  it('closes when config fetch fails', async () => {
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => new Response('boom', { status: 500 }),
      }),
    });
    await client.start();
    expect(client.getState()).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('closes when authorize fails', async () => {
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
        '/realtime/authorize': () => new Response('nope', { status: 401 }),
      }),
    });
    await client.start();
    expect(client.getState()).toBe('closed');
  });
});

describe('RealtimeClient — message handling', () => {
  const setupOpen = async (): Promise<{ client: RealtimeClient; ws: FakeWebSocket; bridge: BridgeFlags }> => {
    const bridge = new BridgeFlags();
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
        '/realtime/authorize': () => ({ allowed: [], denied: [], signedToken: 't', expiresAt: Date.now() + 1000 }),
      }),
    });
    client.attach(bridge);
    await client.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    return { client, ws, bridge };
  };

  it('flag.updated → upserts the cache', async () => {
    const { ws, bridge } = await setupOpen();
    ws.triggerMessage({
      kind: 'flag.updated',
      flag: {
        key: 'dark_mode',
        state: 'on',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
      },
    });
    expect(bridge.flag('dark_mode', false).value).toBe(true);
  });

  it('flag.removed → removes from cache', async () => {
    const { ws, bridge } = await setupOpen();
    bridge.upsert({
      key: 'old_flag',
      state: 'on',
      valueType: 'boolean',
      offValue: false,
      onValue: true,
    });
    ws.triggerMessage({ kind: 'flag.removed', key: 'old_flag' });
    expect(bridge.flag('old_flag', 'fallback').value).toBe('fallback');
  });

  it('user.state_changed → fires onUserState hook', async () => {
    const { client, ws } = await setupOpen();
    const onUserState = vi.fn();
    client.setOnUserState(onUserState);
    ws.triggerMessage({ kind: 'user.state_changed', reason: 'token_invalidated' });
    expect(onUserState).toHaveBeenCalledTimes(1);
    expect((onUserState.mock.calls[0][0] as UserStateMessage).reason).toBe('token_invalidated');
  });

  it('unwraps Centrifugo push.pub.data envelope', async () => {
    const { ws, bridge } = await setupOpen();
    ws.triggerMessage({
      push: {
        channel: 'workspace:ws-1',
        pub: {
          data: {
            kind: 'flag.updated',
            flag: { key: 'wrapped', state: 'on', valueType: 'boolean', offValue: false, onValue: true },
          },
        },
      },
    });
    expect(bridge.flag('wrapped', false).value).toBe(true);
  });

  it('ignores malformed messages', async () => {
    const { ws, bridge } = await setupOpen();
    ws.triggerMessage('not json');
    ws.triggerMessage({ no_kind: 'here' });
    // bridge unaffected
    expect(bridge.cacheSize()).toBe(0);
  });
});

describe('RealtimeClient — session.snapshot (Phase 3, TBP-287/314)', () => {
  const setupOpenSnapshot = async (): Promise<{ client: RealtimeClient; ws: FakeWebSocket }> => {
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
        '/realtime/authorize': () => ({ allowed: [], denied: [], signedToken: 't', expiresAt: Date.now() + 1000 }),
      }),
    });
    await client.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    return { client, ws };
  };

  const sampleSnapshot = {
    kind: 'session.snapshot' as const,
    data: {
      app: {
        branding: { logo: 'logo.png', name: 'Acme', primaryButtonBgColor: '#000' },
      },
      tenant: {
        id: 'ws-1',
        name: 'My Workspace',
        subscription: { plan: { slug: 'pro', name: 'Pro' }, status: 'active' },
        entitlements: { app_active: true, ai_completions: true },
      },
      user: { id: 'u-1', email: 'u@ex.com', role: 'owner', tenantId: 'ws-1' },
    },
  };

  it('fires the registered hook with the snapshot payload verbatim', async () => {
    const { client, ws } = await setupOpenSnapshot();
    const onSnapshot = vi.fn();
    client.setOnSnapshot(onSnapshot);
    ws.triggerMessage(sampleSnapshot);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect((onSnapshot.mock.calls[0][0] as SessionSnapshotMessage).data).toEqual(sampleSnapshot.data);
  });

  it('unwraps Centrifugo push.pub.data envelope for session.snapshot too', async () => {
    const { client, ws } = await setupOpenSnapshot();
    const onSnapshot = vi.fn();
    client.setOnSnapshot(onSnapshot);
    ws.triggerMessage({
      push: { channel: 'user:u-1', pub: { data: sampleSnapshot } },
    });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect((onSnapshot.mock.calls[0][0] as SessionSnapshotMessage).data.tenant.id).toBe('ws-1');
  });

  it('does not fire when no hook is registered (silent no-op)', async () => {
    const { ws } = await setupOpenSnapshot();
    // No client.setOnSnapshot — message must not throw.
    expect(() => ws.triggerMessage(sampleSnapshot)).not.toThrow();
  });

  it('skips the hook when the data field is missing (defensive)', async () => {
    const { client, ws } = await setupOpenSnapshot();
    const onSnapshot = vi.fn();
    client.setOnSnapshot(onSnapshot);
    ws.triggerMessage({ kind: 'session.snapshot' }); // no data
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by the hook (matches other dispatch handlers)', async () => {
    const { client, ws } = await setupOpenSnapshot();
    client.setOnSnapshot(() => {
      throw new Error('hook boom');
    });
    // Subsequent messages must still process.
    expect(() => ws.triggerMessage(sampleSnapshot)).not.toThrow();
  });

  it('fires on every snapshot — reconnect re-emits, hook fires again', async () => {
    const { client, ws } = await setupOpenSnapshot();
    const onSnapshot = vi.fn();
    client.setOnSnapshot(onSnapshot);
    ws.triggerMessage(sampleSnapshot);
    ws.triggerMessage(sampleSnapshot);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('RealtimeClient — reconnect', () => {
  it('schedules reconnect on unexpected close', async () => {
    const fetchFn = mkFetch({
      '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
      '/realtime/authorize': () => ({ allowed: [], denied: [], signedToken: 't', expiresAt: 1 }),
    });
    const client = new RealtimeClient({ ...CONFIG, fetchFn, reconnectBaseMs: 100 });
    await client.start();
    const first = FakeWebSocket.instances[0];
    first.triggerOpen();
    first.close(); // unexpected
    expect(client.getState()).toBe('closed');
    // runAllTimersAsync flushes timers *and* awaits async work in the timer
    // callbacks (our reconnect path is fetch + ws-factory, both async).
    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('stop() prevents further reconnect', async () => {
    const fetchFn = mkFetch({
      '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
      '/realtime/authorize': () => ({ allowed: [], denied: [], signedToken: 't', expiresAt: 1 }),
    });
    const client = new RealtimeClient({ ...CONFIG, fetchFn, reconnectBaseMs: 50 });
    await client.start();
    await client.stop();
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    // first ws was created; no reconnects after stop
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

describe('RealtimeClient — Centrifugo keepalive ping', () => {
  const setupOpen = async (): Promise<{ client: RealtimeClient; ws: FakeWebSocket; bridge: BridgeFlags }> => {
    const bridge = new BridgeFlags();
    const client = new RealtimeClient({
      ...CONFIG,
      fetchFn: mkFetch({
        '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
        '/realtime/authorize': () => ({ allowed: [], denied: [], signedToken: 't', expiresAt: Date.now() + 1000 }),
      }),
    });
    client.attach(bridge);
    await client.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    return { client, ws, bridge };
  };

  it('echoes "{}" back when the server sends a "{}" keepalive ping', async () => {
    const { ws } = await setupOpen();
    // First sent frame is the connect command; reset to isolate the pong.
    ws.sent.length = 0;
    ws.triggerMessage('{}');
    expect(ws.sent).toEqual(['{}']);
  });

  it('keepalive ping does not dispatch as a RealtimeMessage (hooks unaffected, bridge unchanged)', async () => {
    const { client, ws, bridge } = await setupOpen();
    const onUserState = vi.fn();
    const onSnapshot = vi.fn();
    client.setOnUserState(onUserState);
    client.setOnSnapshot(onSnapshot);
    ws.sent.length = 0;

    ws.triggerMessage('{}');

    expect(onUserState).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(bridge.cacheSize()).toBe(0);
    // Exactly one pong went out — no extra side-effects.
    expect(ws.sent).toEqual(['{}']);
  });

  it('normal flag.updated push still routes after a keepalive ping', async () => {
    const { ws, bridge } = await setupOpen();
    ws.sent.length = 0;

    // Ping first…
    ws.triggerMessage('{}');
    expect(ws.sent).toEqual(['{}']);

    // …then a real push on the same socket. Bridge should upsert as usual.
    ws.triggerMessage({
      kind: 'flag.updated',
      flag: {
        key: 'after_ping',
        state: 'on',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
      },
    });
    expect(bridge.flag('after_ping', false).value).toBe(true);
    // No further sends triggered by the data frame.
    expect(ws.sent).toEqual(['{}']);
  });
});

describe('RealtimeClient — AppSync Events handshake (TBP-148)', () => {
  const APPSYNC_HOST = 'svc.appsync-realtime-api.eu-west-1.amazonaws.com';
  // The HTTP host is what AppSync expects in the auth header's `host` field,
  // not the realtime host — see normalizeAppSyncEndpoint() comment.
  const APPSYNC_HTTP_HOST = 'svc.appsync-api.eu-west-1.amazonaws.com';
  const APPSYNC_FULL = `wss://${APPSYNC_HOST}/event/realtime`;

  function decodeHeaderProtocol(protocols: string | string[] | undefined): {
    Authorization: string;
    host: string;
  } | null {
    if (!protocols) return null;
    const list = Array.isArray(protocols) ? protocols : [protocols];
    const header = list.find((p) => p.startsWith('header-'));
    if (!header) return null;
    const b64 = header.slice('header-'.length);
    // base64url → base64 (pad)
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
    const decoded = atob(padded);
    // Reverse the UTF-8 encoding step in base64urlEncode
    const utf8 = decodeURIComponent(escape(decoded));
    return JSON.parse(utf8);
  }

  async function setupAppSyncOpen(
    overrides: Partial<{
      endpoint: string;
      getAuthToken: () => string | undefined;
      appId: string;
      workspaceId?: string;
      userId?: string;
    }> = {},
  ): Promise<{ ws: FakeWebSocket; client: RealtimeClient }> {
    const endpoint = overrides.endpoint ?? APPSYNC_HOST; // bare host (stage CFN shape)
    const client = new RealtimeClient({
      ...CONFIG,
      appId: overrides.appId ?? 'app-1',
      workspaceId: overrides.workspaceId,
      userId: overrides.userId,
      fetchFn: mkFetch({
        '/realtime/config': () => ({
          kind: 'appsync',
          endpoint,
          protocol: 'appsync-events',
          params: { region: 'eu-west-1', apiId: 'svc' },
        }),
      }),
      getAuthToken: overrides.getAuthToken,
    });
    await client.start();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    return { ws, client };
  }

  it('normalizes a bare host into wss://…/event/realtime and negotiates the two subprotocols', async () => {
    const { ws } = await setupAppSyncOpen();
    expect(ws.url).toBe(APPSYNC_FULL);
    expect(Array.isArray(ws.protocols)).toBe(true);
    const protocols = ws.protocols as string[];
    expect(protocols[0]).toBe('aws-appsync-event-ws');
    expect(protocols[1].startsWith('header-')).toBe(true);
  });

  it('accepts an already-normalized wss URL and does not double-append the path', async () => {
    const { ws } = await setupAppSyncOpen({ endpoint: APPSYNC_FULL });
    expect(ws.url).toBe(APPSYNC_FULL);
  });

  it('builds an anonymous auth header when getAuthToken is undefined (Authorization: empty, host: HTTP endpoint)', async () => {
    const { ws } = await setupAppSyncOpen({ getAuthToken: undefined });
    const auth = decodeHeaderProtocol(ws.protocols);
    // AWS spec — `host` is always the HTTP endpoint, even when wss:// targets
    // the realtime endpoint. Server-side validation depends on this.
    expect(auth).toEqual({ Authorization: '', host: APPSYNC_HTTP_HOST });
  });

  it('builds an authenticated auth header when getAuthToken returns a JWT', async () => {
    const { ws } = await setupAppSyncOpen({ getAuthToken: () => 'jwt.value.abc' });
    const auth = decodeHeaderProtocol(ws.protocols);
    expect(auth).toEqual({ Authorization: 'Bearer jwt.value.abc', host: APPSYNC_HTTP_HOST });
  });

  it('sends connection_init on WS open, defers state=open until connection_ack', async () => {
    const { ws, client } = await setupAppSyncOpen();
    ws.triggerOpen();
    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'connection_init' }));
    // Still 'connecting' — the ack hasn't landed.
    expect(client.getState()).toBe('connecting');
  });

  it('sends one subscribe frame per channel after connection_ack, with `/` separator on the wire', async () => {
    const { ws, client } = await setupAppSyncOpen({
      appId: 'app-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      getAuthToken: () => 'jwt-x',
    });
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack', connectionTimeoutMs: 30_000 });

    expect(client.getState()).toBe('open');
    // 1 connection_init + 3 subscribes
    expect(ws.sent.length).toBe(4);
    const subs = ws.sent.slice(1).map((s) => JSON.parse(s));
    expect(subs.map((m) => m.type)).toEqual(['subscribe', 'subscribe', 'subscribe']);
    expect(subs.map((m) => m.channel)).toEqual(['app/app-1', 'workspace/ws-1', 'user/u-1']);
    for (const sub of subs) {
      expect(typeof sub.id).toBe('string');
      expect(sub.authorization).toEqual({
        Authorization: 'Bearer jwt-x',
        host: APPSYNC_HTTP_HOST,
      });
    }
  });

  it('dispatches data frames where `event` is an array (per AWS spec)', async () => {
    const { ws, client } = await setupAppSyncOpen({ appId: 'demo-app' });
    const bridge = new BridgeFlags();
    client.attach(bridge);
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack' });

    // Per spec, `event` is an array of JSON-encoded strings.
    ws.triggerMessage({
      type: 'data',
      id: 'sub-1',
      event: [
        JSON.stringify({
          kind: 'flag.updated',
          flag: {
            key: 'theme',
            state: 'on',
            valueType: 'string',
            offValue: 'light',
            onValue: 'dark',
          },
        }),
      ],
    });
    expect(bridge.flag('theme', 'light').value).toBe('dark');
  });

  it('also accepts a legacy single-string `event` for backward compat', async () => {
    const { ws, client } = await setupAppSyncOpen({ appId: 'demo-app' });
    const bridge = new BridgeFlags();
    client.attach(bridge);
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack' });
    ws.triggerMessage({
      type: 'data',
      id: 'sub-1',
      event: JSON.stringify({
        kind: 'flag.updated',
        flag: {
          key: 'legacy',
          state: 'on',
          valueType: 'boolean',
          offValue: false,
          onValue: true,
        },
      }),
    });
    expect(bridge.flag('legacy', false).value).toBe(true);
  });

  it('silently ignores ka keepalives (no client response, no state change)', async () => {
    const { ws, client } = await setupAppSyncOpen();
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack' });
    const sentBefore = ws.sent.length;
    ws.triggerMessage({ type: 'ka' });
    expect(ws.sent.length).toBe(sentBefore); // no response sent
    expect(client.getState()).toBe('open');
  });

  it('closes the socket on a server `error` frame so onclose drives reconnect', async () => {
    const { ws, client } = await setupAppSyncOpen();
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack' });
    ws.triggerMessage({ type: 'error', errors: [{ message: 'auth failed' }] });
    expect(ws.readyState).toBe(3); // CLOSED
    expect(client.getState()).toBe('closed');
  });

  it('ignores unknown frame types without breaking the connection', async () => {
    const { ws, client } = await setupAppSyncOpen();
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack' });
    ws.triggerMessage({ type: 'pong' }); // hypothetical future frame
    expect(client.getState()).toBe('open');
  });

  it('re-uses the current getAuthToken value when reauthorize() runs (post-rotation JWT)', async () => {
    let token = 'jwt-old';
    const { ws, client } = await setupAppSyncOpen({ getAuthToken: () => token });
    ws.triggerOpen();
    ws.triggerMessage({ type: 'connection_ack' });
    expect(decodeHeaderProtocol(ws.protocols)?.Authorization).toBe('Bearer jwt-old');

    // Rotate the token and reauthorize → new context creates a fresh WS with
    // the new value in the subprotocol header.
    token = 'jwt-new';
    await client.reauthorize();

    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws2).not.toBe(ws);
    expect(decodeHeaderProtocol(ws2.protocols)?.Authorization).toBe('Bearer jwt-new');
  });
});
