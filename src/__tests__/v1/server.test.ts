import { describe, expect, it } from 'vitest';
import { BridgeError } from '../../core/errors.js';
import { createBridgeServer, isLimitReached, quotaExceededBody, type BridgeServerOptions } from '../../server/index.js';
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
  requests: { url: string; method: string; headers: Headers; body: unknown }[];
  server: ReturnType<typeof createBridgeServer>;
  usageAnswers: number[];
}

async function setUp(options: Partial<BridgeServerOptions> & { respond?: (request: Request, body: unknown) => Response | undefined; metadata?: Record<string, unknown>; listNow?: () => number; metadataFailures?: number; jwksRedirect?: boolean; flags?: unknown[] | 'down' } = {}): Promise<Setup> {
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
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    const answered = options.respond?.(request, body);
    if (answered !== undefined) return answered;
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
    if (request.url === `${ORIGIN}/v2/flags/discoveries`) return new Response(null, { status: 204 });
    if (request.url === `${ORIGIN}/v2/flags/ofrep/v1/evaluate/flags`) {
      if (options.flags === 'down') return new Response(null, { status: 503 });
      return Response.json({ flags: options.flags ?? [{ key: 'reports', value: true, reason: 'TARGETING_MATCH' }] });
    }
    return list.fetch(input, init);
  }) as typeof fetch;
  const { respond: _respond, metadata: _metadata, listNow: _listNow, metadataFailures: _failures, jwksRedirect: _redirect, flags: _flags, ...serverOptions } = options;
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

