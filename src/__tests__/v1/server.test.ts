import { describe, expect, it } from 'vitest';
import { createBridgeServer, type BridgeServerOptions } from '../../server/index.js';
import { APP, makeKeyRing, mint, type KeyRing } from '../verifier/fixtures.js';
import { fakeRevocationList, makeLaneKey, type LaneKey } from '../verifier/revocation-fixtures.js';

/**
 * The server-side token check, against tokens shaped exactly like the ones
 * Identity and Access issues: `at+jwt`, PS256 with the app's key, the app's
 * issuer, Bridge's API as audience, and its claims (`tid`, `mid`, `role`,
 * `wst`, `privileges`, `sid`, `client_id`, `auth_time`, `amr`, `acr`,
 * `email`, `email_verified`, `jti`).
 */

const ORIGIN = 'https://bridge.test';
const ISSUER = `${ORIGIN}/identity-access/apps/${APP}`;
const AUDIENCE = `${ORIGIN}/api`;
const LIST = `${ORIGIN}/v2/lanes`;
const JWKS = `${ORIGIN}/v2/identity-access/apps/${APP}/jwks.json`;
const LANES = ['identity-access', 'accounts', 'billing', 'app-registry'] as const;

interface Setup {
  ring: KeyRing;
  list: ReturnType<typeof fakeRevocationList>;
  requests: { url: string; headers: Headers; body: unknown }[];
  server: ReturnType<typeof createBridgeServer>;
  usageAnswers: number[];
}

async function setUp(options: Partial<BridgeServerOptions> & { metadata?: Record<string, unknown>; listNow?: () => number; metadataFailures?: number; jwksRedirect?: boolean } = {}): Promise<Setup> {
  let metadataFailures = options.metadataFailures ?? 0;
  const ring = await makeKeyRing();
  const laneKeys: Record<string, LaneKey> = {};
  for (const lane of LANES) laneKeys[lane] = await makeLaneKey(lane);
  const list = fakeRevocationList(laneKeys, APP, options.listNow ?? (() => Date.now()), { list: LIST, jwks: JWKS });
  // Identity and Access publishes the app's token keys and every lane's key in one key set.
  list.setKeys({ keys: [ring.app.publicJwk, ...Object.values(laneKeys).map((key) => key.publicJwk)] });
  const requests: Setup['requests'] = [];
  const usageAnswers: number[] = [];
  const metadata = options.metadata ?? {
    issuer: ISSUER,
    token_endpoint: `${ORIGIN}/v2/identity-access/apps/${APP}/token`,
    introspection_endpoint: `${ORIGIN}/v2/identity-access/apps/${APP}/introspect`,
    jwks_uri: JWKS,
    bridge_app: APP,
    bridge_access_token_audience: AUDIENCE,
    bridge_revocation_lanes: Object.fromEntries(LANES.map((lane) => [lane, `${LIST}/${lane}`])),
    bridge_endpoints: { '2': { sign_in: `${ORIGIN}/v2/identity-access/apps/${APP}/sign-in`, accounts: `${ORIGIN}/v2/accounts`, billing: `${ORIGIN}/v2/billing`, flags: `${ORIGIN}/v2/flags` } },
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().json().catch(() => undefined) : undefined;
    requests.push({ url: request.url, headers: request.headers, body });
    if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
      if (metadataFailures > 0) {
        metadataFailures -= 1;
        return new Response(null, { status: 503 });
      }
      return Response.json(metadata);
    }
    if (options.jwksRedirect && request.url === JWKS) return new Response(null, { status: 302, headers: { location: `${ORIGIN}/elsewhere/jwks.json` } });
    if (request.url === `${ORIGIN}/elsewhere/jwks.json`) return list.fetch(JWKS, init);
    if (request.url === `${ORIGIN}/v2/billing/usage`) {
      const status = usageAnswers.shift() ?? 201;
      return status === 201 ? Response.json({ counted: 1, deduped: 0, outcomes: [] }, { status }) : new Response(null, { status });
    }
    if (request.url === `${ORIGIN}/v2/flags/ofrep/v1/evaluate/flags`) return Response.json({ flags: [{ key: 'reports', value: true, reason: 'TARGETING_MATCH' }] });
    return list.fetch(input, init);
  }) as typeof fetch;
  const { metadata: _metadata, listNow: _listNow, metadataFailures: _failures, jwksRedirect: _redirect, ...serverOptions } = options;
  const server = createBridgeServer({ issuer: ISSUER, fetch: fetchFn, appKey: 'app-key-1', usageFlushMs: 60_000, ...serverOptions });
  return { ring, list, requests, server, usageAnswers };
}

