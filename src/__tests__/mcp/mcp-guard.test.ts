// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  bridgeMcpGuard,
  createBridgeServer,
  mcpChallenge,
  protectedResourceMetadata,
  protectedResourceMetadataPaths,
  protectedResourceMetadataUrl,
  type McpGuardOptions,
} from '../../server/index.js';
import { bridgeMcpMiddleware, type McpIncomingMessage } from '../../server/node.js';
import { APP, OTHER_APP, makeKeyRing, mint, type KeyRing } from '../verifier/fixtures.js';
import { fakeRevocationList, makeLaneKey, type LaneKey } from '../verifier/revocation-fixtures.js';

/**
 * The guard in MCP mode, against tokens shaped like the ones Identity and
 * Access issues: an assistant's (`aud` = the MCP endpoint), the app's own
 * (`aud` = the app's audience: web app, CLI), and tokens it must refuse.
 */

const ORIGIN = 'https://bridge.test';
const ISSUER = `${ORIGIN}/identity-access/apps/${APP}`;
const BRIDGE_ISSUER = `${ORIGIN}/identity-access/apps/app-bridge`;
const AUDIENCE = `${ORIGIN}/api`;
const RESOURCE = 'https://acme.example/mcp';
const LIST = `${ORIGIN}/v2/lanes`;
const JWKS = `${ORIGIN}/v2/identity-access/apps/${APP}/jwks.json`;
const LANES = ['identity-access', 'accounts', 'billing', 'app-registry'] as const;

async function setUp(options: Partial<McpGuardOptions> = {}) {
  const ring = await makeKeyRing();
  const laneKeys: Record<string, LaneKey> = {};
  for (const lane of LANES) laneKeys[lane] = await makeLaneKey(lane);
  const list = fakeRevocationList(laneKeys, APP, () => Date.now(), { list: LIST, jwks: JWKS });
  list.setKeys({ keys: [ring.app.publicJwk, ...Object.values(laneKeys).map((key) => key.publicJwk)] });
  const metadata = {
    issuer: ISSUER,
    token_endpoint: `${ORIGIN}/v2/identity-access/apps/${APP}/token`,
    jwks_uri: JWKS,
    bridge_app: APP,
    bridge_access_token_audience: AUDIENCE,
    bridge_revocation_lanes: Object.fromEntries(LANES.map((lane) => [lane, `${LIST}/${lane}`])),
    bridge_endpoints: { '2': { sign_in: `${ORIGIN}/v2/identity-access/apps/${APP}/sign-in`, accounts: `${ORIGIN}/v2/accounts` } },
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(metadata);
    return list.fetch(input, init);
  }) as typeof fetch;
  const guard = bridgeMcpGuard({ issuer: ISSUER, resource: RESOURCE, resourceName: 'Acme', fetch: fetchFn, ...options });
  const normal = createBridgeServer({ issuer: ISSUER, fetch: fetchFn });
  return { ring, list, guard, normal, fetchFn };
}

/** A token as Identity and Access issues it. `audience` is the MCP endpoint for an assistant's token. */
function token(ring: KeyRing, overrides: Record<string, unknown> = {}, options: { audience?: string; issuer?: string; key?: 'app' | 'otherApp'; expiresIn?: string | number } = {}) {
  return mint(
    options.key === 'otherApp' ? ring.otherApp : ring.app,
    {
      aid: APP,
      tid: 'ws-acme',
      mid: 'mem-1',
      role: 'MEMBER',
      wst: 'active',
      privileges: ['invoices:read', 'invoices:write'],
      sid: 'ses-1',
      client_id: 'claude',
      scope: 'management',
      app_access: APP,
      email: 'anna@acme.test',
      jti: 'jti-1',
      ...overrides,
    },
    { issuer: options.issuer ?? ISSUER, audience: options.audience ?? RESOURCE, subject: 'usr-anna', ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }) },
  );
}

const withBearer = (value: string) => ({ headers: { authorization: `Bearer ${value}` } });

