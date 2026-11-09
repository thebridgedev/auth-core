import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Discovery, discover, endpointsFrom, metadataUrl, readMetadata } from '../../core/discovery.js';
import { CONTRACT_PATHS, REVOCATION_LANES, ROUTES } from '../../core/routes.js';
import { createFakeIssuer } from '../../testing/index.js';

const ISSUER = 'https://bridge.test/identity-access/apps/app-1';
const standard = {
  issuer: ISSUER,
  authorization_challenge_endpoint: 'https://bridge.test/v2/identity-access/apps/app-1/sign-in',
  token_endpoint: 'https://bridge.test/v2/identity-access/apps/app-1/token',
  revocation_endpoint: 'https://bridge.test/v2/identity-access/apps/app-1/revoke',
  introspection_endpoint: 'https://bridge.test/v2/identity-access/apps/app-1/introspect',
  jwks_uri: 'https://bridge.test/v2/identity-access/apps/app-1/jwks.json',
};

describe('discovery: the issuer is the only setting', () => {
  it('reads the metadata at <issuer>/.well-known/openid-configuration', () => {
    expect(metadataUrl(`${ISSUER}/`)).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('takes every endpoint from bridge_endpoints["2"]', async () => {
    const fake = createFakeIssuer({ appId: 'app-1', origin: 'https://bridge.test' });
    const endpoints = await discover(fake.issuer, fake.fetch);
    expect(endpoints.metadata.derived).toBe(false);
    expect(endpoints.metadata.appId).toBe('app-1');
    expect(endpoints.metadata.audience).toBe('https://bridge.test/api');
    expect(endpoints.url(ROUTES.member, { memberId: 'm1' })).toBe('https://bridge.test/v2/accounts/members/m1');
    expect(endpoints.url(ROUTES.flagsVisitorEvaluate)).toBe('https://bridge.test/v2/flags/apps/app-1/ofrep/v1/evaluate/flags');
    expect(endpoints.url(ROUTES.liveHistory, {}, { cursor: 'c 1', channel: undefined })).toBe('https://bridge.test/v2/live/history?cursor=c+1');
    expect(Object.keys(endpoints.metadata.revocationLanes).sort()).toEqual(['accounts', 'app-registry', 'billing', 'identity-access']);
  });

  it('uses only what the metadata lists: an endpoint on another host is called there', () => {
    const endpoints = endpointsFrom(
      readMetadata(ISSUER, { ...standard, bridge_app: 'app-1', bridge_endpoints: { '2': { accounts: 'https://accounts.elsewhere.test/v2/accounts' } } }),
    );
    expect(endpoints.url(ROUTES.me)).toBe('https://accounts.elsewhere.test/v2/accounts/me');
  });

  it('pins version 2: refuses an issuer that offers only another version', () => {
    expect(() => readMetadata(ISSUER, { ...standard, bridge_app: 'app-1', bridge_endpoints: { '3': {} } })).toThrow(/does not offer version 2.*offers: 3/);
  });

  it('refuses metadata that names another issuer', () => {
    expect(() => readMetadata(ISSUER, { ...standard, issuer: 'https://evil.test/identity-access/apps/app-1' })).toThrow(/names "https:\/\/evil\.test/);
  });

  it('refuses published endpoints without the app they are for', () => {
    expect(() => readMetadata(ISSUER, { ...standard, bridge_endpoints: { '2': { accounts: 'https://bridge.test/v2/accounts' } } })).toThrow(/bridge_app/);
  });

  it('refuses a malformed issuer before fetching anything', async () => {
    await expect(discover('bridge.test/app-1', fetch)).rejects.toMatchObject({ kind: 'misconfigured' });
  });

  it('answers not-offered for an endpoint the issuer does not list', () => {
    const endpoints = endpointsFrom(readMetadata(ISSUER, { ...standard, bridge_app: 'app-1', bridge_endpoints: { '2': { accounts: 'https://bridge.test/v2/accounts' } } }));
    expect(endpoints.offers(ROUTES.signInOptions)).toBe(false);
    expect(() => endpoints.url(ROUTES.signInOptions)).toThrow(/does not offer the "sign_in_options" endpoint yet/);
  });

  describe('fallback: metadata with the standard fields only', () => {
    it('works out the version 2 endpoints from where the token endpoint is', () => {
      const metadata = readMetadata(ISSUER, standard);
      expect(metadata.derived).toBe(true);
      expect(metadata.appId).toBe('app-1');
      expect(metadata.audience).toBeNull();
      const endpoints = endpointsFrom(metadata);
      expect(endpoints.url(ROUTES.signUp)).toBe('https://bridge.test/v2/identity-access/apps/app-1/sign-up');
      expect(endpoints.url(ROUTES.signOut)).toBe('https://bridge.test/v2/identity-access/sign-out');
      expect(endpoints.url(ROUTES.payer)).toBe('https://bridge.test/v2/billing/payer');
      expect(metadata.revocationLanes['app-registry']).toBe('https://bridge.test/v2/app-registry/apps/app-1/revocations/app-registry');
    });

    it('leaves out what Bridge does not serve yet', () => {
      const endpoints = endpointsFrom(readMetadata(ISSUER, standard));
      for (const route of [ROUTES.signInOptions, ROUTES.inviteAccept, ROUTES.invitePreview, ROUTES.liveConnection]) expect(endpoints.offers(route)).toBe(false);
    });

    it('refuses a token endpoint it cannot read a version 2 address from', () => {
      expect(() => readMetadata(ISSUER, { ...standard, token_endpoint: 'https://bridge.test/oauth/token' })).toThrow(/can work them out from/);
    });

    it('is what the fake issuer serves in standard mode', async () => {
      const fake = createFakeIssuer({ metadata: 'standard' });
      expect((await discover(fake.issuer, fake.fetch)).metadata.derived).toBe(true);
    });
  });
});

describe("discovery: Bridge's own discovery document", () => {
  const pinned = JSON.parse(readFileSync(new URL('../../../contract/discovery.v2.json', import.meta.url), 'utf8')) as {
    source: { commit: string };
    document: Record<string, unknown> & { issuer: string; bridge_endpoints: Record<string, Record<string, string>> };
  };
  const doc = pinned.document;

  it('names the commit it came from', () => {
    expect(pinned.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is read as it is: the app, the audience and all four lanes', () => {
    const metadata = readMetadata(doc.issuer, doc);
    expect(metadata.derived).toBe(false);
    expect(metadata.appId).toBe(doc['bridge_app']);
    expect(metadata.audience).toBe(doc['bridge_access_token_audience']);
    expect(Object.keys(metadata.revocationLanes).sort()).toEqual([...REVOCATION_LANES].sort());
  });

  it("lists version 2's own copy of the five standard endpoints, and the SDK reads them there", () => {
    const listed = doc.bridge_endpoints['2'] ?? {};
    const { endpoints } = readMetadata(doc.issuer, doc);
    for (const name of ['sign_in', 'token', 'revoke', 'introspect', 'jwks'] as const) {
      expect(listed[name], name).toBeDefined();
      expect(endpoints[name]).toBe(listed[name]);
    }
  });

  it("prefers version 2's copy to the standard fields, which may point at a newer version", () => {
    const newer = { ...doc, token_endpoint: 'https://bridge.test/v3/identity-access/apps/app-1/token', jwks_uri: 'https://bridge.test/v3/identity-access/apps/app-1/jwks.json' };
    const { endpoints } = readMetadata(doc.issuer, newer);
    expect(endpoints.token).toBe(doc.bridge_endpoints['2']?.['token']);
    expect(endpoints.jwks).toBe(doc.bridge_endpoints['2']?.['jwks']);
  });

  it('falls back to the standard fields only for an issuer whose list leaves them out', () => {
    const { sign_in: _s, token: _t, revoke: _r, introspect: _i, jwks: _j, ...rest } = doc.bridge_endpoints['2'] ?? {};
    const { endpoints } = readMetadata(doc.issuer, { ...doc, bridge_endpoints: { '2': rest } });
    expect([endpoints.sign_in, endpoints.token, endpoints.revoke, endpoints.introspect, endpoints.jwks]).toEqual([
      doc['authorization_challenge_endpoint'],
      doc['token_endpoint'],
      doc['revocation_endpoint'],
      doc['introspection_endpoint'],
      doc['jwks_uri'],
    ]);
  });

  it('every name Bridge lists is one the SDK reads, so a renamed key fails here', () => {
    for (const name of Object.keys(doc.bridge_endpoints['2'] ?? {})) expect(Object.keys(CONTRACT_PATHS)).toContain(name);
  });

  it('offers every route the SDK calls, the invites included', () => {
    const endpoints = endpointsFrom(readMetadata(doc.issuer, doc));
    const missing = Object.entries(ROUTES).filter(([, route]) => !endpoints.offers(route)).map(([name]) => name);
    expect(missing).toEqual([]);
    expect(endpoints.url(ROUTES.invitePreview)).toBe('https://bridge.test/v2/identity-access/apps/app-1/invites/preview');
    expect(endpoints.url(ROUTES.inviteAccept)).toBe('https://bridge.test/v2/identity-access/invites/accept');
  });

  it('the addresses it gives are the contract\'s paths', () => {
    const endpoints = endpointsFrom(readMetadata(doc.issuer, doc));
    for (const route of Object.values(ROUTES)) {
      if (!endpoints.offers(route)) continue;
      const path = new URL(endpoints.url(route, { memberId: 'm', inviteId: 'i', session: 's', sessionId: 's', key: 'k', token: 't' })).pathname;
      const expected = (CONTRACT_PATHS[route.at] + route.path).replace('{appId}', String(doc['bridge_app'])).replace(/\{[a-zA-Z]+\}/g, (name) => ({ '{memberId}': 'm', '{inviteId}': 'i', '{session}': 's', '{sessionId}': 's', '{key}': 'k', '{token}': 't' })[name] ?? name);
      expect(path).toBe(expected);
    }
  });
});

describe('discovery: credentials travel only over TLS', () => {
  it.each([
    ['https://bridge.test/identity-access/apps/app-1', true],
    ['http://localhost:3400/identity-access/apps/app-1', true],
    ['http://127.0.0.1:3400/identity-access/apps/app-1', true],
    ['http://[::1]:3400/identity-access/apps/app-1', true],
    ['http://bridge.test/identity-access/apps/app-1', false],
    ['https://user:pw@bridge.test/identity-access/apps/app-1', false],
  ])('accepts the issuer %s: %s', async (issuer, accepted) => {
    const fetchFn = (async () => Response.json({ ...standard, issuer })) as unknown as typeof fetch;
    const result = discover(issuer, fetchFn);
    if (accepted) await expect(result).resolves.toMatchObject({ metadata: { issuer } });
    else await expect(result).rejects.toMatchObject({ kind: 'misconfigured', message: expect.stringMatching(/must be an https/) });
  });

  it('refuses metadata that lists an endpoint or a lane over plain http', () => {
    expect(() => readMetadata(ISSUER, { ...standard, bridge_app: 'app-1', bridge_endpoints: { '2': { accounts: 'http://bridge.test/v2/accounts' } } })).toThrow(/"accounts" at an address that is not https/);
    expect(() => readMetadata(ISSUER, { ...standard, bridge_app: 'app-1', bridge_revocation_lanes: { billing: 'http://bridge.test/x' }, bridge_endpoints: { '2': { accounts: 'https://bridge.test/v2/accounts' } } })).toThrow(/billing lane/);
    expect(() => readMetadata(ISSUER, { ...standard, token_endpoint: 'http://bridge.test/v2/identity-access/apps/app-1/token' })).toThrow(/token_endpoint/);
  });

  it('does not take the standard fields for version 2 when they are for another version', () => {
    const metadata = readMetadata(ISSUER, { ...standard, bridge_app: 'app-1', bridge_api_version: 3, bridge_endpoints: { '2': { sign_in: 'https://bridge.test/v2/s', token: 'https://bridge.test/v2/t', accounts: 'https://bridge.test/v2/accounts' } } });
    expect(metadata.endpoints.token).toBe('https://bridge.test/v2/t');
    expect(metadata.endpoints.jwks).toBeUndefined();
  });

  it('refuses metadata that comes from a redirect', async () => {
    const fetchFn = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/metadata' } })) as unknown as typeof fetch;
    await expect(discover(ISSUER, fetchFn)).rejects.toMatchObject({ kind: 'misconfigured', message: expect.stringMatching(/redirect/) });
  });
});

describe('discovery: a failed read is tried again, never kept', () => {
  it('waits longer after each failure, then recovers', async () => {
    let now = 0;
    let fail = 2;
    let reads = 0;
    const fetchFn = (async () => {
      reads += 1;
      return fail-- > 0 ? new Response(null, { status: 503 }) : Response.json(standard);
    }) as unknown as typeof fetch;
    const discovery = new Discovery(ISSUER, fetchFn, { retryMinMs: 1000, now: () => now });
    await expect(discovery.get()).rejects.toMatchObject({ kind: 'unavailable' });
    // Within the wait: the last error at once, without asking again.
    await expect(discovery.get()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(reads).toBe(1);
    now = 1000;
    await expect(discovery.get()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(discovery.retryInMs()).toBe(2000);
    now = 3000;
    await expect(discovery.get()).resolves.toMatchObject({ metadata: { appId: 'app-1' } });
    expect(reads).toBe(3);
    // Kept once read.
    await discovery.get();
    expect(reads).toBe(3);
  });

  it('reads at once when asked to, even within the wait', async () => {
    let fail = true;
    const fetchFn = (async () => (fail ? new Response(null, { status: 503 }) : Response.json(standard))) as unknown as typeof fetch;
    const discovery = new Discovery(ISSUER, fetchFn, { retryMinMs: 60_000 });
    await expect(discovery.get()).rejects.toBeDefined();
    fail = false;
    await expect(discovery.get({ now: true })).resolves.toBeDefined();
  });
});
