import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BridgeError } from '../../core/errors.js';
import { createBridgeManagement, type ManagementOptions } from '../../server/index.js';

/**
 * The management client against a fake Bridge: it speaks Bridge's version 2 API with the app key, keeps 0.8's names,
 * and never sends the key anywhere but `x-api-key`.
 */

const ORIGIN = 'https://bridge.test';
const ISSUER = `${ORIGIN}/identity-access/apps/app-1`;
const KEY = 'app-key-secret';

const everything: Seen[] = [];

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

function setUp(respond: (seen: Seen) => Response | undefined = () => undefined, options: Partial<ManagementOptions> = {}, endpoints: Record<string, string> | null = null) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        token_endpoint: `${ORIGIN}/v2/identity-access/apps/app-1/token`,
        authorization_challenge_endpoint: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`,
        bridge_app: 'app-1',
        bridge_api_version: 2,
        bridge_endpoints: {
          '2': endpoints ?? {
            sign_in: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`,
            token: `${ORIGIN}/v2/identity-access/apps/app-1/token`,
            accounts: `${ORIGIN}/v2/accounts`,
            billing: `${ORIGIN}/v2/billing`,
            flags: `${ORIGIN}/v2/flags`,
            events_and_logs: `${ORIGIN}/v2/events-and-logs`,
          },
        },
      });
    }
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    const entry: Seen = { method: request.method, url: new URL(request.url), headers: request.headers, body: text === '' ? undefined : JSON.parse(text) };
    seen.push(entry);
    everything.push(entry);
    return respond(entry) ?? Response.json({});
  }) as typeof fetch;
  const mgmt = createBridgeManagement({ issuer: ISSUER, appKey: KEY, fetch: fetchFn, ...options });
  return { mgmt, seen };
}

const last = <T,>(list: T[]): T => list[list.length - 1] as T;

