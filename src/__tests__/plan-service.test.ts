import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanService } from '../plan-service.js';
import { BridgeAuthError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ResolvedConfig, TokenSet } from '../types.js';

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

const TOKENS: TokenSet = {
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  idToken: 'id-tok',
};

const logger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeService(tokens: TokenSet | null = TOKENS): PlanService {
  const getTokens = vi.fn(() => tokens);
  return new PlanService(CONFIG, getTokens, logger);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // setSecurityCookie
  // -------------------------------------------------------------------------

  describe('setSecurityCookie', () => {
    it('POSTs to the setCookie endpoint with the Bearer authorization header', async () => {
      mockHttpFetch.mockResolvedValue({});

      const service = makeService();
      await service.setSecurityCookie();

      const [url, opts] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/cloud-views/security/setCookie');
      expect(opts.method).toBe('POST');
      expect(opts.headers).toMatchObject({ Authorization: `Bearer ${TOKENS.accessToken}` });
    });

    it('passes credentials: include so the browser sends cookies', async () => {
      mockHttpFetch.mockResolvedValue({});

      const service = makeService();
      await service.setSecurityCookie();

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.credentials).toBe('include');
    });

    it('throws BridgeAuthError when there is no access token', async () => {
      const service = makeService(null);

      await expect(service.setSecurityCookie()).rejects.toBeInstanceOf(BridgeAuthError);
    });

    it('does not call httpFetch when no token is available', async () => {
      const service = makeService(null);

      await expect(service.setSecurityCookie()).rejects.toThrow();
      expect(mockHttpFetch).not.toHaveBeenCalled();
    });

    it('logs a debug message on success', async () => {
      mockHttpFetch.mockResolvedValue({});
      const service = makeService();

      await service.setSecurityCookie();

      expect((logger.debug as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('Security cookie set');
    });
  });

  // -------------------------------------------------------------------------
  // getHandoverUrl
  // -------------------------------------------------------------------------

  describe('getHandoverUrl', () => {
    it('POSTs to the handover code endpoint with the accessToken', async () => {
      mockHttpFetch.mockResolvedValue({ code: 'HANDOVER_CODE' });

      const service = makeService();
      await service.getHandoverUrl();

      const [url, opts] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/auth/handover/code/app1');
      expect(opts.method).toBe('POST');
      expect(opts.body).toMatchObject({ accessToken: TOKENS.accessToken });
    });

    it('builds the correct subscription-portal URL from the returned code', async () => {
      mockHttpFetch.mockResolvedValue({ code: 'CODE123' });

      const service = makeService();
      const url = await service.getHandoverUrl();

      expect(url).toBe('https://hosted.example.com/subscription-portal/selectPlan?code=CODE123');
    });

    it('throws BridgeAuthError when there is no access token', async () => {
      const service = makeService(null);

      await expect(service.getHandoverUrl()).rejects.toBeInstanceOf(BridgeAuthError);
    });

    it('does not call httpFetch when no token is available', async () => {
      const service = makeService(null);

      await expect(service.getHandoverUrl()).rejects.toThrow();
      expect(mockHttpFetch).not.toHaveBeenCalled();
    });

    it('throws BridgeAuthError when the response does not contain a code', async () => {
      mockHttpFetch.mockResolvedValue({});

      const service = makeService();

      await expect(service.getHandoverUrl()).rejects.toBeInstanceOf(BridgeAuthError);
    });

    it('throws with a meaningful message when no code is returned', async () => {
      mockHttpFetch.mockResolvedValue({});

      const service = makeService();

      await expect(service.getHandoverUrl()).rejects.toThrow(
        'Handover response did not contain a code',
      );
    });
  });
});
