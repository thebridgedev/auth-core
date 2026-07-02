import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JwksService, TokenVerificationError } from '../backend/jwks-service.js';
import type { JwksServiceConfig } from '../backend/jwks-service.js';

// ---------------------------------------------------------------------------
// verifyApiToken is now introspection-based: it POSTs { token } to the Bridge
// introspection endpoint and trusts the returned { active, ...claims }. We mock
// global fetch (the same primitive the implementation uses) to drive each case.
// ---------------------------------------------------------------------------

const INTROSPECTION_URL = 'https://api.example.com/account/api-token/introspect';

function makeConfig(overrides: Partial<JwksServiceConfig> = {}): JwksServiceConfig {
  return {
    jwksUrl: 'https://api.example.com/auth/.well-known/jwks.json',
    introspectionUrl: INTROSPECTION_URL,
    issuer: 'https://api.example.com/auth',
    audience: 'app1',
    ...overrides,
  };
}

/** Build a Response-like object for the mocked fetch. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JwksService.verifyApiToken (introspection)', () => {
  it('returns claims for an active token issued for the expected app', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        active: true,
        sub: 'token-id-1',
        appId: 'app1',
        tenantId: null,
        type: 'api',
        privileges: ['USER_READ'],
        exp: 1999999999,
      }),
    );

    const service = new JwksService(makeConfig());
    const claims = await service.verifyApiToken('the-token', 'app1');

    expect(claims).toMatchObject({
      sub: 'token-id-1',
      appId: 'app1',
      tenantId: null,
      type: 'api',
      privileges: ['USER_READ'],
      exp: 1999999999,
    });

    // POSTs the token to the introspection endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(INTROSPECTION_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ token: 'the-token' });
  });

  it('preserves tenantId for a tenant-scoped token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        active: true,
        sub: 'token-id-2',
        appId: 'app1',
        tenantId: 'tenant-9',
        type: 'api',
        privileges: [],
      }),
    );

    const service = new JwksService(makeConfig());
    const claims = await service.verifyApiToken('t', 'app1');
    expect(claims.tenantId).toBe('tenant-9');
  });

  it('throws TOKEN_INVALID when the token is inactive', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ active: false }));

    const service = new JwksService(makeConfig());
    await expect(service.verifyApiToken('dead', 'app1')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('throws TOKEN_INVALID when the token type is not "api"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ active: true, appId: 'app1', type: 'access', sub: 's' }),
    );

    const service = new JwksService(makeConfig());
    await expect(service.verifyApiToken('x', 'app1')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('throws APP_MISMATCH when the token belongs to a different app', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        active: true,
        sub: 's',
        appId: 'OTHER_APP',
        tenantId: null,
        type: 'api',
        privileges: [],
      }),
    );

    const service = new JwksService(makeConfig());
    await expect(service.verifyApiToken('x', 'app1')).rejects.toMatchObject({
      code: 'APP_MISMATCH',
    });
  });

  it('throws UNKNOWN_ERROR when the introspection request fails (network)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const service = new JwksService(makeConfig());
    await expect(service.verifyApiToken('x', 'app1')).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
    });
  });

  it('throws UNKNOWN_ERROR when the endpoint returns a non-OK status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));

    const service = new JwksService(makeConfig());
    await expect(service.verifyApiToken('x', 'app1')).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('does NOT cache by default — each call re-introspects (instant revocation)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ active: true, sub: 's', appId: 'app1', type: 'api', privileges: [] }),
    );

    const service = new JwksService(makeConfig());
    await service.verifyApiToken('tok', 'app1');
    await service.verifyApiToken('tok', 'app1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches successful results within introspectionCacheTtlMs when enabled', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ active: true, sub: 's', appId: 'app1', type: 'api', privileges: [] }),
    );

    const service = new JwksService(makeConfig({ introspectionCacheTtlMs: 60_000 }));
    await service.verifyApiToken('tok', 'app1');
    await service.verifyApiToken('tok', 'app1');

    // Second call served from cache → only one network round-trip.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