describe('management client: the app key, and where it goes', () => {
  it('sends the key as x-api-key only, to the addresses the issuer listed', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.workspaces.list();
    expect(last(seen).url.href).toBe(`${ORIGIN}/v2/accounts/workspaces`);
    expect(last(seen).headers.get('x-api-key')).toBe(KEY);
    expect(last(seen).headers.get('authorization')).toBeNull();
    expect(last(seen).url.href).not.toContain(KEY);
    expect(JSON.stringify(last(seen).body ?? null)).not.toContain(KEY);
  });

  it('needs the key, and an issuer or a server', () => {
    expect(() => createBridgeManagement({ issuer: ISSUER, appKey: '' })).toThrowError(BridgeError);
    expect(() => createBridgeManagement({ appKey: KEY })).toThrowError(/issuer/);
  });

  it('refuses to run where a window and a document exist', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals['window'] = {};
    globals['document'] = {};
    try {
      expect(() => createBridgeManagement({ issuer: ISSUER, appKey: KEY })).toThrowError(/never in a browser/);
    } finally {
      delete globals['window'];
      delete globals['document'];
    }
  });

  it('turns a refusal into a BridgeError of the right kind, and a hang into network', async () => {
    const { mgmt } = setUp(() => Response.json({ type: 'urn:bridge:problem:forbidden', title: 'Forbidden', status: 403, detail: 'No.' }, { status: 403 }));
    await expect(mgmt.roles.list()).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
    const slow = createBridgeManagement({
      issuer: ISSUER,
      appKey: KEY,
      timeoutMs: 20,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('openid-configuration')) {
          return Response.json({ issuer: ISSUER, token_endpoint: `${ORIGIN}/v2/identity-access/apps/app-1/token`, authorization_challenge_endpoint: 'x', bridge_app: 'app-1', bridge_endpoints: { '2': { sign_in: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`, token: `${ORIGIN}/v2/identity-access/apps/app-1/token`, accounts: `${ORIGIN}/v2/accounts` } } });
        }
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }) as typeof fetch,
    });
    await expect(slow.roles.list()).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('management client: workspaces and users, with 0.8 names', () => {
  it('lists, reads, makes, changes, suspends and deletes workspaces; `tenants` is the same', async () => {
    const { mgmt, seen } = setUp();
    expect(mgmt.tenants).toBe(mgmt.workspaces);
    await mgmt.workspaces.get('ws-1');
    expect([last(seen).method, last(seen).url.pathname, last(seen).headers.get('bridge-workspace')]).toEqual(['GET', '/v2/accounts/workspace', 'ws-1']);
    await mgmt.workspaces.create({ name: 'Acme', owner: { email: 'a@acme.test' } });
    expect([last(seen).method, last(seen).url.pathname, last(seen).body]).toEqual(['POST', '/v2/accounts/workspaces', { name: 'Acme', owner: { email: 'a@acme.test' } }]);
    await mgmt.workspaces.update('ws-1', { name: 'New' });
    expect([last(seen).method, last(seen).url.pathname, last(seen).headers.get('bridge-workspace')]).toEqual(['PATCH', '/v2/accounts/workspace', 'ws-1']);
    await mgmt.workspaces.suspend('ws-1');
    expect(last(seen).url.pathname).toBe('/v2/accounts/workspace/suspend');
    await mgmt.workspaces.delete('ws-1');
    expect(last(seen).method).toBe('DELETE');
    await mgmt.workspaces.setSubscription('ws-1', { plan: 'pro' });
    expect([last(seen).method, last(seen).url.pathname, last(seen).body]).toEqual(['PUT', '/v2/billing/payer/subscription', { plan: 'pro' }]);
    expect(() => mgmt.workspaces.get('')).toThrowError(/workspaceId/);
  });

  it('keeps 0.8\'s users calls: list, get, invite, update, remove, each for one workspace', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.users.list('ws-1');
    expect([last(seen).url.pathname, last(seen).headers.get('bridge-workspace')]).toEqual(['/v2/accounts/members', 'ws-1']);
    await mgmt.users.get('ws-1', 'mem 1');
    expect(last(seen).url.pathname).toBe('/v2/accounts/members/mem%201');
    // 0.8 called the address `username`.
    await mgmt.users.invite('ws-1', { username: 'bob@acme.test', role: 'ADMIN' });
    expect([last(seen).method, last(seen).url.pathname, last(seen).body]).toEqual(['POST', '/v2/accounts/members', { role: 'ADMIN', email: 'bob@acme.test' }]);
    await mgmt.users.update('ws-1', 'mem-1', { role: 'USER' });
    expect(last(seen).method).toBe('PATCH');
    await mgmt.users.remove('ws-1', 'mem-1');
    expect(last(seen).method).toBe('DELETE');
    expect(() => mgmt.users.invite('ws-1', { role: 'ADMIN' })).toThrowError(/email address/);
  });

  it('suspends and resumes a person of the app, and handles invites', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.users.suspend('usr-1');
    expect(last(seen).url.pathname).toBe('/v2/accounts/users/usr-1/suspend');
    await mgmt.users.resume('usr-1');
    expect(last(seen).url.pathname).toBe('/v2/accounts/users/usr-1/resume');
    await mgmt.invites.send('ws-1', { email: 'c@acme.test', role: 'USER' });
    expect([last(seen).method, last(seen).url.pathname, last(seen).headers.get('bridge-workspace')]).toEqual(['POST', '/v2/accounts/invites', 'ws-1']);
    await mgmt.invites.cancel('ws-1', 'inv-1');
    expect(last(seen).url.pathname).toBe('/v2/accounts/invites/inv-1');
  });
});

describe('management client: roles, privileges, plans and events', () => {
  it('manages roles and privileges', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.roles.create({ key: 'EDITOR', name: 'Editor', privileges: ['notes:write'] });
    expect([last(seen).method, last(seen).url.pathname]).toEqual(['POST', '/v2/accounts/roles']);
    await mgmt.roles.update('r-1', { name: 'Ed' });
    expect([last(seen).method, last(seen).url.pathname]).toEqual(['PATCH', '/v2/accounts/roles/r-1']);
    await mgmt.roles.delete('r-1');
    await mgmt.roles.listPrivileges();
    expect(last(seen).url.pathname).toBe('/v2/accounts/privileges');
    await mgmt.roles.createPrivilege({ key: 'notes:write' });
    await mgmt.roles.updatePrivilege('p-1', { description: 'x' });
    await mgmt.roles.deletePrivilege('p-1');
    expect([last(seen).method, last(seen).url.pathname]).toEqual(['DELETE', '/v2/accounts/privileges/p-1']);
  });

  it('manages plans, and archives', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.plans.create({ key: 'pro', name: 'Pro', prices: [{ currency: 'usd', interval: 'month', amount: 1900 }] });
    expect([last(seen).method, last(seen).url.pathname]).toEqual(['POST', '/v2/billing/plans']);
    await mgmt.plans.update('pro', { name: 'Pro+' });
    expect(last(seen).method).toBe('PATCH');
    await mgmt.plans.archive('pro');
    expect([last(seen).url.pathname, last(seen).body]).toEqual(['/v2/billing/plans/pro/archive', { archived: true }]);
    await mgmt.plans.delete('pro');
  });

  it('reads events as 0.8 did, with `since` as a time or a duration', async () => {
    const { mgmt, seen } = setUp(() =>
      Response.json({ events: [{ id: 'e1', type: 'accounts.member_added', time: '2026-11-01T10:00:00Z', workspaceId: 'ws-1', userId: 'u1', data: { role: 'USER' } }], next: 'c2' }),
    );
    const before = Date.now();
    const result = await mgmt.events.query({ type: 'accounts.member_added', tenantId: 'ws-1', since: '24h', limit: 10 });
    expect(result).toEqual([{ id: 'e1', type: 'accounts.member_added', tenantId: 'ws-1', userId: 'u1', data: { role: 'USER' }, createdAt: '2026-11-01T10:00:00Z' }]);
    const query = last(seen).url.searchParams;
    expect([last(seen).url.pathname, query.get('type'), query.get('workspaceId'), query.get('limit')]).toEqual(['/v2/events-and-logs/audit', 'accounts.member_added', 'ws-1', '10']);
    expect(Date.parse(query.get('from') as string)).toBeGreaterThan(before - 24 * 3_600_000 - 5_000);
    const page = await mgmt.events.list({ since: '2026-11-01T00:00:00Z', cursor: 'c1' });
    expect(page.next).toBe('c2');
    expect(last(seen).url.searchParams.get('from')).toBe('2026-11-01T00:00:00Z');
  });

  it('finds Events and Logs beside Accounts when the issuer lists no address for it', async () => {
    const { mgmt, seen } = setUp(() => Response.json({ events: [] }), {}, { sign_in: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`, token: `${ORIGIN}/v2/identity-access/apps/app-1/token`, accounts: `${ORIGIN}/v2/accounts` });
    await mgmt.events.query();
    expect(last(seen).url.pathname).toBe('/v2/events-and-logs/audit');
  });
});

describe('management client: flags and segments', () => {
  const flag = (extra: Record<string, unknown> = {}) => ({ key: 'reports', state: 'off', revision: 7, rule: null, ...extra });

  it('changes a flag on the revision it read, or on the one you name', async () => {
    const { mgmt, seen } = setUp((entry) => (entry.method === 'GET' ? Response.json(flag(), { headers: { etag: '"7"' } }) : Response.json(flag({ state: 'on', revision: 8 }))));
    await mgmt.flags.update('reports', { description: 'Reports' });
    expect(seen.map((entry) => entry.method)).toEqual(['GET', 'PATCH']);
    expect(last(seen).headers.get('if-match')).toBe('"7"');
    await mgmt.flags.update('reports', { description: 'again' }, { ifMatch: 3 });
    expect(last(seen).headers.get('if-match')).toBe('"3"');
    expect(seen.filter((entry) => entry.method === 'GET')).toHaveLength(1);
  });

  it('toggles on without widening the audience: a rule is kept', async () => {
    let current = flag();
    const { mgmt, seen } = setUp((entry) => (entry.method === 'GET' ? Response.json(current) : Response.json(current)));
    await mgmt.flags.toggle('reports', true);
    expect(last(seen).body).toEqual({ state: 'on' });
    current = flag({ rule: { branches: [] } });
    await mgmt.flags.toggle('reports', true);
    expect(last(seen).body).toEqual({ state: 'on-with-rule' });
    await mgmt.flags.toggle('reports', false);
    expect(last(seen).body).toEqual({ state: 'off' });
  });

  it('lists, makes, kills, restores and deletes flags, and moves them as a bundle', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.flags.list();
    await mgmt.flags.create({ key: 'beta', state: 'off', valueType: 'boolean' });
    expect([last(seen).method, last(seen).url.pathname]).toEqual(['POST', '/v2/flags/flags']);
    await mgmt.flags.kill('beta');
    expect(last(seen).url.pathname).toBe('/v2/flags/flags/beta/kill');
    await mgmt.flags.restore('beta');
    await mgmt.flags.delete('beta');
    expect(last(seen).headers.get('if-match')).toBeNull();
    await mgmt.flags.export();
    await mgmt.flags.import({ version: 1, flags: [] }, { dryRun: true });
    expect([last(seen).url.pathname, last(seen).body]).toEqual(['/v2/flags/import', { version: 1, flags: [], dryRun: true }]);
  });

  it('updates a segment on the revision the list gave', async () => {
    const { mgmt, seen } = setUp((entry) => (entry.method === 'GET' ? Response.json([{ key: 'beta-users', revision: 4 }]) : undefined));
    await mgmt.flags.updateSegment('beta-users', { description: 'x' });
    expect(last(seen).headers.get('if-match')).toBe('"4"');
    await expect(mgmt.flags.updateSegment('nobody', {})).rejects.toMatchObject({ kind: 'not-found' });
    await mgmt.flags.createSegment({ key: 's', conditions: [] });
    await mgmt.flags.deleteSegment('s');
    expect([last(seen).method, last(seen).url.pathname]).toEqual(['DELETE', '/v2/flags/segments/s']);
  });
});

describe('management client: setup workflows', () => {
  it('connects payments, then makes plans with prices in minor units', async () => {
    const { mgmt, seen } = setUp();
    const result = await mgmt.workflows.setupPayments({
      stripeSecretKey: 'sk_test_x',
      stripePublicKey: 'pk_test_x',
      plans: [
        { key: 'pro', name: 'Pro', price: 19.99, currency: 'EUR', interval: 'year' },
        { key: 'jp', name: 'JP', price: 1500, currency: 'jpy' },
      ],
    });
    expect(result.stripeConnected).toBe(true);
    expect(seen[0]).toMatchObject({ method: 'POST', body: { connector: 'stripe', secretKey: 'sk_test_x', publishableKey: 'pk_test_x' } });
    expect(seen[0]?.url.pathname).toBe('/v2/billing/connection');
    expect(seen[1]?.body).toEqual({ key: 'pro', name: 'Pro', prices: [{ currency: 'eur', interval: 'year', amount: 1999 }] });
    expect(seen[2]?.body).toEqual({ key: 'jp', name: 'JP', prices: [{ currency: 'jpy', interval: 'month', amount: 1500 }] });
  });

  it('saves nothing when a plan is wrong', async () => {
    const { mgmt, seen } = setUp();
    await expect(mgmt.workflows.setupPayments({ stripeSecretKey: 'sk', plans: [{ key: 'x', name: 'X', price: -1 }] })).rejects.toMatchObject({ kind: 'invalid' });
    expect(seen).toHaveLength(0);
  });

  it('sets the sender; one of name and address keeps the other as it is', async () => {
    const { mgmt, seen } = setUp((entry) => (entry.method === 'GET' ? Response.json({ address: 'old@acme.test', name: 'Old' }) : Response.json({ address: 'new@acme.test', name: 'Old' })));
    const result = await mgmt.workflows.setupCommunication({ config: { fromAddress: 'new@acme.test' } });
    expect(seen.map((entry) => `${entry.method} ${entry.url.pathname}`)).toEqual(['GET /v2/communication/sender', 'PUT /v2/communication/sender']);
    expect(last(seen).body).toEqual({ address: 'new@acme.test', name: 'Old' });
    expect(result).toMatchObject({ configured: true, emailSenderEmail: 'new@acme.test', emailSenderName: 'Old' });
    await expect(mgmt.workflows.setupCommunication({ config: {} })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(mgmt.workflows.setupCommunication({ config: { fromAddress: 'nope' } })).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('management client: a route it has no method for', () => {
  it('request() calls any part of the API with the key, and the workspace', async () => {
    const { mgmt, seen } = setUp();
    await mgmt.request('GET', 'billing', '/metrics', { workspace: 'ws-1', query: { x: 1, y: undefined } });
    expect([last(seen).url.href, last(seen).headers.get('bridge-workspace')]).toEqual([`${ORIGIN}/v2/billing/metrics?x=1`, 'ws-1']);
  });
});

describe('management client: every route it calls is one Bridge promises to the app\'s key', () => {
  const contract = JSON.parse(readFileSync(new URL('../../../contract/public-api.v2.json', import.meta.url), 'utf8')) as { endpoints: { method: string; path: string; callers: string[]; fields: string[] }[] };

  it('finds each call in the contract, with the app key among its callers, and sends only fields it accepts', () => {
    expect(everything.length).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const call of everything) {
      const found = contract.endpoints.find((endpoint) => endpoint.method === call.method && new RegExp(`^${endpoint.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(call.url.pathname));
      if (found === undefined || !found.callers.includes('app_key')) {
        missing.push(`${call.method} ${call.url.pathname}`);
        continue;
      }
      const body = call.body;
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && found.fields.length > 0) {
        for (const field of Object.keys(body)) if (!found.fields.includes(field)) missing.push(`${call.method} ${call.url.pathname} field ${field}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
