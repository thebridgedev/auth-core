import { describe, expect, it } from 'vitest';
import { discover, endpointsFrom, metadataUrl, readMetadata } from '../../core/discovery.js';
import { ROUTES } from '../../core/routes.js';
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
    expect(() => endpoints.url(ROUTES.signInOptions)).toThrow(/does not offer public sign-in options yet/);
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
