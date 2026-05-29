// Billing 2.0 / Phase A / US-3 (TBP-249) — RealtimeClient handling of
// the new `subscription.plan_changed` channel message.
//
// Mirrors the FakeWebSocket / mkFetch pattern used in flags/realtime.test.ts
// so we cover the full transport path: a `subscription.plan_changed` payload
// arriving on the workspace channel must invoke the hook registered via
// `setOnSubscriptionPlanChanged()`. We also negative-test that a `flag.updated`
// message does NOT cross-fire the subscription hook.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeClient,
  type SubscriptionPlanChangedMessage,
  type WebSocketLike,
} from '../../flags/realtime.js';

// ── Fake WebSocket factory ──────────────────────────────────────────────────

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
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

const fakeWsFactory = (url: string): WebSocketLike => new FakeWebSocket(url);

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

const FETCH_RESPONSES = mkFetch({
  '/realtime/config': () => ({ kind: 'centrifugo', endpoint: 'wss://x' }),
  '/realtime/authorize': () => ({
    allowed: [],
    denied: [],
    signedToken: 't',
    expiresAt: Date.now() + 1000,
  }),
});

const setupOpen = async (): Promise<{ client: RealtimeClient; ws: FakeWebSocket }> => {
  const client = new RealtimeClient({
    ...CONFIG,
    fetchFn: FETCH_RESPONSES,
  });
  await client.start();
  const ws = FakeWebSocket.instances[0];
  ws.triggerOpen();
  return { client, ws };
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient — subscription.plan_changed', () => {
  it('invokes the onSubscriptionPlanChanged hook with the message payload', async () => {
    const { client, ws } = await setupOpen();
    const onPlanChanged = vi.fn();
    client.setOnSubscriptionPlanChanged(onPlanChanged);

    const payload: SubscriptionPlanChangedMessage = {
      kind: 'subscription.plan_changed',
      tenantId: 'tenant-1',
      from: { slug: 'free' },
      to: { slug: 'pro', name: 'Pro' },
      status: 'active',
      effectiveAt: '2026-05-19T12:00:00.000Z',
    };
    ws.triggerMessage(payload);

    expect(onPlanChanged).toHaveBeenCalledTimes(1);
    expect(onPlanChanged.mock.calls[0][0]).toEqual(payload);
  });

  it('unwraps Centrifugo push.pub.data envelope for plan_changed messages', async () => {
    const { client, ws } = await setupOpen();
    const onPlanChanged = vi.fn();
    client.setOnSubscriptionPlanChanged(onPlanChanged);

    ws.triggerMessage({
      push: {
        channel: 'workspace:ws-1',
        pub: {
          data: {
            kind: 'subscription.plan_changed',
            tenantId: 'tenant-1',
            from: { slug: 'free' },
            to: { slug: 'enterprise', name: 'Enterprise' },
            status: 'trial',
            effectiveAt: '2026-05-19T12:00:00.000Z',
          },
        },
      },
    });

    expect(onPlanChanged).toHaveBeenCalledTimes(1);
    expect(onPlanChanged.mock.calls[0][0].to).toEqual({
      slug: 'enterprise',
      name: 'Enterprise',
    });
  });

  it('hook errors are swallowed — the connection stays open', async () => {
    const { client, ws } = await setupOpen();
    const onPlanChanged = vi.fn(() => {
      throw new Error('hook blew up');
    });
    client.setOnSubscriptionPlanChanged(onPlanChanged);

    expect(() =>
      ws.triggerMessage({
        kind: 'subscription.plan_changed',
        tenantId: 'tenant-1',
        from: { slug: 'free' },
        to: { slug: 'pro', name: 'Pro' },
        status: 'active',
        effectiveAt: '2026-05-19T12:00:00.000Z',
      }),
    ).not.toThrow();

    expect(onPlanChanged).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe('open');
  });

  it('flag.updated does NOT cross-fire the subscription hook', async () => {
    const { client, ws } = await setupOpen();
    const onPlanChanged = vi.fn();
    client.setOnSubscriptionPlanChanged(onPlanChanged);

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

    expect(onPlanChanged).not.toHaveBeenCalled();
  });

  it('user.state_changed does NOT cross-fire the subscription hook', async () => {
    const { client, ws } = await setupOpen();
    const onPlanChanged = vi.fn();
    client.setOnSubscriptionPlanChanged(onPlanChanged);

    ws.triggerMessage({ kind: 'user.state_changed', reason: 'token_invalidated' });

    expect(onPlanChanged).not.toHaveBeenCalled();
  });

  it('when no hook is registered, an incoming plan_changed message is silently ignored (no crash)', async () => {
    const { ws } = await setupOpen();
    // No setOnSubscriptionPlanChanged call.

    expect(() =>
      ws.triggerMessage({
        kind: 'subscription.plan_changed',
        tenantId: 'tenant-1',
        from: { slug: 'free' },
        to: { slug: 'pro', name: 'Pro' },
        status: 'active',
        effectiveAt: '2026-05-19T12:00:00.000Z',
      }),
    ).not.toThrow();
  });
});