describe('MCP mode: the protected-resource metadata (RFC 9728)', () => {
  it('names the endpoint, the app issuer as its authorization server, header bearer tokens and offline_access', () => {
    expect(protectedResourceMetadata({ issuer: ISSUER, resource: RESOURCE, resourceName: 'Acme' })).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['offline_access'],
      resource_name: 'Acme',
    });
    expect(protectedResourceMetadata({ issuer: ISSUER, resource: RESOURCE })).not.toHaveProperty('resource_name');
  });

  it('is served at the well-known path plus the endpoint path, and at the plain root', () => {
    expect(protectedResourceMetadataUrl(RESOURCE)).toBe('https://acme.example/.well-known/oauth-protected-resource/mcp');
    expect(protectedResourceMetadataPaths(RESOURCE)).toEqual(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
    expect(protectedResourceMetadataUrl('https://acme.example/')).toBe('https://acme.example/.well-known/oauth-protected-resource');
    expect(protectedResourceMetadataPaths('https://acme.example')).toEqual(['/.well-known/oauth-protected-resource']);
    expect(protectedResourceMetadataUrl('http://localhost:4000/api/mcp')).toBe('http://localhost:4000/.well-known/oauth-protected-resource/api/mcp');
  });

  it('refuses an endpoint address that is plain http off this machine, or has a query or fragment', () => {
    expect(() => protectedResourceMetadata({ issuer: ISSUER, resource: 'http://acme.example/mcp' })).toThrow(/https/);
    expect(() => protectedResourceMetadata({ issuer: ISSUER, resource: 'https://acme.example/mcp?x=1' })).toThrow(/query or fragment/);
    expect(() => protectedResourceMetadata({ issuer: ISSUER, resource: 'https://acme.example/mcp#x' })).toThrow(/query or fragment/);
  });

  it('the guard answers GET and HEAD on both paths with the document, readable from any origin', async () => {
    const { guard } = await setUp();
    expect(guard.isMetadataRequest({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).toBe(true);
    expect(guard.isMetadataRequest({ method: 'HEAD', url: 'https://acme.example/.well-known/oauth-protected-resource' })).toBe(true);
    expect(guard.isMetadataRequest({ method: 'POST', url: '/.well-known/oauth-protected-resource/mcp' })).toBe(false);
    expect(guard.isMetadataRequest({ method: 'GET', url: '/mcp' })).toBe(false);
    const response = guard.metadataResponse();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual(guard.metadata());
    await guard.close();
  });
});

describe('MCP mode: the 401 that tells an assistant where to sign in', () => {
  it('without a token: 401 and WWW-Authenticate with resource_metadata only', async () => {
    const { guard } = await setUp();
    const answer = await guard.check({ headers: {} });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusal.status).toBe(401);
    expect(answer.refusal.reason).toBe('missing');
    expect(answer.refusal.headers['WWW-Authenticate']).toBe('Bearer resource_metadata="https://acme.example/.well-known/oauth-protected-resource/mcp"');
    await guard.close();
  });

  it('a key in x-api-key is not a bearer token: still told to sign in', async () => {
    const { guard } = await setUp();
    const answer = await guard.check({ headers: { 'x-api-key': 'key-1' } });
    expect(answer.ok ? null : answer.refusal.reason).toBe('missing');
    await guard.close();
  });

  it('with a refused token: error="invalid_token" too, and a description', async () => {
    const { guard } = await setUp();
    const answer = await guard.check(withBearer('not-a-token'));
    if (answer.ok) throw new Error('accepted');
    expect(answer.refusal.headers['WWW-Authenticate']).toMatch(/^Bearer resource_metadata="https:\/\/acme\.example\/\.well-known\/oauth-protected-resource\/mcp", error="invalid_token", error_description="[^"]+"$/);
    expect(answer.refusal.body.error).toBe('invalid_token');
    await guard.close();
  });

  it('quotes header values safely', () => {
    expect(mcpChallenge('https://a.example/x', { description: 'say "hi"\r\nnow' })).toBe('Bearer resource_metadata="https://a.example/x", error="invalid_token", error_description="say \\"hi\\" now"');
  });

  it('as a Fetch handler: metadata, CORS preflight, 401 with the header, and the caller for a good token', async () => {
    const { guard, ring } = await setUp();
    const handler = guard.protect((_request, caller) => Response.json({ user: caller.userId }));
    expect((await handler(new Request('https://acme.example/.well-known/oauth-protected-resource/mcp'))).status).toBe(200);
    expect((await handler(new Request(RESOURCE, { method: 'OPTIONS' }))).status).toBe(204);
    const refused = await handler(new Request(RESOURCE, { method: 'POST' }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(refused.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate');
    const ok = await handler(new Request(RESOURCE, { method: 'POST', headers: { authorization: `Bearer ${await token(ring)}` } }));
    expect(await ok.json()).toEqual({ user: 'usr-anna' });
    await guard.close();
  });
});

describe('MCP mode: which tokens open the endpoint', () => {
  it("accepts an assistant's token for this endpoint, and gives the user, workspace, privileges, delete and client", async () => {
    const { guard, ring } = await setUp();
    const answer = await guard.check(withBearer(await token(ring)));
    if (!answer.ok) throw new Error(answer.refusal.reason);
    const { caller } = answer;
    expect(caller).toMatchObject({
      kind: 'person',
      id: 'usr-anna',
      userId: 'usr-anna',
      workspaceId: 'ws-acme',
      role: 'MEMBER',
      privileges: ['invoices:read', 'invoices:write'],
      scopes: ['management'],
      mayDelete: false,
      client: { id: 'claude', kind: 'assistant' },
      appId: APP,
      sessionId: 'ses-1',
      email: 'anna@acme.test',
      standing: 'active',
    });
    expect(Object.isFrozen(caller)).toBe(true);
    await guard.close();
  });

  it('may delete when deleting was allowed at consent', async () => {
    const { guard, ring } = await setUp();
    const answer = await guard.check(withBearer(await token(ring, { scope: 'management delete', privileges: ['invoices:read', 'invoices:delete'] })));
    expect(answer.ok && answer.caller.mayDelete).toBe(true);
    await guard.close();
  });

  it("accepts the app's own tokens (web app, CLI), marked as the app's", async () => {
    const { guard, ring } = await setUp();
    const web = await guard.check(withBearer(await token(ring, { client_id: APP, scope: undefined }, { audience: AUDIENCE })));
    if (!web.ok) throw new Error(web.refusal.reason);
    expect(web.caller.client).toEqual({ id: APP, kind: 'app' });
    expect(web.caller.mayDelete).toBe(true);
    const cli = await guard.check(withBearer(await token(ring, { client_id: APP, scope: 'management' }, { audience: AUDIENCE })));
    expect(cli.ok && cli.caller.mayDelete).toBe(false);
    await guard.close();
  });

  it("refuses the app's own tokens when told to accept only the endpoint's", async () => {
    const { guard, ring } = await setUp({ acceptAppTokens: false });
    const answer = await guard.check(withBearer(await token(ring, {}, { audience: AUDIENCE })));
    expect(answer.ok ? null : answer.refusal.reason).toBe('wrong_audience');
    await guard.close();
  });

  it.each([
    ['another endpoint of the app', {}, { audience: 'https://other.acme.example/mcp' }, 'wrong_audience'],
    ['the same endpoint with a trailing slash (audiences match exactly)', {}, { audience: `${RESOURCE}/` }, 'wrong_audience'],
    ['another app (its own key and issuer)', { aid: OTHER_APP }, { key: 'otherApp' as const, issuer: `${ORIGIN}/identity-access/apps/${OTHER_APP}` }, 'unknown_key'],
    ['another app signed with this key set but naming another aid', { aid: OTHER_APP }, {}, 'wrong_app'],
    ["Bridge's own MCP server (the Bridge App's issuer)", { aid: 'app-bridge' }, { issuer: BRIDGE_ISSUER, audience: `${ORIGIN}/mcp` }, 'wrong_issuer'],
    ['an expired token', {}, { expiresIn: Math.floor(Date.now() / 1000) - 60 }, 'expired'],
    ["an expired app token", {}, { audience: AUDIENCE, expiresIn: Math.floor(Date.now() / 1000) - 60 }, 'expired'],
  ] as const)('refuses a token for %s', async (_, claims, options, reason) => {
    const { guard, ring } = await setUp();
    const answer = await guard.check(withBearer(await token(ring, claims, options)));
    if (answer.ok) throw new Error('accepted');
    expect(answer.refusal.reason).toBe(reason);
    expect(answer.refusal.status).toBe(401);
    expect(answer.refusal.headers['WWW-Authenticate']).toContain('error="invalid_token"');
    await guard.close();
  });

  it("refuses an endpoint token that is not a person's (an assistant always acts for one)", async () => {
    const { guard, ring } = await setUp();
    const answer = await guard.check(withBearer(await token(ring, { kind: 'job' })));
    expect(answer.ok ? null : answer.refusal.reason).toBe('wrong_type');
    await guard.close();
  });

  it('follows the revocation list: a connection ended in Connected tools is refused', async () => {
    const { guard, ring, list } = await setUp({ revocationIntervalMs: 20 });
    const value = await token(ring);
    expect((await guard.check(withBearer(value))).ok).toBe(true);
    await list.revoke('identity-access', { kind: 'session', id: 'ses-1' });
    let answer = await guard.check(withBearer(value));
    for (let tries = 0; answer.ok && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      answer = await guard.check(withBearer(value));
    }
    expect(answer.ok ? null : answer.refusal.reason).toBe('revoked');
    // The app's own tokens of that session too.
    const app = await guard.check(withBearer(await token(ring, {}, { audience: AUDIENCE })));
    expect(app.ok ? null : app.refusal.reason).toBe('revoked');
    await guard.close();
  });

  it('answers 503, never yes, while the issuer cannot be read', async () => {
    const guard = bridgeMcpGuard({ issuer: ISSUER, resource: RESOURCE, fetch: (async () => new Response(null, { status: 503 })) as typeof fetch });
    const answer = await guard.check(withBearer('a.b.c'));
    expect(answer.ok ? null : answer.refusal.status).toBe(503);
    await guard.close();
  });

  it("refuses to start when the endpoint's address is the app's own audience", async () => {
    const { ring, fetchFn } = await setUp();
    const guard = bridgeMcpGuard({ issuer: ISSUER, resource: AUDIENCE, fetch: fetchFn });
    const answer = await guard.check(withBearer(await token(ring, {}, { audience: AUDIENCE })));
    expect(answer.ok ? null : answer.refusal.status).toBe(503);
    await guard.close();
  });
});

describe('the normal guard never accepts an assistant token', () => {
  it("refuses a token issued for the MCP endpoint, and accepts the app's own", async () => {
    const { normal, ring, guard } = await setUp();
    const assistant = await normal.check(withBearer(await token(ring)));
    expect(assistant.ok ? null : { status: assistant.error.status, code: assistant.error.code }).toEqual({ status: 401, code: 'wrong_audience' });
    const own = await normal.check(withBearer(await token(ring, { client_id: APP }, { audience: AUDIENCE })));
    expect(own.ok).toBe(true);
    await normal.close();
    await guard.close();
  });
});

describe('bridgeMcpMiddleware for Node http and Express-style apps', () => {
  async function serve(guard: ReturnType<typeof bridgeMcpGuard>) {
    const middleware = bridgeMcpMiddleware(guard);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void middleware(req, res, () => {
        const request = req as McpIncomingMessage;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ caller: request.bridge?.caller.userId, auth: { clientId: request.auth?.clientId, scopes: request.auth?.scopes, caller: request.auth?.extra.caller.workspaceId } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('serves the metadata, refuses without a token, and puts the caller on req.bridge and req.auth', async () => {
    const { guard, ring } = await setUp();
    const { base, close } = await serve(guard);
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect((await metadata.json()).resource).toBe(RESOURCE);
    const refused = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${protectedResourceMetadataUrl(RESOURCE)}"`);
    const ok = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${await token(ring)}` } });
    expect(await ok.json()).toEqual({ caller: 'usr-anna', auth: { clientId: 'claude', scopes: ['management'], caller: 'ws-acme' } });
    await close();
    await guard.close();
  });
});
