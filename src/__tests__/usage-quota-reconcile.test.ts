import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// TBP-700 — `bridge.usage.report()` → the quota the page shows.
//
// The `quota.updated` push for a report can be lost (AppSync Events accepts
// the publish and does not deliver it to a subscription made just after the
// client's previous connection closed). These tests pin the wiring that makes
// the reporting page recover on its own: BridgeAuth hands every accepted
// metric to the quota store, which reads the server when no push came.
// ---------------------------------------------------------------------------

vi.mock('../http.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
  },
}));

import { BridgeAuth } from '../bridge-auth.js';
import { MemoryAdapter } from '../token-storage.js';
import { httpFetch } from '../http.js';
import { useBridge, __resetUseBridgeForTests } from '../billing/use-bridge.js';

const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;

describe('usage report → quota reconcile (TBP-700)', () => {
  // Real timers: BridgeAuth's reporter persists through the default durable
  // storage, whose I/O fake timers do not drive.
  beforeEach(() => {
    vi.resetAllMocks();
    __resetUseBridgeForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetUseBridgeForTests();
  });

  it('a report Bridge accepts brings the shown quota up to date even when its push is lost', async () => {
    // The page shows 80 of 200, read before the report.
    const quotas = useBridge().quotas;
    quotas.configure({ apiBaseUrl: 'https://api.test.com', accessToken: 'access-tok', appId: 'test-app' });
    quotas.applyInitialSnapshot('demo.metric', {
      metric: 'demo.metric', used: 80, limit: 200, remaining: 120, warningLevel: null, policy: 'metered',
    });

    // Signed in, so the reporter sends; the ingest is accepted.
    const ingest = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', ingest);
    const auth = new BridgeAuth({
      appId: 'test-app',
      apiBaseUrl: 'https://api.test.com',
      hostedUrl: 'https://hosted.test.com',
      callbackUrl: 'https://myapp.com/callback',
      storage: new MemoryAdapter(),
      debug: false,
    });
    vi.spyOn(
      (auth as unknown as { tokenManager: { getTokens: () => unknown } }).tokenManager,
      'getTokens',
    ).mockReturnValue({ accessToken: 'access-tok' });

    // What the server answers once the report is counted.
    mockHttpFetch.mockResolvedValue({
      metric: 'demo.metric', used: 120, limit: 200, remaining: 80, warningLevel: null, policy: 'metered',
    });

    auth.usage.report('demo.metric', 40);
    // Reporter debounce (1 s) → POST /usage/ingest, accepted.
    const ingestCalls = () => ingest.mock.calls.filter(([url]) => String(url).endsWith('/usage/ingest'));
    await vi.waitFor(() => expect(ingestCalls()).toHaveLength(1), { timeout: 3000 });
    expect(JSON.parse(ingestCalls()[0][1].body)).toMatchObject({ metric: 'demo.metric', value: 40 });
    expect(quotas.get('demo.metric')!.used).toBe(80);

    // No quota.updated push arrives; the store reads the server instead.
    await vi.waitFor(() => expect(quotas.get('demo.metric')!.used).toBe(120), { timeout: 3000 });
    expect(mockHttpFetch).toHaveBeenCalledWith(
      'https://api.test.com/usage/quota/demo.metric',
      expect.objectContaining({ method: 'GET' }),
      expect.anything(),
    );
    auth.destroy();
  }, 10_000);
});
