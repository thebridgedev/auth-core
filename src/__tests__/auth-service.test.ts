import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../auth-service.js';
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

const BASE_CONFIG: ResolvedConfig = {
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

function makeService(config: Partial<ResolvedConfig> = {}): AuthService {
  return new AuthService({ ...BASE_CONFIG, ...config }, logger);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // createLoginUrl
  // -------------------------------------------------------------------------

  describe('createLoginUrl', () => {
    it('uses the config callbackUrl as redirectUri when no option is passed', () => {
      const service = makeService();
      const url = service.createLoginUrl();
      expect(url).toBe(
        `https://hosted.example.com/auth/login/app1?redirectUri=${encodeURIComponent('https://myapp.com/callback')}`,
      );
    });

    it('uses the provided redirectUri option instead of the config callbackUrl', () => {
      const service = makeService();
      const url = service.createLoginUrl({ redirectUri: 'https://myapp.com/custom' });
      expect(url).toBe(
        `https://hosted.example.com/auth/login/app1?redirectUri=${encodeURIComponent('https://myapp.com/custom')}`,
      );
    });

    it('returns bare base URL when callbackUrl is empty and no option given', () => {
      const service = makeService({ callbackUrl: '' });
      const url = service.createLoginUrl();
      expect(url).toBe('https://hosted.example.com/auth/login/app1');
    });

    it('returns bare base URL when redirectUri option is empty string', () => {
      const service = makeService({ callbackUrl: '' });
      const url = service.createLoginUrl({ redirectUri: '' });
      expect(url).toBe('https://hosted.example.com/auth/login/app1');
    });

    it('uses the config callbackUrl when redirectUri option is undefined', () => {
      const service = makeService();
      const url = service.createLoginUrl({ redirectUri: undefined });
      expect(url).toContain(encodeURIComponent('https://myapp.com/callback'));
    });

    it('URL-encodes special characters in the redirect URI', () => {
      const service = makeService({ callbackUrl: 'https://myapp.com/path?foo=bar&baz=qux' });
      const url = service.createLoginUrl();
      expect(url).toContain(encodeURIComponent('https://myapp.com/path?foo=bar&baz=qux'));
    });
  });

  // -------------------------------------------------------------------------
  // createLogoutUrl
  // -------------------------------------------------------------------------

  describe('createLogoutUrl', () => {
    it('returns the correct logout URL', () => {
      const service = makeService();
      expect(service.createLogoutUrl()).toBe('https://api.example.com/auth/url/logout/app1');
    });

    it('uses the appId from config', () => {
      const service = makeService({ appId: 'other-app' });
      expect(service.createLogoutUrl()).toBe('https://api.example.com/auth/url/logout/other-app');
    });
  });

  // -------------------------------------------------------------------------
  // exchangeCode
  // -------------------------------------------------------------------------

  describe('exchangeCode', () => {
    it('POSTs to the correct endpoint', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'acc',
        refresh_token: 'ref',
        id_token: 'id',
      });

      const service = makeService();
      await service.exchangeCode('CODE123');

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/token/code/app1');
    });

    it('sends code in the request body', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'acc',
        refresh_token: 'ref',
        id_token: 'id',
      });

      const service = makeService();
      await service.exchangeCode('MYCODE');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toMatchObject({ code: 'MYCODE' });
    });

    it('includes callbackUrl as redirect_uri and redirectUri in body when present', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'acc',
        refresh_token: 'ref',
        id_token: 'id',
      });

      const service = makeService();
      await service.exchangeCode('CODE');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toMatchObject({
        redirect_uri: 'https://myapp.com/callback',
        redirectUri: 'https://myapp.com/callback',
      });
    });

    it('does not include redirect_uri in body when callbackUrl is empty', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'acc',
        refresh_token: 'ref',
        id_token: 'id',
      });

      const service = makeService({ callbackUrl: '' });
      await service.exchangeCode('CODE');

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).not.toHaveProperty('redirect_uri');
      expect(opts.body).not.toHaveProperty('redirectUri');
    });

    it('maps snake_case response fields to camelCase TokenSet', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'ACCESS',
        refresh_token: 'REFRESH',
        id_token: 'ID',
      });

      const service = makeService();
      const tokens = await service.exchangeCode('CODE');

      expect(tokens).toEqual({
        accessToken: 'ACCESS',
        refreshToken: 'REFRESH',
        idToken: 'ID',
      });
    });
  });

  // -------------------------------------------------------------------------
  // refreshToken
  // -------------------------------------------------------------------------

  describe('refreshToken', () => {
    it('POSTs to /token with correct body', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'acc2',
        refresh_token: 'ref2',
        id_token: 'id2',
      });

      const service = makeService();
      await service.refreshToken('OLD_REFRESH');

      const [url, opts] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/token');
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({
        client_id: 'app1',
        grant_type: 'refresh_token',
        refresh_token: 'OLD_REFRESH',
      });
    });

    it('maps response fields to camelCase TokenSet', async () => {
      mockHttpFetch.mockResolvedValue({
        access_token: 'A',
        refresh_token: 'R',
        id_token: 'I',
      });

      const service = makeService();
      const tokens = await service.refreshToken('rt');
      expect(tokens).toEqual({ accessToken: 'A', refreshToken: 'R', idToken: 'I' });
    });

    it('returns null when the request fails', async () => {
      mockHttpFetch.mockRejectedValue(new Error('Network error'));

      const service = makeService();
      const result = await service.refreshToken('bad-token');

      expect(result).toBeNull();
    });

    it('logs an error when the request fails', async () => {
      const err = new Error('500');
      mockHttpFetch.mockRejectedValue(err);

      const service = makeService();
      await service.refreshToken('rt');

      expect((logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        'Failed to refresh token',
        err,
      );
    });
  });
});