function personToken(ring: KeyRing, overrides: Record<string, unknown> = {}, typ = 'at+jwt') {
  const now = Math.floor(Date.now() / 1000);
  return mint(
    ring.app,
    {
      aid: APP,
      tid: 'ws-acme',
      mid: 'mem-1',
      role: 'OWNER',
      wst: 'active',
      privileges: ['billing:manage', 'USER_WRITE'],
      sid: 'ses-1',
      client_id: APP,
      auth_time: now,
      amr: ['pwd'],
      acr: 'urn:bridge:acr:one-factor',
      email: 'alice@acme.test',
      email_verified: true,
      jti: 'jti-1',
      ...overrides,
    },
    { issuer: ISSUER, audience: AUDIENCE, subject: 'usr-alice', typ },
  );
}

const withBearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('server: token checks that honour every revocation lane', () => {
  it('accepts a person\'s token and gives an Actor without roles or privileges', async () => {
    const { server, ring } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    expect(actor).toEqual({ kind: 'person', id: 'usr-alice', personId: 'usr-alice', workspaceId: 'ws-acme', sessionId: 'ses-1', appId: APP, standing: 'active' });
    expect(Object.isFrozen(actor)).toBe(true);
    await server.close();
  });

  it('follows all four lanes of the revocation list', async () => {
    const { server, ring, list } = await setUp();
    await server.verify(withBearer(await personToken(ring)));
    expect(new Set(list.requests.map((request) => request.lane))).toEqual(new Set(LANES));
    expect(server.status()?.ready).toBe(true);
    await server.close();
  });

  it('refuses a token whose session ended, within one sync of the list', async () => {
    const { server, ring, list } = await setUp({ revocationIntervalMs: 20 });
    const token = await personToken(ring);
    await server.verify(withBearer(token));
    await list.revoke('identity-access', { kind: 'session', id: 'ses-1' });
    let result = await server.check(withBearer(token));
    for (let tries = 0; result.ok && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await server.check(withBearer(token));
    }
    expect(result.ok ? null : { kind: result.error.kind, status: result.error.status, code: result.error.code }).toEqual({ kind: 'signed-out', status: 401, code: 'revoked' });
    await server.close();
  });

  it.each([
    ['an ID token', { typ: 'JWT' }, 'wrong_type'],
    ['another issuer', { issuer: 'https://evil.test/identity-access/apps/app-acme' }, 'wrong_issuer'],
    ['another audience', { audience: 'https://elsewhere.test' }, 'wrong_audience'],
    ['another app', { claims: { aid: 'app-globex' } }, 'wrong_app'],
    ['an expired token', { expiresIn: Math.floor(Date.now() / 1000) - 60 }, 'expired'],
  ])('refuses %s with 401', async (_, change, reason) => {
    const { server, ring } = await setUp();
    const c = change as { typ?: string; issuer?: string; audience?: string; claims?: Record<string, unknown>; expiresIn?: number };
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(
      ring.app,
      { aid: APP, tid: 'ws-acme', sid: 'ses-1', wst: 'active', privileges: [], ...c.claims },
      { issuer: c.issuer ?? ISSUER, audience: c.audience ?? AUDIENCE, subject: 'usr-alice', typ: c.typ ?? 'at+jwt', ...(c.expiresIn === undefined ? {} : { expiresIn: c.expiresIn, issuedAt: now - 600 }) },
    );
    const result = await server.check(withBearer(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect([result.error.status, result.error.code]).toEqual([401, reason]);
    await server.close();
  });

  it('refuses a request without a credential', async () => {
    const { server } = await setUp();
    await expect(server.verify({ headers: {} })).rejects.toMatchObject({ status: 401, code: 'missing' });
    await server.close();
  });

  it('answers 503, never yes, while the revocation list cannot be read', async () => {
    const { server, ring, list } = await setUp();
    list.setDown(true);
    await expect(server.verify(withBearer(await personToken(ring)))).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    await server.close();
  });

  it('with strict, refuses when the list is further behind than the tighter limit', async () => {
    // The lanes' signed checkpoints vouch for a minute ago: fine for reads, too old for a write.
    const { server, ring } = await setUp({ listNow: () => Date.now() - 60_000 });
    const token = await personToken(ring);
    await expect(server.verify(withBearer(token))).resolves.toMatchObject({ id: 'usr-alice' });
    await expect(server.verify(withBearer(token), { strict: true })).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    await server.close();
  });

  it('refuses to start without the audience', async () => {
    const { server } = await setUp({
      metadata: { issuer: ISSUER, token_endpoint: `${ORIGIN}/v2/identity-access/apps/${APP}/token`, jwks_uri: JWKS },
    });
    await expect(server.ready).rejects.toMatchObject({ kind: 'misconfigured', message: expect.stringMatching(/audience/) });
  });

  it('starts from the standard fields alone when given the audience (fallback)', async () => {
    const { server, ring } = await setUp({
      audience: AUDIENCE,
      metadata: { issuer: ISSUER, token_endpoint: `${ORIGIN}/v2/identity-access/apps/${APP}/token`, jwks_uri: JWKS },
    });
    await server.ready;
    expect(server.metadata().revocationLanes['identity-access']).toBe(`${ORIGIN}/v2/identity-access/apps/${APP}/revocations/identity-access`);
    void ring;
    await server.close();
  });
});

describe('server: flags for the caller', () => {
  it('forwards the person\'s own token, and gives an empty set without one', async () => {
    const { server, ring, requests } = await setUp();
    const token = await personToken(ring);
    const flags = await server.flags.forRequest(withBearer(token), { plan_page: 'pricing' });
    expect(flags.enabled('reports')).toBe(true);
    const sent = requests.find((request) => request.url.endsWith('/evaluate/flags'))!;
    expect(sent.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(sent.body).toEqual({ context: { plan_page: 'pricing' } });
    expect((await server.flags.forRequest({ headers: {} })).enabled('reports')).toBe(false);
    await server.close();
  });
});

describe('server: "count this"', () => {
  it('batches counts for the caller\'s workspace and sends them with the app key', async () => {
    const { server, ring, requests } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    server.usage.count(actor, 'api.calls');
    server.usage.count(actor, 'exports.made', 3);
    expect(server.usage.pending()).toBe(2);
    await server.usage.flush();
    const sent = requests.filter((request) => request.url.endsWith('/v2/billing/usage'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get('x-api-key')).toBe('app-key-1');
    expect(sent[0]!.headers.get('authorization')).toBeNull();
    const reports = (sent[0]!.body as { reports: Record<string, unknown>[] }).reports;
    expect(reports.map(({ metric, quantity, workspace }) => ({ metric, quantity, workspace }))).toEqual([
      { metric: 'api.calls', quantity: 1, workspace: 'ws-acme' },
      { metric: 'exports.made', quantity: 3, workspace: 'ws-acme' },
    ]);
    expect(server.usage.pending()).toBe(0);
    await server.close();
  });

  it('keeps a batch Bridge did not take, and sends it again with the same ids', async () => {
    const { server, ring, requests, usageAnswers } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    usageAnswers.push(503);
    server.usage.count(actor, 'api.calls');
    await server.usage.flush();
    expect(server.usage.pending()).toBe(1);
    await server.usage.flush();
    const ids = requests.filter((request) => request.url.endsWith('/v2/billing/usage')).map((request) => (request.body as { reports: { id: string }[] }).reports[0]!.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(server.usage.pending()).toBe(0);
    await server.close();
  });

  it('refuses a metric that is not a metric name, a caller with no workspace, and counting without the app key', async () => {
    const { server, ring } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    expect(() => server.usage.count(actor, 'API Calls')).toThrow(/metric name/);
    expect(() => server.usage.count({ ...actor, workspaceId: null }, 'api.calls')).toThrow(/no workspace/);
    await server.close();
    const keyless = (await setUp({ appKey: undefined as unknown as string })).server;
    expect(() => keyless.usage.count(actor, 'api.calls')).toThrow(/app key/);
  });
});

describe('server: a failed start-up is tried again, never kept', () => {
  it('answers 503 while the metadata cannot be read, then recovers on its own', async () => {
    const { server, ring } = await setUp({ metadataFailures: 1, discoveryRetryMs: 0 });
    await expect(server.ready).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(server.check(withBearer(await personToken(ring)))).resolves.toMatchObject({ ok: true });
    await server.close();
  });

  it('while it cannot be read: checks answer 503, flags give fallbacks, usage waits', async () => {
    // Four failed reads: at start-up, then for the check, the flags and the usage below.
    const { server, ring, requests } = await setUp({ metadataFailures: 4, discoveryRetryMs: 0 });
    const token = await personToken(ring);
    const refused = await server.check(withBearer(token));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect([refused.error.kind, refused.error.status]).toEqual(['unavailable', 503]);
    expect((await server.flags.forRequest(withBearer(token))).enabled('reports')).toBe(false);
    const actor = { kind: 'person', id: 'usr-alice', personId: 'usr-alice', workspaceId: 'ws-acme', sessionId: 'ses-1', appId: APP, standing: 'active' } as const;
    server.usage.count(actor, 'api.calls');
    await server.usage.flush();
    expect(server.usage.pending()).toBe(1);
    // The fifth read works: everything recovers without a restart.
    await expect(server.verify(withBearer(token))).resolves.toMatchObject({ id: 'usr-alice' });
    await server.usage.flush();
    expect(server.usage.pending()).toBe(0);
    expect(requests.filter((request) => request.url.endsWith('/v2/billing/usage'))).toHaveLength(1);
    await server.close();
  });

  it('within the wait after a failure, it answers at once without asking Bridge again', async () => {
    const { server, ring, requests } = await setUp({ metadataFailures: 5, discoveryRetryMs: 60_000 });
    await server.ready.catch(() => undefined);
    const token = await personToken(ring);
    for (let i = 0; i < 3; i += 1) expect((await server.check(withBearer(token))).ok).toBe(false);
    expect(requests.filter((request) => request.url.endsWith('/openid-configuration'))).toHaveLength(1);
    await server.close();
  });
});

describe('server: usage that Bridge refuses never blocks the rest', () => {
  it('drops and logs a batch refused with 400, and sends the next', async () => {
    const logs: string[] = [];
    const { server, ring, requests, usageAnswers } = await setUp({ log: (message) => logs.push(message) });
    const actor = await server.verify(withBearer(await personToken(ring)));
    usageAnswers.push(400);
    server.usage.count(actor, 'api.calls');
    await server.usage.flush();
    expect(server.usage.pending()).toBe(0);
    expect(logs).toContain('Usage reports were refused by Bridge and dropped.');
    server.usage.count(actor, 'api.calls');
    await server.usage.flush();
    expect(requests.filter((request) => request.url.endsWith('/v2/billing/usage'))).toHaveLength(2);
    await server.close();
  });

  it.each([408, 429, 503])('keeps a batch answered %i, to send again', async (status) => {
    const { server, ring, usageAnswers } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    usageAnswers.push(status);
    server.usage.count(actor, 'api.calls');
    await server.usage.flush();
    expect(server.usage.pending()).toBe(1);
    await server.close();
  });

  it('keeps at most the queue limit through a long outage, dropping the oldest and saying so', async () => {
    const logs: string[] = [];
    const { server, ring, requests } = await setUp({ maxQueuedReports: 3, log: (message) => logs.push(message) });
    const actor = await server.verify(withBearer(await personToken(ring)));
    // Bridge cannot take reports for a while: they pile up, within the limit.
    for (let i = 1; i <= 5; i += 1) server.usage.count(actor, 'api.calls', 1, { id: `r-${String(i)}` });
    expect(server.usage.pending()).toBe(3);
    expect(logs).toContain('The usage queue is full; the oldest reports are being dropped.');
    await server.usage.flush();
    const sent = (requests.at(-1)!.body as { reports: { id: string }[] }).reports.map((report) => report.id);
    expect(sent).toEqual(['r-3', 'r-4', 'r-5']);
    expect(logs).toContain('Usage reports were dropped while the queue was full.');
    await server.close();
  });

  it('refuses an id or a workspace Bridge would refuse, at count time', async () => {
    const { server, ring } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    expect(() => server.usage.count(actor, 'api.calls', 1, { id: 'has a space' })).toThrow(/report id/);
    expect(() => server.usage.count(actor, 'api.calls', 1, { id: 'x'.repeat(201) })).toThrow(/report id/);
    expect(() => server.usage.count(actor, 'api.calls', 1, { workspace: 'not/an id' })).toThrow(/workspace id/);
    expect(server.usage.pending()).toBe(0);
    await server.close();
  });
});

describe('server: never in a browser, never via a redirect', () => {
  it('refuses to start with the app key in a browser', () => {
    const g = globalThis as { window?: unknown; document?: unknown };
    g.window = {};
    g.document = {};
    try {
      expect(() => createBridgeServer({ issuer: ISSUER, appKey: 'app-key-1', fetch: (() => undefined) as unknown as typeof fetch })).toThrow(/never in a browser/);
    } finally {
      delete g.window;
      delete g.document;
    }
  });

  it('does not follow a redirect for the key set: the check answers 503 and the other address is never read', async () => {
    const { server, ring, requests } = await setUp({ jwksRedirect: true });
    const result = await server.check(withBearer(await personToken(ring)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(503);
    expect(requests.some((request) => request.url.includes('/elsewhere/'))).toBe(false);
    await server.close();
  });
});