describe('server: flags found in code', () => {
  const reports = (requests: Setup['requests']) => requests.filter((request) => request.url.endsWith('/v2/flags/discoveries'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('reports each key read that Bridge gave no result for, once, with the app key and the fallback\'s type', async () => {
    const { server, ring, requests } = await setUp();
    const flags = await server.flags.forRequest(withBearer(await personToken(ring)));
    expect(flags.enabled('reports')).toBe(true);
    expect(flags.enabled('new-checkout')).toBe(false);
    expect(flags.get('max-rows', 10)).toBe(10);
    expect(flags.get('layout', { columns: 2 })).toEqual({ columns: 2 });
    expect(flags.get('greeting', 'hi')).toBe('hi');
    flags.enabled('bridge:billing.entitlement.sso');
    await settle();
    expect(reports(requests)).toHaveLength(1);
    const [sent] = reports(requests);
    expect(sent!.method).toBe('POST');
    expect(sent!.headers.get('x-api-key')).toBe('app-key-1');
    expect(sent!.headers.get('authorization')).toBeNull();
    expect(sent!.body).toEqual({ flags: [{ key: 'new-checkout', type: 'boolean' }, { key: 'max-rows', type: 'number' }, { key: 'layout', type: 'json' }, { key: 'greeting', type: 'string' }] });
    // Once per process: read again, on another request, nothing more is sent.
    (await server.flags.forRequest(withBearer(await personToken(ring)))).enabled('new-checkout');
    await settle();
    expect(reports(requests)).toHaveLength(1);
    await server.close();
  });

  it('reports nothing without the app key, nor for a set Bridge did not answer', async () => {
    const keyless = await setUp({ appKey: undefined as unknown as string });
    (await keyless.server.flags.forRequest(withBearer(await personToken(keyless.ring)))).enabled('new-checkout');
    await settle();
    expect(reports(keyless.requests)).toHaveLength(0);
    await keyless.server.close();
    const down = await setUp({ flags: 'down' });
    (await down.server.flags.forRequest(withBearer(await personToken(down.ring)))).enabled('new-checkout');
    await settle();
    expect(reports(down.requests)).toHaveLength(0);
    await down.server.close();
  });
});

const ACTIVE = { key: 'bridge-workspace-active', value: true, reason: 'STATIC' };
const PAID = { key: 'bridge-workspace-paid', value: true, reason: 'STATIC' };
const LOCKED = { key: 'bridge-workspace-paid', value: false, reason: 'STATIC', metadata: { access: 'payment_due' } };

describe('server: a workspace that is not active or not paid can only be read', () => {
  const write = (token: string) => ({ ...withBearer(token), method: 'POST' });
  const refusal = (result: Awaited<ReturnType<ReturnType<typeof createBridgeServer>['check']>>) =>
    result.ok ? null : { kind: result.error.kind, status: result.error.status, code: result.error.code, problem: result.error.problem };
  const flagCalls = (requests: Setup['requests']) => requests.filter((request) => request.url.endsWith('/evaluate/flags')).length;

  it.each(['suspended', 'deletion_scheduled'])('refuses a write in a %s workspace with 403, without asking for flags', async (standing) => {
    const { server, ring, requests } = await setUp({ flags: [ACTIVE, PAID] });
    const result = await server.check(write(await personToken(ring, { wst: standing })));
    expect(refusal(result)).toMatchObject({ kind: 'forbidden', status: 403, code: 'workspace-not-active', problem: { type: 'urn:bridge:problem:workspace-not-active', status: 403, standing } });
    expect(flagCalls(requests)).toBe(0);
    await server.close();
  });

  it('refuses a write with 402 when the workspace is locked for payment, naming the access', async () => {
    const { server, ring } = await setUp({ flags: [ACTIVE, LOCKED] });
    const result = await server.check(write(await personToken(ring)));
    expect(refusal(result)).toMatchObject({
      kind: 'plan-required',
      status: 402,
      code: 'billing-locked',
      problem: { type: 'urn:bridge:problem:billing-locked', status: 402, reason: 'billing_locked', billing: { access: 'payment_due' } },
    });
    await server.close();
  });

  it('refuses a write when Bridge\'s live answer says the workspace is not active, though the token still says active', async () => {
    const { server, ring } = await setUp({ flags: [{ ...ACTIVE, value: false }, PAID] });
    expect(refusal(await server.check(write(await personToken(ring))))).toMatchObject({ status: 403, code: 'workspace-not-active' });
    await server.close();
  });

  it('refuses a write with 503 when the payment result is missing, or is an error', async () => {
    const missing = await setUp({ flags: [ACTIVE] });
    expect(refusal(await missing.server.check(write(await personToken(missing.ring))))).toMatchObject({ kind: 'unavailable', status: 503, code: 'workspace-state-unavailable' });
    await missing.server.close();
    const failed = await setUp({ flags: [ACTIVE, { key: 'bridge-workspace-paid', errorCode: 'GENERAL', errorDetails: 'no facts' }] });
    expect(refusal(await failed.server.check(write(await personToken(failed.ring))))).toMatchObject({ status: 503 });
    await failed.server.close();
  });

  it('refuses a write with 503 when the flag results cannot be fetched', async () => {
    const { server, ring } = await setUp({ flags: 'down' });
    expect(refusal(await server.check(write(await personToken(ring))))).toMatchObject({ kind: 'unavailable', status: 503, code: 'workspace-state-unavailable' });
    await server.close();
  });

  it('lets a write through in an active, paid workspace, and hands back the flag results it read', async () => {
    const { server, ring, requests } = await setUp({ flags: [ACTIVE, PAID, { key: 'reports', value: true, reason: 'STATIC' }] });
    const result = await server.check(write(await personToken(ring)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flags?.enabled('reports')).toBe(true);
    expect(flagCalls(requests)).toBe(1);
    await server.close();
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('never refuses a %s, even in a suspended, locked workspace', async (method) => {
    const { server, ring, requests } = await setUp({ flags: [{ ...ACTIVE, value: false }, LOCKED] });
    const result = await server.check({ ...withBearer(await personToken(ring, { wst: 'suspended' })), method });
    expect(result.ok).toBe(true);
    expect(flagCalls(requests)).toBe(0);
    await server.close();
  });

  it('takes the method from the options when the request carries none, and from a Fetch Request', async () => {
    const { server, ring } = await setUp({ flags: [ACTIVE, LOCKED] });
    const token = await personToken(ring);
    expect(refusal(await server.check(withBearer(token), { method: 'DELETE' }))).toMatchObject({ status: 402 });
    const request = new Request('https://app.test/notes', { method: 'PUT', headers: { authorization: `Bearer ${token}` } });
    expect(refusal(await server.check(request))).toMatchObject({ status: 402 });
    expect((await server.check(withBearer(token))).ok).toBe(true);
    await server.close();
  });

  it('does not touch a token that names no workspace', async () => {
    const { server, ring } = await setUp({ flags: [{ ...ACTIVE, value: false }, LOCKED] });
    const now = Math.floor(Date.now() / 1000);
    const noWorkspace = await mint(ring.app, { aid: APP, sid: 'ses-1', privileges: [], client_id: APP, auth_time: now, jti: 'jti-2' }, { issuer: ISSUER, audience: AUDIENCE, subject: 'usr-alice', typ: 'at+jwt' });
    expect((await server.check(write(noWorkspace))).ok).toBe(true);
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

describe('server: gauges, strict limits and quotas', () => {
  const HOLDS = `${ORIGIN}/v2/billing/usage/holds`;
  const HOLD_ID = 'a'.repeat(24);
  const sent = (requests: Setup['requests'], suffix: string) => requests.filter((request) => request.url.endsWith(suffix));

  it('sets a gauge level like a count: the level is the quantity, a newer level for the metric replaces the one waiting', async () => {
    const { server, ring, requests } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    server.usage.set(actor, 'projects', 3);
    server.usage.set(actor, 'storage.gb', 10);
    server.usage.set(actor, 'projects', 4);
    server.usage.count(actor, 'api.calls');
    expect(server.usage.pending()).toBe(3);
    await server.usage.flush();
    const body = sent(requests, '/v2/billing/usage')[0]!.body as { reports: Record<string, unknown>[] };
    expect(body.reports.map(({ metric, quantity, workspace }) => ({ metric, quantity, workspace }))).toEqual([
      { metric: 'storage.gb', quantity: 10, workspace: 'ws-acme' },
      { metric: 'projects', quantity: 4, workspace: 'ws-acme' },
      { metric: 'api.calls', quantity: 1, workspace: 'ws-acme' },
    ]);
    // Nothing but Bridge's own report fields goes over the wire.
    expect(Object.keys(body.reports[1]!).sort()).toEqual(['id', 'metric', 'quantity', 'time', 'workspace']);
    await server.close();
  });

  it('refuses a level that is not a number of 0 or more, a metric that is not a name, and setting without the app key', async () => {
    const { server, ring } = await setUp();
    const actor = await server.verify(withBearer(await personToken(ring)));
    expect(() => server.usage.set(actor, 'projects', -1)).toThrow(BridgeError);
    expect(() => server.usage.set(actor, 'projects', Number.NaN)).toThrow(BridgeError);
    expect(() => server.usage.set(actor, 'Projects', 1)).toThrow(BridgeError);
    const keyless = await setUp({ appKey: '' });
    const keylessActor = await keyless.server.verify(withBearer(await personToken(keyless.ring)));
    expect(() => keyless.server.usage.set(keylessActor, 'projects', 1)).toThrow(/app key/);
    await server.close();
    await keyless.server.close();
  });

  it('holds a unit with the app key and the workspace, then confirms it once', async () => {
    const { server, ring, requests } = await setUp({
      respond: (request) => {
        if (request.url === HOLDS) return Response.json({ id: HOLD_ID, metric: 'projects', limit: 5, used: 3, expiresInSeconds: 120 }, { status: 201 });
        if (request.url === `${HOLDS}/${HOLD_ID}/confirm`) return Response.json({ confirmed: true });
        return undefined;
      },
    });
    const actor = await server.verify(withBearer(await personToken(ring)));
    const hold = await server.usage.hold(actor, 'projects', { decision: 'req-1', quantity: 2 });
    expect(hold).toMatchObject({ id: HOLD_ID, metric: 'projects', limit: 5, used: 3, expiresInSeconds: 120 });
    const [made] = sent(requests, '/usage/holds');
    expect(made!.method).toBe('POST');
    expect(made!.headers.get('x-api-key')).toBe('app-key-1');
    expect(made!.headers.get('authorization')).toBeNull();
    expect(made!.headers.get('bridge-workspace')).toBe('ws-acme');
    expect(made!.body).toEqual({ metric: 'projects', decision: 'req-1', quantity: 2 });
    await hold.confirm();
    await hold.confirm();
    expect(sent(requests, '/confirm')).toHaveLength(1);
    expect(sent(requests, '/confirm')[0]!.headers.get('bridge-workspace')).toBe('ws-acme');
    await server.close();
  });

  it('gives a held unit back with a DELETE, once, and a hold already gone is not an error; confirming one that is gone is', async () => {
    let gone = false;
    const { server, ring, requests } = await setUp({
      respond: (request) => {
        if (request.url === HOLDS) return Response.json({ id: HOLD_ID, metric: 'projects', limit: 5, used: 3, expiresInSeconds: 120 }, { status: 201 });
        if (request.url === `${HOLDS}/${HOLD_ID}`) return gone ? Response.json({ status: 404 }, { status: 404 }) : new Response(null, { status: 204 });
        if (request.url === `${HOLDS}/${HOLD_ID}/confirm`) return Response.json({ status: 404 }, { status: 404 });
        return undefined;
      },
    });
    const actor = await server.verify(withBearer(await personToken(ring)));
    const first = await server.usage.hold(actor, 'projects');
    await first.giveBack();
    await first.giveBack();
    expect(sent(requests, `/holds/${HOLD_ID}`).filter((request) => request.method === 'DELETE')).toHaveLength(1);
    gone = true;
    const second = await server.usage.hold(actor, 'projects');
    await expect(second.giveBack()).resolves.toBeUndefined();
    const third = await server.usage.hold(actor, 'projects');
    await expect(third.confirm()).rejects.toMatchObject({ kind: 'not-found' });
    await server.close();
  });

  it('asks for a new decision each time unless one is given, and refuses a quantity that is not a whole number from 1', async () => {
    const { server, ring, requests } = await setUp({ respond: (request) => (request.url === HOLDS ? Response.json({ id: HOLD_ID, metric: 'projects', limit: 5, used: 0, expiresInSeconds: 120 }, { status: 201 }) : undefined) });
    const actor = await server.verify(withBearer(await personToken(ring)));
    await server.usage.hold(actor, 'projects');
    await server.usage.hold(actor, 'projects');
    const decisions = sent(requests, '/usage/holds').map((request) => (request.body as { decision: string }).decision);
    expect(new Set(decisions).size).toBe(2);
    await expect(server.usage.hold(actor, 'projects', { quantity: 0 })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(server.usage.hold(actor, 'projects', { quantity: 1.5 })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(server.usage.hold(actor, 'Projects')).rejects.toMatchObject({ kind: 'invalid' });
    await server.close();
  });

  it('answers a limit that is reached as plan-required with the metric, limit and use, and as 0.9\'s QUOTA_EXCEEDED body', async () => {
    const { server, ring } = await setUp({
      respond: (request) =>
        request.url === HOLDS
          ? Response.json(
              { reason: 'limit_reached', metric: 'projects', limit: 5, used: 5, type: 'urn:bridge:problem:limit-reached', title: 'Payment Required', status: 402, detail: "The plan's limit on projects is reached." },
              { status: 402, headers: { 'content-type': 'application/problem+json' } },
            )
          : undefined,
    });
    const actor = await server.verify(withBearer(await personToken(ring)));
    const error = await server.usage.hold(actor, 'projects').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ kind: 'plan-required', status: 402, code: 'limit-reached', quota: { metric: 'projects', limit: 5, used: 5 } });
    expect(isLimitReached(error)).toBe(true);
    expect(quotaExceededBody(error as BridgeError)).toEqual({ statusCode: 402, code: 'QUOTA_EXCEEDED', message: 'Your plan allows 5 projects; 5 are in use.', metric: 'projects', used: 5, limit: 5, fix: '/subscription' });
    expect(quotaExceededBody(error as BridgeError, '/billing').fix).toBe('/billing');
    expect(quotaExceededBody({ metric: 'seats', limit: 3, used: 3 }).code).toBe('QUOTA_EXCEEDED');
    expect(isLimitReached(new BridgeError('plan-required', 'x', { status: 402, code: 'billing-locked' }))).toBe(false);
    await server.close();
  });

  it('throws when Bridge cannot answer a hold, so a limit that could not be checked is not a yes', async () => {
    const { server, ring } = await setUp({ respond: (request) => (request.url === HOLDS ? new Response(null, { status: 503 }) : undefined) });
    const actor = await server.verify(withBearer(await personToken(ring)));
    await expect(server.usage.hold(actor, 'projects')).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    await server.close();
  });

  it('needs the app key, and a workspace, to hold or read a limit', async () => {
    const keyless = await setUp({ appKey: '' });
    const keylessActor = await keyless.server.verify(withBearer(await personToken(keyless.ring)));
    await expect(keyless.server.usage.hold(keylessActor, 'projects')).rejects.toMatchObject({ kind: 'misconfigured' });
    await expect(keyless.server.usage.quota(keylessActor, 'projects')).rejects.toMatchObject({ kind: 'misconfigured' });
    await keyless.server.close();
    const { server, ring } = await setUp();
    const noWorkspace = await server.verify(withBearer(await mint(ring.app, { aid: APP, sid: 'ses-1', privileges: [], client_id: APP, auth_time: Math.floor(Date.now() / 1000), jti: 'jti-9' }, { issuer: ISSUER, audience: AUDIENCE, subject: 'usr-alice', typ: 'at+jwt' })));
    await expect(server.usage.hold(noWorkspace, 'projects')).rejects.toMatchObject({ kind: 'invalid' });
    await expect(server.usage.hold(noWorkspace, 'projects', { workspace: 'bad id!' })).rejects.toMatchObject({ kind: 'invalid' });
    await server.close();
  });

  it('reads a metric\'s quota with the app key and the workspace, in the shape 0.9 read, and null where the plan sets no limit', async () => {
    const { server, ring, requests } = await setUp({
      respond: (request) => {
        if (request.url === `${ORIGIN}/v2/billing/usage/quota/projects`) return Response.json({ metric: 'projects', used: 4, limit: 5, remaining: 1, warningLevel: 'approaching', policy: 'hard', kind: 'gauge' });
        if (request.url === `${ORIGIN}/v2/billing/usage/quota/exports.made`) return Response.json(null);
        return undefined;
      },
    });
    const actor = await server.verify(withBearer(await personToken(ring)));
    const quota = await server.usage.quota(actor, 'projects');
    expect(quota).toEqual({ metric: 'projects', used: 4, limit: 5, remaining: 1, percent_used: 0.8, policy: 'hard', kind: 'gauge', warningLevel: 'approaching', label: 'projects', overcap: false });
    const [read] = sent(requests, '/usage/quota/projects');
    expect(read!.method).toBe('GET');
    expect(read!.headers.get('x-api-key')).toBe('app-key-1');
    expect(read!.headers.get('bridge-workspace')).toBe('ws-acme');
    expect(await server.usage.quota(actor, 'exports.made')).toBeNull();
    await server.close();
  });
});
