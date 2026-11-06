import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATHS, LANE_CONTRACT_PATHS, REVOCATION_LANES, ROUTES } from '../../core/routes.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/**
 * The contract test: every route the SDK calls is one Bridge's public API
 * promises at version 2, with the same method. The pinned copy of the
 * contract (contract/public-api.v2.json) names the commit it came from.
 * When Bridge adds a route the SDK waits for, the "pending" check fails:
 * unmark the route and check its shape.
 */

interface ContractEndpoint {
  readonly method: string;
  readonly path: string;
  readonly public: boolean;
  readonly callers: readonly string[];
  /** The body fields the endpoint accepts. Any other field is refused. */
  readonly fields: readonly string[];
}

const contract = JSON.parse(readFileSync(new URL('../../../contract/public-api.v2.json', import.meta.url), 'utf8')) as {
  source: { file: string; commit: string };
  endpoints: ContractEndpoint[];
};
const promised = new Map(contract.endpoints.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint]));
const routes = Object.entries(ROUTES).map(([name, route]) => ({ name, route, key: `${route.method} ${CONTRACT_PATHS[route.at]}${route.path}` }));

describe('contract: the SDK calls only what Bridge promises at version 2', () => {
  it('names the commit the pinned contract came from', () => {
    expect(contract.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(contract.endpoints.length).toBeGreaterThan(100);
  });

  it.each(routes.filter((each) => !('pending' in each.route)).map((each) => [each.name, each.key]))('%s (%s) is in the contract', (_, key) => {
    expect(promised.has(key)).toBe(true);
  });

  it.each(routes.filter((each) => 'pending' in each.route).map((each) => [each.name, each.key]))('%s (%s) is still pending: not in the contract yet', (_, key) => {
    expect(promised.has(key)).toBe(false);
  });

  it('every route is at version 2', () => {
    for (const { key } of routes) expect(key.split(' ')[1]?.startsWith('/v2/')).toBe(true);
  });

  it.each(REVOCATION_LANES.map((lane) => [lane, LANE_CONTRACT_PATHS[lane]]))('the %s lane of the revocation list is public', (_, path) => {
    expect(promised.get(`GET ${path}`)?.public).toBe(true);
  });

  it('discovery has its version 2 twin in the contract', () => {
    expect(promised.get('GET /v2/identity-access/apps/{appId}/.well-known/openid-configuration')?.public).toBe(true);
  });

  it('every route before sign-in is public, and every signed-in route takes a person', () => {
    const beforeSignIn = ['signIn', 'token', 'revoke', 'introspect', 'jwks', 'signInOptions', 'signUp', 'signUpVerify', 'passwordForgot', 'passwordSet', 'flagsVisitorEvaluate', 'liveVisitorChannels', 'liveVisitorHistory', 'liveConnection'];
    for (const { name, key } of routes) {
      const endpoint = promised.get(key);
      if (endpoint === undefined) continue;
      if (beforeSignIn.includes(name)) expect(endpoint.public, name).toBe(true);
      else if (name === 'usageReport') expect(endpoint.callers).toContain('app_key');
      else expect(endpoint.callers, name).toContain('person');
    }
  });
});

describe('contract: every field the SDK sends is one Bridge accepts', () => {
  /** The contract endpoint a recorded request went to. */
  function endpointOf(method: string, path: string, appId: string): ContractEndpoint | undefined {
    const bare = path.split('?')[0] ?? '';
    return contract.endpoints.find((endpoint) => {
      if (endpoint.method !== method) return false;
      const pattern = new RegExp(`^${endpoint.path.replace('{appId}', appId).replace(/\{[a-zA-Z]+\}/g, '[^/]+')}$`);
      return pattern.test(bare);
    });
  }

  it('across sign-in, sign-up, recovery, the team, billing, flags and sign-out', async () => {
    const { fake } = issuerWithPeople();
    fake.setPlans([{ key: 'pro', name: 'Pro', free: false, prices: [{ currency: 'eur', interval: 'month', amount: 2000 }], features: [], limits: {}, archived: false, description: null, trial: null }]);
    const client = clientOn(fake);
    const step = await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD });
    if (!step.done) await step.choose('ws-acme');
    await client.workspaces.switch('ws-globex');
    await client.me.update({ firstName: 'Bob', lastName: 'B' });
    await client.workspaces.create({ name: 'New' });
    await client.team.members.list({ limit: 10 });
    const invite = await client.team.invites.create({ email: 'new@acme.test', role: 'MEMBER' });
    await client.team.invites.revoke(invite.id);
    await client.team.roles.list({ assignable: true });
    const change = await client.billing.choosePlan({ plan: 'pro', currency: 'eur', interval: 'month' });
    if (change.status === 'payment_required') await client.billing.confirmCheckout(change.checkout.session);
    await client.billing.portal();
    await client.flags.setHints({ page: 'pricing' });
    await client.signOut();
    await client.signUp.start({ email: 'carol@acme.test', password: PASSWORD, firstName: 'C', lastName: 'D', workspace: 'Carol Co' });
    await client.signUp.finish(fake.lastLink('carol@acme.test', 'verify-sign-up')!);
    await client.password.forgot('carol@acme.test');
    await client.password.set(fake.lastLink('carol@acme.test', 'reset-password')!, 'another long password');

    const checked = new Set<string>();
    for (const request of fake.requests) {
      if (request.path.includes('/.well-known/')) continue;
      const endpoint = endpointOf(request.method, request.path, fake.appId);
      expect(endpoint, `${request.method} ${request.path}`).toBeDefined();
      const sent = request.body === undefined ? [] : Object.keys(request.body as object);
      for (const field of sent) expect([`${request.method} ${endpoint!.path}`, field, endpoint!.fields.includes(field)]).toEqual([`${request.method} ${endpoint!.path}`, field, true]);
      checked.add(`${request.method} ${endpoint!.path}`);
    }
    // The flows above reach the endpoints that take a body.
    for (const key of ['POST /v2/identity-access/apps/{appId}/sign-in', 'POST /v2/identity-access/apps/{appId}/token', 'POST /v2/identity-access/apps/{appId}/sign-up', 'POST /v2/identity-access/apps/{appId}/sign-up/verify', 'POST /v2/identity-access/apps/{appId}/password', 'PATCH /v2/accounts/me', 'POST /v2/accounts/invites', 'POST /v2/billing/payer/plan', 'POST /v2/flags/ofrep/v1/evaluate/flags']) {
      expect(checked).toContain(key);
    }
  });

  it("usage reports go in the one field Bridge's usage endpoint takes", () => {
    expect(promised.get('POST /v2/billing/usage')?.fields).toEqual(['reports']);
  });
});
