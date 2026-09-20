import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectAuthService } from '../direct-auth.js';
import type { Logger } from '../logger.js';
import type { ResolvedConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Mock httpFetch
// ---------------------------------------------------------------------------

vi.mock('../http.js', () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from '../http.js';

const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: ResolvedConfig = {
  appId: 'app1',
  apiBaseUrl: 'https://api.example.com',
  hostedUrl: 'https://hosted.example.com',
  authBaseUrl: 'https://api.example.com/auth',
  callbackUrl: 'https://myapp.com/callback',
  defaultRedirectRoute: '/',
  loginRoute: '/login',
  teamManagementUrl: 'https://team.example.com',
  storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  debug: false,
};

const logger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const AUTH_RESULT = {
  session: 'sess-abc',
  expires: 9999999999,
  mfaState: 'COMPLETED',
  tenantUsers: [],
};

const MFA_RESULT = {
  session: 'sess-mfa',
  expires: 9999999999,
  mfaState: 'COMPLETED',
};

const DIRECT_TOKEN_RESPONSE = {
  access_token: 'ACCESS',
  refresh_token: 'REFRESH',
  id_token: 'ID',
  token_type: 'Bearer',
  expires_in: 3600,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DirectAuthService', () => {
  let service: DirectAuthService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new DirectAuthService(CONFIG, logger);
  });

  // -------------------------------------------------------------------------
  // getCredentialsConfig
  // -------------------------------------------------------------------------

  describe('getCredentialsConfig', () => {
    it('POSTs to the correct URL', async () => {
      mockHttpFetch.mockResolvedValue({ hasPassword: true, hasPasskeys: false, federationConnections: [] });

      await service.getCredentialsConfig('user@example.com');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/credentialsConfig');
    });

    it('sends the correct body with mode: "sdk"', async () => {
      mockHttpFetch.mockResolvedValue({ hasPassword: true, hasPasskeys: false, federationConnections: [] });

      await service.getCredentialsConfig('user@example.com');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({
        username: 'user@example.com',
        mode: 'sdk',
        appId: 'app1',
      });
    });

    it('returns the response from the endpoint', async () => {
      const response = { hasPassword: true, hasPasskeys: true, federationConnections: [{ id: 'c1', type: 'GOOGLE', name: 'Google' }] };
      mockHttpFetch.mockResolvedValue(response);

      const result = await service.getCredentialsConfig('user@example.com');
      expect(result).toEqual(response);
    });
  });

  // -------------------------------------------------------------------------
  // authenticate
  // -------------------------------------------------------------------------

  describe('authenticate', () => {
    it('POSTs to the authenticate endpoint', async () => {
      mockHttpFetch.mockResolvedValue(AUTH_RESULT);

      await service.authenticate('user@example.com', 'password123');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/authenticate');
    });

    it('sends the correct body including mode: "sdk"', async () => {
      mockHttpFetch.mockResolvedValue(AUTH_RESULT);

      await service.authenticate('user@example.com', 'p@ssw0rd');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({
        username: 'user@example.com',
        password: 'p@ssw0rd',
        mode: 'sdk',
        appId: 'app1',
      });
    });

    it('returns the AuthResult from the endpoint', async () => {
      mockHttpFetch.mockResolvedValue(AUTH_RESULT);

      const result = await service.authenticate('user@example.com', 'pw');
      expect(result).toEqual(AUTH_RESULT);
    });
  });

  // -------------------------------------------------------------------------
  // commitMfaCode
  // -------------------------------------------------------------------------

  describe('commitMfaCode', () => {
    it('POSTs to the commitMfaCode endpoint', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.commitMfaCode('123456', 'my-session');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/commitMfaCode');
    });

    it('sends the session in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.commitMfaCode('123456', 'SESSION_TOKEN');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ session: 'SESSION_TOKEN' });
    });

    it('sends mfaCode and mode in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.commitMfaCode('654321', 'session');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ mfaCode: '654321', mode: 'sdk', appId: 'app1' });
    });
  });

  // -------------------------------------------------------------------------
  // startMfaUserSetup
  // -------------------------------------------------------------------------

  describe('startMfaUserSetup', () => {
    it('POSTs to the startMfaUserSetup endpoint', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.startMfaUserSetup('+1234567890', 'session');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/startMfaUserSetup');
    });

    it('sends the session in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.startMfaUserSetup('+1234567890', 'sess-tok');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ session: 'sess-tok' });
    });

    it('sends phoneNumber in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.startMfaUserSetup('+44123456789', 'sess');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ phoneNumber: '+44123456789', mode: 'sdk', appId: 'app1' });
    });
  });

  // -------------------------------------------------------------------------
  // finishMfaUserSetup
  // -------------------------------------------------------------------------

  describe('finishMfaUserSetup', () => {
    it('POSTs to the finishMfaUserSetup endpoint', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.finishMfaUserSetup('112233', 'session');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/finishMfaUserSetup');
    });

    it('sends the session in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.finishMfaUserSetup('112233', 'my-sess');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ session: 'my-sess' });
    });

    it('sends mfaCode in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.finishMfaUserSetup('445566', 'sess');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ mfaCode: '445566', mode: 'sdk', appId: 'app1' });
    });
  });

  // -------------------------------------------------------------------------
  // resetUserMfaSetup
  // -------------------------------------------------------------------------

  describe('resetUserMfaSetup', () => {
    it('POSTs to the resetUserMfaSetup endpoint', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.resetUserMfaSetup('BACKUP-CODE', 'session');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/resetUserMfaSetup');
    });

    it('sends the session in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.resetUserMfaSetup('BACKUP', 'session-id');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ session: 'session-id' });
    });

    it('sends backupCode in the body', async () => {
      mockHttpFetch.mockResolvedValue(MFA_RESULT);

      await service.resetUserMfaSetup('MY-BACKUP', 'sess');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({ backupCode: 'MY-BACKUP', mode: 'sdk', appId: 'app1' });
    });
  });

  // -------------------------------------------------------------------------
  // selectTenant
  // -------------------------------------------------------------------------

  describe('selectTenant', () => {
    it('POSTs to /token/direct', async () => {
      mockHttpFetch.mockResolvedValue(DIRECT_TOKEN_RESPONSE);

      await service.selectTenant('sess-abc', 'tenant-user-1');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/token/direct');
    });

    it('sends the correct body with session, tenantUserId, appId, scope, and mode', async () => {
      mockHttpFetch.mockResolvedValue(DIRECT_TOKEN_RESPONSE);

      await service.selectTenant('sess-xyz', 'tu-42');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({
        session: 'sess-xyz',
        tenantUserId: 'tu-42',
        appId: 'app1',
        scope: 'openid profile email onboarding tenant',
        mode: 'sdk',
      });
    });

    it('maps the snake_case response to a camelCase TokenSet', async () => {
      mockHttpFetch.mockResolvedValue(DIRECT_TOKEN_RESPONSE);

      const tokens = await service.selectTenant('sess', 'tid');

      expect(tokens).toEqual({
        accessToken: 'ACCESS',
        refreshToken: 'REFRESH',
        idToken: 'ID',
      });
    });
  });

  // -------------------------------------------------------------------------
  // sendMagicLink
  //
  // Regression: the POST carried no `successUrl`, so the emailed link pointed
  // at Bridge's hosted magic-link route — a route an SDK app does not serve,
  // which made every emailed link 404. The link has to come back to the page
  // that redeems it, because that is where the login component reads
  // `bridge_magic_link_token` on mount. It now defaults to the current page
  // with the query string and fragment stripped (a stale `?redirect=`/`#hash`
  // carried into the email would survive the round trip), and is omitted
  // entirely outside a browser so Bridge keeps its hosted fallback.
  // (TBP-682, 2026-09-20)
  // -------------------------------------------------------------------------

  describe('sendMagicLink', () => {
    const MAGIC_LINK_RESULT = { success: true };

    // `location` is a global: stub it per-case and hand it back afterwards so
    // no sibling test inherits a browser that this block invented.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubBrowserLocation(origin: string, pathname: string, search = '', hash = '') {
      vi.stubGlobal('location', {
        origin,
        pathname,
        search,
        hash,
        href: `${origin}${pathname}${search}${hash}`,
      });
    }

    function magicLinkCall(): [string, { method: string; body: Record<string, unknown> }] {
      return mockHttpFetch.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
    }

    it('POSTs to the magic-link endpoint', async () => {
      stubBrowserLocation('https://app.example.com', '/login');
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      await service.sendMagicLink('user@example.com');

      const [url] = magicLinkCall();
      expect(url).toBe('https://api.example.com/auth/magic-link');
    });

    it('defaults successUrl to the current page with no query string and no fragment', async () => {
      stubBrowserLocation(
        'https://app.example.com',
        '/login',
        '?redirect=%2Fdashboard&utm_source=email',
        '#top',
      );
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      await service.sendMagicLink('user@example.com');

      const [, opts] = magicLinkCall();
      expect(opts.body.successUrl).toBe('https://app.example.com/login');
      expect(String(opts.body.successUrl)).not.toMatch(/[?#]/);
    });

    it('keeps username, mode and appId unchanged alongside the defaulted successUrl', async () => {
      stubBrowserLocation('https://app.example.com', '/login');
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      await service.sendMagicLink('user@example.com');

      const [, opts] = magicLinkCall();
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({
        username: 'user@example.com',
        mode: 'sdk',
        appId: 'app1',
        successUrl: 'https://app.example.com/login',
      });
    });

    it('posts an explicit successUrl exactly as given', async () => {
      stubBrowserLocation('https://app.example.com', '/login', '?redirect=%2Fdashboard');
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      await service.sendMagicLink('user@example.com', {
        successUrl: 'https://app.example.com/auth/finish?flow=magic#done',
      });

      const [, opts] = magicLinkCall();
      // Verbatim: an explicit value is not re-derived, stripped or normalized.
      expect(opts.body).toEqual({
        username: 'user@example.com',
        mode: 'sdk',
        appId: 'app1',
        successUrl: 'https://app.example.com/auth/finish?flow=magic#done',
      });
    });

    it('omits successUrl entirely when there is no location (non-browser)', async () => {
      vi.stubGlobal('location', undefined);
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      await service.sendMagicLink('user@example.com');

      const [, opts] = magicLinkCall();
      // The key must be ABSENT, not present-and-undefined: a serialized
      // `"successUrl": null` would defeat the server-side hosted fallback.
      expect(Object.keys(opts.body)).not.toContain('successUrl');
      expect('successUrl' in opts.body).toBe(false);
      expect(opts.body).toEqual({
        username: 'user@example.com',
        mode: 'sdk',
        appId: 'app1',
      });
    });

    it('still sends an explicit successUrl outside a browser', async () => {
      vi.stubGlobal('location', undefined);
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      await service.sendMagicLink('user@example.com', { successUrl: 'https://app.example.com/login' });

      const [, opts] = magicLinkCall();
      expect(opts.body.successUrl).toBe('https://app.example.com/login');
    });

    it('returns the response from the endpoint', async () => {
      stubBrowserLocation('https://app.example.com', '/login');
      mockHttpFetch.mockResolvedValue(MAGIC_LINK_RESULT);

      const result = await service.sendMagicLink('user@example.com');
      expect(result).toEqual(MAGIC_LINK_RESULT);
    });
  });

  // -------------------------------------------------------------------------
  // requestPasskeySetupLink
  //
  // Regression: this call was missing `mode: 'sdk'` in its POST body, unlike
  // every sibling SDK method. bridge-api's /passkeys/request-setup-link
  // endpoint branches on `body.mode === 'sdk'` — without it, the request
  // always fell through to a cookie-based OAuth-context check that SDK mode
  // can never satisfy, throwing a misleading ClientUnauthenticatedError
  // ("App is unauthenticated...") even with valid credentials. Undetected
  // until now because this method had zero test coverage. (TBP-535, 2026-08-15)
  // -------------------------------------------------------------------------

  describe('requestPasskeySetupLink', () => {
    it('POSTs to the request-setup-link endpoint', async () => {
      mockHttpFetch.mockResolvedValue({ success: true });

      await service.requestPasskeySetupLink('user@example.com');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/passkeys/request-setup-link');
    });

    it('sends the correct body with username, mode: "sdk", and appId', async () => {
      mockHttpFetch.mockResolvedValue({ success: true });

      await service.requestPasskeySetupLink('user@example.com');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({
        username: 'user@example.com',
        mode: 'sdk',
        appId: 'app1',
      });
    });

    it('returns the response from the endpoint', async () => {
      mockHttpFetch.mockResolvedValue({ success: true });

      const result = await service.requestPasskeySetupLink('user@example.com');
      expect(result).toEqual({ success: true });
    });
  });

  // -------------------------------------------------------------------------
  // Passkeys — SDK-mode challenge token relay
  //
  // SDK mode has no cookie to carry the WebAuthn challenge across the two
  // calls (options -> verify), and @simplewebauthn/browser's start*() calls
  // don't forward unrelated fields from the options object they're given —
  // so the client has to capture sdkChallengeToken from the options response
  // and re-attach it on verify itself. This was previously missing entirely,
  // silently breaking every real SDK-mode passkey ceremony.
  // -------------------------------------------------------------------------

  describe('passkeys authentication (sdkChallengeToken relay)', () => {
    it('captures sdkChallengeToken from the options response and re-attaches it on verify', async () => {
      mockHttpFetch.mockResolvedValueOnce({ challenge: 'chal', rp: { id: 'example.com' }, sdkChallengeToken: 'tok-auth-1' });
      mockHttpFetch.mockResolvedValueOnce(AUTH_RESULT);

      await service.passkeysAuthenticationOptions();
      await service.passkeysAuthenticate({ id: 'cred-1', response: {} });

      const [, verifyOpts] = mockHttpFetch.mock.calls[1];
      expect(verifyOpts.body).toEqual({
        id: 'cred-1',
        response: {},
        sdkChallengeToken: 'tok-auth-1',
        mode: 'sdk',
        appId: 'app1',
      });
    });

    it('omits sdkChallengeToken when the options response has none (hosted/cookie mode)', async () => {
      mockHttpFetch.mockResolvedValueOnce({ challenge: 'chal', rp: { id: 'example.com' } });
      mockHttpFetch.mockResolvedValueOnce(AUTH_RESULT);

      await service.passkeysAuthenticationOptions();
      await service.passkeysAuthenticate({ id: 'cred-1' });

      const [, verifyOpts] = mockHttpFetch.mock.calls[1];
      expect(verifyOpts.body).not.toHaveProperty('sdkChallengeToken');
    });

    it('consumes the captured token so a second verify call without a fresh options call sends none', async () => {
      mockHttpFetch.mockResolvedValueOnce({ challenge: 'chal', sdkChallengeToken: 'tok-auth-1' });
      mockHttpFetch.mockResolvedValueOnce(AUTH_RESULT);
      mockHttpFetch.mockResolvedValueOnce(AUTH_RESULT);

      await service.passkeysAuthenticationOptions();
      await service.passkeysAuthenticate({ id: 'cred-1' });
      await service.passkeysAuthenticate({ id: 'cred-1' });

      const [, secondVerifyOpts] = mockHttpFetch.mock.calls[2];
      expect(secondVerifyOpts.body).not.toHaveProperty('sdkChallengeToken');
    });
  });

  describe('passkeys registration (sdkChallengeToken relay)', () => {
    it('captures sdkChallengeToken from the registration options response and re-attaches it on verify', async () => {
      mockHttpFetch.mockResolvedValueOnce({ challenge: 'chal', rp: { id: 'example.com' }, sdkChallengeToken: 'tok-reg-1' });
      mockHttpFetch.mockResolvedValueOnce({ verified: true });

      await service.getPasskeyRegistrationOptions('setup-token');
      await service.verifyPasskeyRegistration({ id: 'cred-1', response: {} }, 'setup-token');

      const [, verifyOpts] = mockHttpFetch.mock.calls[1];
      expect(verifyOpts.body).toEqual({
        id: 'cred-1',
        response: {},
        sdkChallengeToken: 'tok-reg-1',
        appId: 'app1',
      });
    });

    it('keeps the authentication and registration challenge tokens independent', async () => {
      mockHttpFetch.mockResolvedValueOnce({ challenge: 'chal', sdkChallengeToken: 'tok-auth-1' }); // auth options
      mockHttpFetch.mockResolvedValueOnce({ challenge: 'chal', sdkChallengeToken: 'tok-reg-1' }); // registration options
      mockHttpFetch.mockResolvedValueOnce({ verified: true }); // verify-registration
      mockHttpFetch.mockResolvedValueOnce(AUTH_RESULT); // verify-authentication

      await service.passkeysAuthenticationOptions();
      await service.getPasskeyRegistrationOptions('setup-token');
      await service.verifyPasskeyRegistration({ id: 'reg-cred' }, 'setup-token');
      await service.passkeysAuthenticate({ id: 'auth-cred' });

      const [, verifyRegOpts] = mockHttpFetch.mock.calls[2];
      const [, verifyAuthOpts] = mockHttpFetch.mock.calls[3];
      expect(verifyRegOpts.body).toMatchObject({ sdkChallengeToken: 'tok-reg-1' });
      expect(verifyAuthOpts.body).toMatchObject({ sdkChallengeToken: 'tok-auth-1' });
    });
  });
});
