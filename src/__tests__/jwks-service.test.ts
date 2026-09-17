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

// ---------------------------------------------------------------------------
// verifyToken — the local JWKS path, and its algorithm pin (TBP-673)
// ---------------------------------------------------------------------------

// TBP-673's AC names five checks fromJwt() must make before trusting a claim:
// signature, alg, iss, aud = appId, exp. Four were enforced; `alg` was only
// DOCUMENTED (the class JSDoc has said "asymmetric PS256" all along) and never
// passed to jose.
//
// Left unpinned, jose accepts any algorithm the key supports. The JWKS that
// bridge-api serves carries no `alg` on its keys, so one RSA key admits both
// PS256 and RS256 — and a token the issuer never would have minted verifies
// anyway. That is the confusion class bridge-api's own verifier pins against
// (TBP-218, GHSA-hjrf-2m68-5959) and that bridge-nextjs pins against in
// verify-session.ts. This test is what makes the three agree.
//
// Note the attack modelled here needs no stolen key material beyond what the
// issuer already publishes being reused under a second algorithm — which is
// exactly why "the key is still ours" is not a defence.
describe('JwksService.verifyToken — algorithm pin (TBP-673)', () => {
  const ISSUER = 'https://api.example.com/auth';
  const AUDIENCE = 'app1';

  /**
   * One RSA keypair, exported as a JWKS the mocked fetch serves.
   *
   * The PRIVATE half comes back as a bare JWK rather than a CryptoKey, because
   * WebCrypto binds a CryptoKey to one algorithm: a key generated for PS256 is
   * RSA-PSS and refuses to sign RS256 at all. Re-importing the same `n`/`e`/`d`
   * under each algorithm is what lets the test reuse ONE key across both — and
   * that re-import is precisely what an attacker does, which is the point.
   */
  async function rsaKeypair() {
    const { generateKeyPair, exportJWK } = await import('jose');
    // `extractable: true` so both halves can be exported as JWKs.
    const { privateKey, publicKey } = await generateKeyPair('PS256', {
      extractable: true,
    });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    // Deliberately NO `alg` on the published key — this mirrors the live
    // bridge-api JWKS, and it is the reason the pin has to be on the verifier.
    return {
      privateJwk,
      jwks: { keys: [{ ...publicJwk, kid: 'test-key', use: 'sig' }] },
    };
  }

  async function sign(privateJwk: Record<string, unknown>, alg: string) {
    const { SignJWT, importJWK } = await import('jose');
    const key = await importJWK(privateJwk, alg);
    return new SignJWT({ tid: 'tenant-1' })
      .setProtectedHeader({ alg, kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  it('accepts a PS256 token — the algorithm Bridge actually signs with', async () => {
    const { privateJwk, jwks } = await rsaKeypair();
    fetchMock.mockResolvedValue(jsonResponse(jwks));

    const service = new JwksService(makeConfig());
    const claims = await service.verifyToken(await sign(privateJwk, 'PS256'));

    // Asserts the resolved claims, not merely "did not throw" — a verifier that
    // returned an empty payload would satisfy the weaker check.
    expect(claims.sub).toBe('user-1');
    expect(claims.tid).toBe('tenant-1');
  });

  it('refuses RS256 signed by the very same key', async () => {
    const { privateJwk, jwks } = await rsaKeypair();
    fetchMock.mockResolvedValue(jsonResponse(jwks));

    const service = new JwksService(makeConfig());
    // Same key, same iss, same aud, unexpired — ONLY the algorithm differs.
    // Unpinned, this verifies and the caller trusts the claims.
    await expect(service.verifyToken(await sign(privateJwk, 'RS256'))).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('refuses an unsecured alg: none token', async () => {
    const { jwks } = await rsaKeypair();
    fetchMock.mockResolvedValue(jsonResponse(jwks));

    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'attacker',
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`;

    const service = new JwksService(makeConfig());
    await expect(service.verifyToken(unsigned)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('still refuses a wrong issuer and a wrong audience on a PS256 token', async () => {
    const { privateJwk, jwks } = await rsaKeypair();
    fetchMock.mockResolvedValue(jsonResponse(jwks));
    const { SignJWT, importJWK } = await import('jose');
    const privateKey = await importJWK(privateJwk, 'PS256');

    const service = new JwksService(makeConfig());

    const wrongIssuer = await new SignJWT({})
      .setProtectedHeader({ alg: 'PS256', kid: 'test-key' })
      .setIssuer('https://evil.test/auth')
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const wrongAudience = await new SignJWT({})
      .setProtectedHeader({ alg: 'PS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience('some-other-app')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    // Paired with the passing PS256 case above, these prove the pin narrowed
    // the algorithm without loosening anything else.
    await expect(service.verifyToken(wrongIssuer)).rejects.toBeInstanceOf(TokenVerificationError);
    await expect(service.verifyToken(wrongAudience)).rejects.toBeInstanceOf(TokenVerificationError);
  });
});
