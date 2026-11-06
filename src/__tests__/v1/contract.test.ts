import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PATHS, LANE_CONTRACT_PATHS, REVOCATION_LANES, ROUTES } from '../../core/routes.js';

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
    const beforeSignIn = ['signIn', 'token', 'revoke', 'introspect', 'jwks', 'signUp', 'signUpVerify', 'passwordForgot', 'passwordSet', 'flagsVisitorEvaluate', 'liveVisitorChannels', 'liveVisitorHistory'];
    for (const { name, key } of routes) {
      const endpoint = promised.get(key);
      if (endpoint === undefined) continue;
      if (beforeSignIn.includes(name)) expect(endpoint.public, name).toBe(true);
      else if (name === 'usageReport') expect(endpoint.callers).toContain('app_key');
      else expect(endpoint.callers, name).toContain('person');
    }
  });
});
