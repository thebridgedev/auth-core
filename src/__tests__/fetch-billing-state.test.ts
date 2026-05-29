// Billing 2.0 / US-2 — `fetchBillingState` is the pure, isomorphic read of
// `GET /billing/state`. It wires Authorization + x-app-id headers and returns
// the parsed state. We mock the global `fetch` (NOT httpFetch) so we can assert
// the exact URL + headers that leave the SDK, and confirm parsing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchBillingState } from '../billing/fetch-billing-state.js';
import type { BillingSubscriptionState, MountOptions } from '../billing/types.js';
import type { Logger } from '../logger.js';

const noopLogger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const MOUNT_OPTS: MountOptions = {
  apiBaseUrl: 'https://api.example.com',
  accessToken: 'access-tok-123',
  appId: 'app-42',
};

const STATE: BillingSubscriptionState = {
  plan: { slug: 'pro', name: 'Pro' },
  status: 'active',
};

function makeOkResponse(jsonBody: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(jsonBody),
    text: vi.fn().mockResolvedValue(JSON.stringify(jsonBody)),
  } as unknown as Response;
}

describe('fetchBillingState', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as any).fetch = undefined;
  });

  it('issues a GET to `${apiBaseUrl}/billing/state`', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOkResponse(STATE));

    await fetchBillingState(MOUNT_OPTS, noopLogger);

    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe('https://api.example.com/billing/state');
    expect(init.method).toBe('GET');
  });

  it('sends the Authorization bearer header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOkResponse(STATE));

    await fetchBillingState(MOUNT_OPTS, noopLogger);

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer access-tok-123' });
  });

  it('sends the x-app-id header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOkResponse(STATE));

    await fetchBillingState(MOUNT_OPTS, noopLogger);

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toMatchObject({ 'x-app-id': 'app-42' });
  });

  it('returns the parsed billing state', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOkResponse(STATE));

    const result = await fetchBillingState(MOUNT_OPTS, noopLogger);
    expect(result).toEqual(STATE);
  });

  it('works without an explicit logger (defaults to a noop logger)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(makeOkResponse(STATE));

    const result = await fetchBillingState(MOUNT_OPTS);
    expect(result).toEqual(STATE);
  });
});
