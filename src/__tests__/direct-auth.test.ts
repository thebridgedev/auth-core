import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      expect(url).toBe('https://api.example.com/auth/auth/credentialsConfig');
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
      expect(url).toBe('https://api.example.com/auth/auth/authenticate');
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
      expect(url).toBe('https://api.example.com/auth/auth/commitMfaCode');
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
      expect(url).toBe('https://api.example.com/auth/auth/startMfaUserSetup');
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
      expect(url).toBe('https://api.example.com/auth/auth/finishMfaUserSetup');
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
      expect(url).toBe('https://api.example.com/auth/auth/resetUserMfaSetup');
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
});
