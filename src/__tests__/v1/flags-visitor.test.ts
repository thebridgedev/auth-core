import { describe, expect, it } from 'vitest';
import { createBridgeServer, type BridgeServerOptions } from '../../server/index.js';

/**
 * Flag results for a caller who is not signed in: what Bridge shows a visitor (public flags only), asked with no
 * credential at all, and kept briefly so a busy public route does not ask each time.
 */

const ORIGIN = 'https://bridge.test';
const ISSUER = `${ORIGIN}/identity-access/apps/app-1`;
const VISITOR = `${ORIGIN}/v2/flags/apps/app-1/ofrep/v1/evaluate/flags`;

function setUp(options: Partial<BridgeServerOptions> & { listed?: boolean; answer?: () => Response } = {}) {
  const asked: { headers: Headers; body: unknown }[] = [];
  const { listed = true, answer, ...serverOptions } = options;
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
          '2': {
            sign_in: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`,
            token: `${ORIGIN}/v2/identity-access/apps/app-1/token`,
            accounts: `${ORIGIN}/v2/accounts`,
            flags: `${ORIGIN}/v2/flags`,
            ...(listed ? { flags_visitor: `${ORIGIN}/v2/flags/apps/app-1` } : {}),
          },
        },
      });
    }
    if (request.url === VISITOR) {
      asked.push({ headers: request.headers, body: await request.json() });
      return answer?.() ?? Response.json({ flags: [{ key: 'beta-banner', value: true, reason: 'STATIC' }] });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const logs: string[] = [];
  const server = createBridgeServer({ issuer: ISSUER, fetch: fetchFn, appKey: 'app-key-secret', log: (message) => logs.push(message), ...serverOptions });
  return { server, asked, logs };
}

describe('server: flags for a visitor', () => {
  it('asks Bridge as a visitor, with no credential, and never sends the app key', async () => {
    const { server, asked } = setUp();
    const flags = await server.flags.forVisitor();
    expect(flags.enabled('beta-banner')).toBe(true);
    // Not on the answer: a flag that is not public is not in it at all.
    expect(flags.enabled('internal-tools')).toBe(false);
    expect(flags.get('page-size', 20)).toBe(20);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.headers.get('x-api-key')).toBeNull();
    expect(asked[0]?.headers.get('authorization')).toBeNull();
    expect(asked[0]?.body).toEqual({ context: {} });
    await server.close();
  });

  it('passes on the hints the server gives, and keeps an answer per hints for a short while', async () => {
    const { server, asked } = setUp();
    await server.flags.forVisitor({ country: 'SE' });
    await server.flags.forVisitor({ country: 'SE' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual({ context: { country: 'SE' } });
    await server.flags.forVisitor({ country: 'DE' });
    await server.flags.forVisitor({});
    expect(asked).toHaveLength(3);
    // Hints in another order are the same hints.
    await server.flags.forVisitor({ a: '1', b: '2' });
    await server.flags.forVisitor({ b: '2', a: '1' });
    expect(asked).toHaveLength(4);
    await server.close();
  });

  it('asks every time when told to keep nothing', async () => {
    const { server, asked } = setUp({ visitorFlagsTtlMs: 0 });
    await server.flags.forVisitor();
    await server.flags.forVisitor();
    expect(asked).toHaveLength(2);
    await server.close();
  });

  it('gives every flag its fallback, and says so, when Bridge refuses or cannot be reached, and asks again next time', async () => {
    let fail = true;
    const { server, asked, logs } = setUp({ answer: () => (fail ? new Response(null, { status: 503 }) : Response.json({ flags: [{ key: 'beta-banner', value: true, reason: 'STATIC' }] })) });
    const down = await server.flags.forVisitor();
    expect(down.enabled('beta-banner')).toBe(false);
    expect(logs.some((line) => line.includes('Visitor flag results could not be read'))).toBe(true);
    fail = false;
    expect((await server.flags.forVisitor()).enabled('beta-banner')).toBe(true);
    expect(asked).toHaveLength(2);
    await server.close();
  });

  it('gives fallbacks when the issuer lists no visitor endpoint', async () => {
    const { server, asked } = setUp({ listed: false });
    expect((await server.flags.forVisitor()).enabled('beta-banner')).toBe(false);
    expect(asked).toHaveLength(0);
    await server.close();
  });
});
