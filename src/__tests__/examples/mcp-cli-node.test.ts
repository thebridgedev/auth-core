// @vitest-environment node
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, makeKeyRing, mint, type KeyRing } from '../verifier/fixtures.js';
import { fakeRevocationList, makeLaneKey, type LaneKey } from '../verifier/revocation-fixtures.js';

/**
 * The plain Node example (examples/mcp-cli-node), end to end against a fake
 * issuer: its MCP endpoint through the official MCP SDK, and its API route.
 * Runs only once the example's dependencies are installed and the package is
 * built (`npm run build && cd examples/mcp-cli-node && npm install`).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const example = resolve(root, 'examples/mcp-cli-node');
const installed = existsSync(resolve(example, 'node_modules/@modelcontextprotocol/sdk')) && existsSync(resolve(root, 'dist/server/index.js'));

const ORIGIN = 'https://bridge.test';
const ISSUER = `${ORIGIN}/identity-access/apps/${APP}`;
const AUDIENCE = `${ORIGIN}/api`;
const LIST = `${ORIGIN}/v2/lanes`;
const JWKS = `${ORIGIN}/v2/identity-access/apps/${APP}/jwks.json`;
const LANES = ['identity-access', 'accounts', 'billing', 'app-registry'] as const;

describe.skipIf(!installed)('the plain Node example', () => {
  let ring: KeyRing;
  let server: Server;
  let base: string;
  let app: { close(): Promise<void>; handle(req: unknown, res: unknown): Promise<void> };

  beforeAll(async () => {
    ring = await makeKeyRing();
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
      if (new Request(input, init).url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(metadata);
      return list.fetch(input, init);
    }) as typeof fetch;
    server = createServer((req, res) => void app.handle(req, res));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const path = resolve(example, 'app.mjs');
    const { createAcmeApp } = (await import(/* @vite-ignore */ path)) as { createAcmeApp: (options: unknown) => typeof app };
    app = createAcmeApp({ issuer: ISSUER, resource: `${base}/mcp`, fetch: fetchFn });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((done) => server?.close(() => done()));
  });

  const token = (audience: string, clientId: string) =>
    mint(
      ring.app,
      { aid: APP, tid: 'ws-acme', role: 'MEMBER', privileges: ['invoices:read'], sid: 'ses-1', client_id: clientId, scope: 'management', email: 'anna@acme.test' },
      { issuer: ISSUER, audience, subject: 'usr-anna' },
    );

  async function callTool(bearer?: string) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
  }

  it('serves its metadata and tells an assistant without a token where to sign in', async () => {
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(metadata).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [ISSUER], resource_name: 'Acme' });
    const refused = await callTool();
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("the tool gets the assistant's person, workspace and privileges", async () => {
    const answer = await callTool(await token(`${base}/mcp`, 'claude'));
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(body.result.structuredContent).toMatchObject({ user: 'usr-anna', workspace: 'ws-acme', privileges: ['invoices:read'], mayDelete: false, client: { id: 'claude', kind: 'assistant' } });
  });

  it("the CLI's own token works at /mcp too", async () => {
    const body = (await (await callTool(await token(AUDIENCE, APP))).json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(body.result.structuredContent).toMatchObject({ user: 'usr-anna', client: { id: APP, kind: 'app' } });
  });

  it("the API refuses an assistant's token and takes the app's own", async () => {
    const assistant = await fetch(`${base}/api/invoices`, { headers: { Authorization: `Bearer ${await token(`${base}/mcp`, 'claude')}` } });
    expect(assistant.status).toBe(401);
    const own = await fetch(`${base}/api/invoices`, { headers: { Authorization: `Bearer ${await token(AUDIENCE, APP)}` } });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { invoices: unknown[] }).invoices).toHaveLength(2);
  });
});
