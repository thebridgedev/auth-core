import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all service modules
vi.mock('../http.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
  },
}));

import { BridgeAuth } from '../bridge-auth.js';
import { MemoryAdapter } from '../token-storage.js';
import { httpFetch } from '../http.js';
import { jwtVerify } from 'jose';

const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;
const mockJwtVerify = jwtVerify as ReturnType<typeof vi.fn>;

function makeConfig() {
  return {
    appId: 'test-app',
    apiBaseUrl: 'https://api.test.com',
    hostedUrl: 'https://hosted.test.com',
    callbackUrl: 'https://myapp.com/callback',
    storage: new MemoryAdapter(),
    debug: false,
  };
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe('BridgeAuth', () => {
  let auth: BridgeAuth;

  beforeEach(() => {
    vi.clearAllMocks();
    auth = new BridgeAuth(makeConfig());
  });

  describe('constructor', () => {
    it('starts unauthenticated', () => {
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.getAuthState()).toBe('unauthenticated');
      expect(auth.getTokens()).toBeNull();
    });

    it('restores tokens from storage', () => {
      const storage = new MemoryAdapter();
      storage.set('bridge_tokens', JSON.stringify({
        accessToken: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refreshToken: 'rt',
        idToken: 'idt',
      }));
      const a = new BridgeAuth({ ...makeConfig(), storage });
      expect(a.isAuthenticated()).toBe(true);
      expect(a.getAuthState()).toBe('authenticated');
      a.destroy();
    });
  });

  describe('OAuth flow', () => {
    it('createLoginUrl builds correct URL', () => {
      const url = auth.createLoginUrl();
      expect(url).toContain('https://hosted.test.com/auth/login/test-app');
      expect(url).toContain('redirectUri=');
    });

    it('createLoginUrl with custom redirectUri', () => {
      const url = auth.createLoginUrl({ redirectUri: 'https://other.com/cb' });
      expect(url).toContain(encodeURIComponent('https://other.com/cb'));
    });

    it('handleCallback exchanges code and stores tokens', async () => {
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });

      const tokens = await auth.handleCallback('test-code');
      expect(tokens).toEqual({
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'idt',
      });
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.getAuthState()).toBe('authenticated');
    });

    it('refreshTokens returns null when no tokens', async () => {
      const result = await auth.refreshTokens();
      expect(result).toBeNull();
    });

    it('refreshTokens calls refresh endpoint', async () => {
      // First set tokens
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at1',
        refresh_token: 'rt1',
        id_token: 'idt1',
      });
      await auth.handleCallback('code');

      // Then refresh
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at2',
        refresh_token: 'rt2',
        id_token: 'idt2',
      });
      const newTokens = await auth.refreshTokens();
      expect(newTokens).toEqual({
        accessToken: 'at2',
        refreshToken: 'rt2',
        idToken: 'idt2',
      });
    });
  });

  describe('Direct auth (SDK mode)', () => {
    it('getAuthConfig calls credentialsConfig endpoint', async () => {
      mockHttpFetch.mockResolvedValueOnce({
        hasPassword: true,
        hasPasskeys: false,
        federationConnections: [],
      });

      const result = await auth.getAuthConfig('user@test.com');
      expect(result.hasPassword).toBe(true);
      expect(mockHttpFetch).toHaveBeenCalledWith(
        'https://api.test.com/auth/auth/credentialsConfig',
        expect.objectContaining({
          method: 'POST',
          body: { username: 'user@test.com', mode: 'sdk', appId: 'test-app' },
        }),
        expect.anything(),
      );
    });

    it('authenticate with single tenant auto-completes', async () => {
      // authenticate returns single tenant + COMPLETED
      mockHttpFetch.mockResolvedValueOnce({
        session: 'sess1',
        expires: 3600,
        mfaState: 'COMPLETED',
        tenantUsers: [{ id: 'tu1', username: 'user', fullName: 'User', tenant: { id: 't1', name: 'T', logo: '' } }],
      });

      // selectTenant auto-called
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });

      const result = await auth.authenticate('user@test.com', 'pass');
      expect(result.session).toBe('sess1');
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.getAuthState()).toBe('authenticated');
    });

    it('authenticate with MFA required transitions to mfa-required', async () => {
      mockHttpFetch.mockResolvedValueOnce({
        session: 'sess1',
        expires: 3600,
        mfaState: 'REQUIRED',
        tenantUsers: [{ id: 'tu1', username: 'user', fullName: 'User', tenant: { id: 't1', name: 'T', logo: '' } }],
      });

      await auth.authenticate('user@test.com', 'pass');
      expect(auth.getAuthState()).toBe('mfa-required');
      expect(auth.isAuthenticated()).toBe(false);
    });

    it('authenticate with multiple tenants transitions to tenant-selection', async () => {
      mockHttpFetch.mockResolvedValueOnce({
        session: 'sess1',
        expires: 3600,
        mfaState: 'COMPLETED',
        tenantUsers: [
          { id: 'tu1', username: 'u1', fullName: 'U1', tenant: { id: 't1', name: 'T1', logo: '' } },
          { id: 'tu2', username: 'u2', fullName: 'U2', tenant: { id: 't2', name: 'T2', logo: '' } },
        ],
      });

      await auth.authenticate('user@test.com', 'pass');
      expect(auth.getAuthState()).toBe('tenant-selection');
      expect(auth.getTenantUsers()).toHaveLength(2);
    });

    it('verifyMfa completes MFA and auto-selects single tenant', async () => {
      // First authenticate with MFA required
      mockHttpFetch.mockResolvedValueOnce({
        session: 'sess1',
        expires: 3600,
        mfaState: 'REQUIRED',
        tenantUsers: [{ id: 'tu1', username: 'u', fullName: 'U', tenant: { id: 't1', name: 'T', logo: '' } }],
      });
      await auth.authenticate('u@test.com', 'p');

      // MFA commit
      mockHttpFetch.mockResolvedValueOnce({ session: 'sess2', expires: 3600 });
      // Auto select tenant
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });

      await auth.verifyMfa('123456');
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.getAuthState()).toBe('authenticated');
    });

    it('selectTenant exchanges session for tokens', async () => {
      // Authenticate with multiple tenants
      mockHttpFetch.mockResolvedValueOnce({
        session: 'sess1',
        expires: 3600,
        mfaState: 'COMPLETED',
        tenantUsers: [
          { id: 'tu1', username: 'u1', fullName: 'U1', tenant: { id: 't1', name: 'T1', logo: '' } },
          { id: 'tu2', username: 'u2', fullName: 'U2', tenant: { id: 't2', name: 'T2', logo: '' } },
        ],
      });
      await auth.authenticate('u@test.com', 'p');

      // Select tenant
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });

      const tokens = await auth.selectTenant('tu2');
      expect(tokens.accessToken).toBe('at');
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('verifyMfa throws when no active session', async () => {
      await expect(auth.verifyMfa('123')).rejects.toThrow('No active session');
    });

    it('selectTenant throws when no active session', async () => {
      await expect(auth.selectTenant('tu1')).rejects.toThrow('No active session');
    });
  });

  describe('Profile', () => {
    it('getProfile returns null when no tokens', async () => {
      const profile = await auth.getProfile();
      expect(profile).toBeNull();
    });

    it('getProfile verifies and transforms idToken', async () => {
      // Set up tokens
      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: makeJwt({
          sub: 'u1',
          preferred_username: 'testuser',
          email: 'test@test.com',
          email_verified: true,
          name: 'Test User',
        }),
      });
      await auth.handleCallback('code');

      mockJwtVerify.mockResolvedValueOnce({
        payload: {
          sub: 'u1',
          preferred_username: 'testuser',
          email: 'test@test.com',
          email_verified: true,
          name: 'Test User',
        },
      });

      const profile = await auth.getProfile();
      expect(profile).toMatchObject({
        id: 'u1',
        username: 'testuser',
        email: 'test@test.com',
      });
    });
  });

  describe('Feature flags', () => {
    it('loadFeatureFlags fetches and returns flags', async () => {
      mockHttpFetch
        .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', id_token: 'idt' }) // handleCallback
        .mockResolvedValueOnce({
          flags: [
            { flag: 'feat1', evaluation: { enabled: true } },
            { flag: 'feat2', evaluation: { enabled: false } },
          ],
        });

      await auth.handleCallback('code');
      const flags = await auth.loadFeatureFlags();
      expect(flags).toEqual({ feat1: true, feat2: false });
    });

    it('isFeatureEnabled returns cached value', async () => {
      mockHttpFetch
        .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', id_token: 'idt' })
        .mockResolvedValueOnce({
          flags: [{ flag: 'feat1', evaluation: { enabled: true } }],
        });

      await auth.handleCallback('code');
      await auth.loadFeatureFlags();
      const enabled = await auth.isFeatureEnabled('feat1');
      expect(enabled).toBe(true);
    });
  });

  describe('Route guard', () => {
    it('creates a working route guard', () => {
      const guard = auth.createRouteGuard({
        rules: [{ match: '/public', public: true }],
        defaultAccess: 'protected',
      });
      expect(guard.isPublicRoute('/public')).toBe(true);
      expect(guard.isProtectedRoute('/dashboard')).toBe(true);
      expect(guard.shouldRedirectToLogin('/dashboard')).toBe(true);
      expect(guard.shouldRedirectToLogin('/public')).toBe(false);
    });
  });

  describe('Events', () => {
    it('emits auth:login on handleCallback', async () => {
      const handler = vi.fn();
      auth.on('auth:login', handler);

      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });
      await auth.handleCallback('code');

      expect(handler).toHaveBeenCalledWith({
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'idt',
      });
    });

    it('on() returns unsubscribe function', async () => {
      const handler = vi.fn();
      const unsub = auth.on('auth:login', handler);
      unsub();

      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });
      await auth.handleCallback('code');

      expect(handler).not.toHaveBeenCalled();
    });

    it('emits auth:state-change on transitions', async () => {
      const states: string[] = [];
      auth.on('auth:state-change', (s) => states.push(s));

      mockHttpFetch.mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
      });
      await auth.handleCallback('code');

      expect(states).toContain('authenticated');
    });
  });

  describe('destroy', () => {
    it('cleans up without errors', () => {
      expect(() => auth.destroy()).not.toThrow();
    });
  });
});
