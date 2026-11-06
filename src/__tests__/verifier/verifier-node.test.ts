// @vitest-environment node
//
// Node-side behaviour of the credential verifier that the shared conformance
// suite does not cover: loading the key set over HTTP, caching key checks,
// and reading credentials from Node-style headers.
import { beforeAll, describe, expect, it } from 'vitest';
import { createCredentialVerifier, createKeySet, readCredentials } from '../../verifier/index.js';
import {
  APP,
  AUDIENCE,
  INTROSPECTION_URL,
  ISSUER,
  JWKS_URL,
  KEYS,
  fakeIntrospection,
  makeKey,
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
    if (body && typeof body === 'object' && 'status' in body) return new Response('', { status: (body as { status: number }).status });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

describe('remote key set', () => {
  it('loads the key set from its URL once and reuses it', async () => {
    const server = jwksServer(() => ring.jwks);
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, audience: AUDIENCE, jwksUrl: JWKS_URL, fetch: server.fetch, revocationCheck: 'none' });
    for (let i = 0; i < 3; i += 1) {
      const token = await mint(ring.app, personClaims());
      const result = await verifier.verify({ type: 'token', value: token });
      expect(result.ok).toBe(true);
    }
    expect(server.calls()).toBe(1);
  });

  it('refuses with `unavailable` when the key set cannot be loaded', async () => {
    const server = jwksServer(() => new TypeError('fetch failed'));
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, audience: AUDIENCE, jwksUrl: JWKS_URL, fetch: server.fetch, revocationCheck: 'none' });
    const token = await mint(ring.app, personClaims());
    const result = await verifier.verify({ type: 'token', value: token });
    expect(result.ok ? 'accepted' : result.refusal.reason).toBe('unavailable');
  });

  it('fetches the key set again for a key id it does not hold, at most once per cooldown however many tokens name one', async () => {
    let clock = 1_000_000;
    let published = ring.jwks;
    const server = jwksServer(() => published);
    const keySet = createKeySet({ url: JWKS_URL, fetch: server.fetch, now: () => clock });
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, audience: AUDIENCE, keySet, revocationCheck: 'none' });
    const reason = async (token: string) => {
      const result = await verifier.verify({ type: 'token', value: token });
      return result.ok ? 'accepted' : result.refusal.reason;
    };

    expect(await reason(await mint(ring.app, personClaims()))).toBe('accepted');
    expect(server.calls()).toBe(1);

    const stranger = await makeKey('made-up-kid');
    for (let i = 0; i < 20; i += 1) expect(await reason(await mint(stranger, personClaims()))).toBe('unknown_key');
    expect(server.calls()).toBe(1);

    // A rotated key: published, and used once the cooldown has passed.
    const rotated = await makeKey('acme-key-2');
    published = { keys: [...ring.jwks.keys, rotated.publicJwk] };
    clock += 30_001;
    expect(await reason(await mint(rotated, personClaims()))).toBe('accepted');
    expect(server.calls()).toBe(2);
    for (let i = 0; i < 20; i += 1) expect(await reason(await mint(stranger, personClaims()))).toBe('unknown_key');
    expect(server.calls()).toBe(2);
  });

  it('fetches the key set again once it is older than its maximum age, so a key taken out of the set stops working', async () => {
    let clock = 1_000_000;
    let published = ring.jwks;
    const server = jwksServer(() => published);
    const keySet = createKeySet({ url: JWKS_URL, fetch: server.fetch, now: () => clock });
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, audience: AUDIENCE, keySet, revocationCheck: 'none' });
    const token = await mint(ring.app, personClaims());
    expect((await verifier.verify({ type: 'token', value: token })).ok).toBe(true);

    published = { keys: [] };
    clock += 9 * 60_000;
    expect((await verifier.verify({ type: 'token', value: token })).ok).toBe(true);
    clock += 60_001;
    const result = await verifier.verify({ type: 'token', value: token });
    expect(result.ok ? 'accepted' : result.refusal.reason).toBe('unknown_key');
    expect(server.calls()).toBe(2);
  });

  it('keeps checking with the keys it has while a later fetch fails', async () => {
    let clock = 1_000_000;
    let failing = false;
    const server = jwksServer(() => (failing ? new TypeError('fetch failed') : ring.jwks));
    const keySet = createKeySet({ url: JWKS_URL, fetch: server.fetch, now: () => clock });
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, audience: AUDIENCE, keySet, revocationCheck: 'none' });
    const token = await mint(ring.app, personClaims());
    expect((await verifier.verify({ type: 'token', value: token })).ok).toBe(true);
    failing = true;
    clock += 11 * 60_000;
    expect((await verifier.verify({ type: 'token', value: token })).ok).toBe(true);
    expect(server.calls()).toBe(2);
  });

  it('refuses with `unknown_app`, never `unavailable`, when no keys are published for the app, and does not ask again for every token', async () => {
    const server = jwksServer(() => ({ status: 404 }));
    const verifier = createCredentialVerifier({ appId: APP, issuer: ISSUER, audience: AUDIENCE, jwksUrl: JWKS_URL, fetch: server.fetch, revocationCheck: 'none' });
    for (let i = 0; i < 5; i += 1) {
      const result = await verifier.verify({ type: 'token', value: await mint(ring.app, personClaims()) });
      expect(result.ok ? 'accepted' : result.refusal.reason).toBe('unknown_app');
    }
    expect(server.calls()).toBe(1);
  });

  it('refuses to start without the app, the issuer or a key set', () => {
    expect(() => createCredentialVerifier({ appId: '', issuer: ISSUER, audience: AUDIENCE, jwks: ring.jwks, revocationCheck: 'none' })).toThrow(TypeError);
    // @ts-expect-error: a required setting is left out on purpose
    expect(() => createCredentialVerifier({ appId: APP, issuer: '', jwks: ring.jwks, revocationCheck: 'none' })).toThrow(TypeError);
    // @ts-expect-error: a required setting is left out on purpose
    expect(() => createCredentialVerifier({ appId: APP, issuer: ISSUER, revocationCheck: 'none' })).toThrow(TypeError);
  });
});

describe('key check caching', () => {
  it('asks the issuer every time by default, so a revoked key stops at once', async () => {
    const issuer = fakeIntrospection({ 'k-app': { body: KEYS.app } });
    const verifier = createCredentialVerifier({
      appId: APP, issuer: ISSUER, audience: AUDIENCE, jwks: ring.jwks, introspectionUrl: INTROSPECTION_URL, fetch: issuer.fetch, revocationCheck: 'none',
    });
    await verifier.verify({ type: 'key', value: 'k-app' });
    await verifier.verify({ type: 'key', value: 'k-app' });
    expect(issuer.asked).toEqual(['k-app', 'k-app']);
  });

  it('reuses an active answer for introspectionCacheTtlMs, and never caches a refusal', async () => {
    const issuer = fakeIntrospection({ 'k-app': { body: KEYS.app } });
    const verifier = createCredentialVerifier({
      appId: APP, issuer: ISSUER, audience: AUDIENCE, jwks: ring.jwks, introspectionUrl: INTROSPECTION_URL, fetch: issuer.fetch, revocationCheck: 'none',
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
