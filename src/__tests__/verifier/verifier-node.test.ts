// @vitest-environment node
//
// Node-side behaviour of the credential verifier that the shared conformance
// suite does not cover: loading the key set over HTTP, caching key checks,
// reading credentials from Node-style headers, and the migration helpers that
// keep the older caller shapes working.
import { beforeAll, describe, expect, it } from 'vitest';
import * as backend from '../../backend/index.js';
import {
  actorToApiTokenClaims,
  actorToBridgeUser,
  JwksService,
  transformJwtToBridgeUser,
  type JwtClaims,
} from '../../backend/index.js';
import { createCredentialVerifier, readCredentials } from '../../verifier/index.js';
import {
  APP,
  INTROSPECTION_URL,
  ISSUER,
  JWKS_URL,
  KEYS,
  fakeIntrospection,
  makeKeyRing,
  mint,
  personClaims,
  type KeyRing,
} from './fixtures.js';

let ring: KeyRing;
beforeAll(async () => {
  ring = await makeKeyRing();
});

function jwksServer(getBody: () => unknown) {
  let calls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== JWKS_URL) return new Response('not found', { status: 404 });
    calls += 1;
    const body = getBody();
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

describe('remote key set', () => {
  it('loads the key set from its URL once and reuses it', async () => {
    const server = jwksServer(() => ring.jwks);
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, jwksUrl: JWKS_URL, fetch: server.fetch });
    for (let i = 0; i < 3; i += 1) {
      const token = await mint(ring.app, personClaims());
      const result = await verifier.verify({ type: 'token', value: token });
      expect(result.ok).toBe(true);
    }
    expect(server.calls()).toBe(1);
  });

  it('refuses with `unavailable` when the key set cannot be loaded', async () => {
    const server = jwksServer(() => new TypeError('fetch failed'));
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, jwksUrl: JWKS_URL, fetch: server.fetch });
    const token = await mint(ring.app, personClaims());
    const result = await verifier.verify({ type: 'token', value: token });
    expect(result.ok ? 'accepted' : result.refusal.reason).toBe('unavailable');
  });

  it('refuses to start without the app, the issuer or a key set', () => {
    expect(() => createCredentialVerifier({ appId: '', issuer: ISSUER, jwks: ring.jwks })).toThrow(TypeError);
    expect(() => createCredentialVerifier({ appId: APP, issuer: '', jwks: ring.jwks })).toThrow(TypeError);
    expect(() => createCredentialVerifier({ appId: APP, issuer: ISSUER })).toThrow(TypeError);
  });
});

describe('key check caching', () => {
  it('asks the issuer every time by default, so a revoked key stops at once', async () => {
    const issuer = fakeIntrospection({ 'k-app': { body: KEYS.app } });
    const verifier = createCredentialVerifier({
      appId: APP, issuer: ISSUER, jwks: ring.jwks, introspectionUrl: INTROSPECTION_URL, fetch: issuer.fetch,
    });
    await verifier.verify({ type: 'key', value: 'k-app' });
    await verifier.verify({ type: 'key', value: 'k-app' });
    expect(issuer.asked).toEqual(['k-app', 'k-app']);
  });

  it('reuses an active answer for introspectionCacheTtlMs, and never caches a refusal', async () => {
    const issuer = fakeIntrospection({ 'k-app': { body: KEYS.app } });
    const verifier = createCredentialVerifier({
      appId: APP, issuer: ISSUER, jwks: ring.jwks, introspectionUrl: INTROSPECTION_URL, fetch: issuer.fetch,
      introspectionCacheTtlMs: 60_000,
    });
    await verifier.verify({ type: 'key', value: 'k-app' });
    await verifier.verify({ type: 'key', value: 'k-app' });
    await verifier.verify({ type: 'key', value: 'k-unknown' });
    await verifier.verify({ type: 'key', value: 'k-unknown' });
    expect(issuer.asked).toEqual(['k-app', 'k-unknown', 'k-unknown']);
  });
});

describe('reading credentials from a request', () => {
  it('reads only the bearer token and the key, bearer first', () => {
    expect(
      readCredentials({ 'x-api-key': 'k', authorization: 'Bearer t', cookie: 'bridge_access_token=c' }),
    ).toEqual([
      { type: 'token', value: 't' },
      { type: 'key', value: 'k' },
    ]);
  });

  it('ignores other schemes and headers sent twice', () => {
    expect(readCredentials({ authorization: 'Basic dXNlcjpwYXNz' })).toEqual([]);
    expect(readCredentials({ authorization: 'Bearer' })).toEqual([]);
    expect(readCredentials({ authorization: 'Bearer a b' })).toEqual([]);
    expect(readCredentials({ 'x-api-key': ['k1', 'k2'] })).toEqual([]);
    expect(readCredentials({ authorization: 'Bearer t1', Authorization: 'Bearer t2' })).toEqual([]);
    expect(readCredentials({ Authorization: 'bearer t' })).toEqual([{ type: 'token', value: 't' }]);
  });

  it('reads Fetch API headers too', () => {
    expect(readCredentials(new Headers({ Authorization: 'Bearer t' }))).toEqual([{ type: 'token', value: 't' }]);
  });
});

describe('the older caller shapes keep working', () => {
  it('still exports JwksService, BridgeUser helpers and the token utilities from ./backend', () => {
    expect(typeof backend.JwksService).toBe('function');
    expect(typeof backend.TokenVerificationError).toBe('function');
    expect(typeof backend.transformJwtToBridgeUser).toBe('function');
    expect(typeof backend.decodeJwtPayload).toBe('function');
    expect(typeof backend.createCredentialVerifier).toBe('function');
    expect(new JwksService({
      jwksUrl: JWKS_URL, introspectionUrl: INTROSPECTION_URL, issuer: ISSUER, audience: APP,
    })).toBeInstanceOf(JwksService);
  });

  it("actorToBridgeUser gives the same BridgeUser the old path built from the token's claims", async () => {
    const token = await mint(ring.app, personClaims({ name: 'Alice Doe', preferred_username: 'alice' }));
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, jwks: ring.jwks });
    const result = await verifier.verify({ type: 'token', value: token });
    if (!result.ok) throw new Error(result.refusal.reason);

    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as JwtClaims;
    expect(actorToBridgeUser(result.actor)).toEqual(transformJwtToBridgeUser(claims));
    expect(actorToApiTokenClaims(result.actor)).toBeNull();
  });

  it('actorToApiTokenClaims gives the shape the old key check returned', async () => {
    const issuer = fakeIntrospection({ 'k-legacy-app': { body: KEYS.legacyAppWide } });
    const verifier = createCredentialVerifier({
      appId: APP, issuer: ISSUER, jwks: ring.jwks, introspectionUrl: INTROSPECTION_URL, fetch: issuer.fetch,
    });
    const result = await verifier.verify({ type: 'key', value: 'k-legacy-app' });
    if (!result.ok) throw new Error(result.refusal.reason);

    expect(actorToApiTokenClaims(result.actor)).toEqual({
      sub: 'key-legacy-app',
      appId: APP,
      tenantId: null,
      type: 'api',
      privileges: ['USER_READ'],
      exp: 4102444800,
    });
    expect(actorToBridgeUser(result.actor)).toBeNull();
  });
});
