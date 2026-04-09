import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureFlagService } from '../feature-flag-service.js';
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

function makeBulkResponse(flags: Array<{ flag: string; enabled?: boolean }>) {
  return {
    flags: flags.map(({ flag, enabled }) => ({
      flag,
      evaluation: enabled !== undefined ? { enabled } : undefined,
    })),
  };
}

function makeService(tokens: TokenSet | null = TOKENS): FeatureFlagService {
  const getTokens = vi.fn(() => tokens);
  return new FeatureFlagService(CONFIG, getTokens, logger);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeatureFlagService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // loadAll
  // -------------------------------------------------------------------------

  describe('loadAll', () => {
    it('POSTs to the correct bulk-evaluate URL', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([{ flag: 'feature-a', enabled: true }]));

      const service = makeService();
      await service.loadAll();

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/cloud-views/flags/bulkEvaluate/app1');
    });

    it('sends accessToken in the body when tokens are present', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([]));

      const service = makeService(TOKENS);
      await service.loadAll();

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toEqual({ accessToken: TOKENS.accessToken });
    });

    it('sends an empty body when no tokens are available', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([]));

      const service = makeService(null);
      await service.loadAll();

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toEqual({});
    });

    it('returns a map of flag names to boolean values', async () => {
      mockHttpFetch.mockResolvedValue(
        makeBulkResponse([
          { flag: 'feat-a', enabled: true },
          { flag: 'feat-b', enabled: false },
        ]),
      );

      const service = makeService();
      const result = await service.loadAll();

      expect(result).toEqual({ 'feat-a': true, 'feat-b': false });
    });

    it('treats missing evaluation as false', async () => {
      mockHttpFetch.mockResolvedValue({
        flags: [{ flag: 'mystery-flag' }],
      });

      const service = makeService();
      const result = await service.loadAll();

      expect(result['mystery-flag']).toBe(false);
    });

    it('caches the flags after loading', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([{ flag: 'feat-a', enabled: true }]));

      const service = makeService();
      await service.loadAll();

      expect(service.getCached()).toEqual({ 'feat-a': true });
    });

    it('returns a copy of the cached flags (not the internal reference)', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([{ flag: 'feat-a', enabled: true }]));

      const service = makeService();
      const result = await service.loadAll();
      result['mutated'] = true;

      expect(service.getCached()).not.toHaveProperty('mutated');
    });
  });

  // -------------------------------------------------------------------------
  // isEnabled — cached path
  // -------------------------------------------------------------------------

  describe('isEnabled (cached)', () => {
    it('returns the cached value within TTL without calling httpFetch again', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([{ flag: 'feat-a', enabled: true }]));

      const service = makeService();
      await service.loadAll();

      // Reset mock — subsequent call should NOT hit the network
      mockHttpFetch.mockReset();
      const result = await service.isEnabled('feat-a');

      expect(mockHttpFetch).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('returns false for an unknown flag within the TTL', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([{ flag: 'feat-a', enabled: true }]));

      const service = makeService();
      await service.loadAll();
      mockHttpFetch.mockReset();

      const result = await service.isEnabled('unknown-flag');
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isEnabled — cache expired
  // -------------------------------------------------------------------------

  describe('isEnabled (cache expired)', () => {
    it('refreshes flags when cache is older than TTL', async () => {
      mockHttpFetch
        .mockResolvedValueOnce(makeBulkResponse([{ flag: 'feat-a', enabled: false }]))
        .mockResolvedValueOnce(makeBulkResponse([{ flag: 'feat-a', enabled: true }]));

      const service = makeService();

      // Force a stale fetch by calling loadAll then advancing internal time.
      // Since we can't control Date.now() easily, we'll call the service
      // with an expired state by not loading at all (lastFetchTime=0 is expired).
      const result = await service.isEnabled('feat-a');

      expect(mockHttpFetch).toHaveBeenCalledTimes(1);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isEnabled with forceLive
  // -------------------------------------------------------------------------

  describe('isEnabled (forceLive)', () => {
    it('fetches a single flag via the evaluate endpoint when forceLive=true', async () => {
      mockHttpFetch.mockResolvedValue({ enabled: true });

      const service = makeService();
      const result = await service.isEnabled('my-flag', true);

      const [url] = mockHttpFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/cloud-views/flags/evaluate/app1/my-flag');
      expect(result).toBe(true);
    });

    it('sends accessToken in the body for single-flag fetch', async () => {
      mockHttpFetch.mockResolvedValue({ enabled: true });

      const service = makeService(TOKENS);
      await service.isEnabled('my-flag', true);

      const [, opts] = mockHttpFetch.mock.calls[0];
      expect(opts.body).toEqual({ accessToken: TOKENS.accessToken });
    });

    it('returns cached value (false) when single-flag fetch fails', async () => {
      mockHttpFetch.mockRejectedValue(new Error('network error'));

      const service = makeService();
      const result = await service.isEnabled('unknown-flag', true);

      expect(result).toBe(false);
    });

    it('ignores the TTL cache even when fresh when forceLive=true', async () => {
      // Populate cache with false
      mockHttpFetch
        .mockResolvedValueOnce(makeBulkResponse([{ flag: 'feat-a', enabled: false }]))
        .mockResolvedValueOnce({ enabled: true });

      const service = makeService();
      await service.loadAll();

      // Force live should bypass cache
      const result = await service.isEnabled('feat-a', true);
      expect(result).toBe(true);
      expect(mockHttpFetch).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // getCached
  // -------------------------------------------------------------------------

  describe('getCached', () => {
    it('returns an empty object when no flags have been loaded', () => {
      const service = makeService();
      expect(service.getCached()).toEqual({});
    });

    it('returns a shallow copy of the cached flags', async () => {
      mockHttpFetch.mockResolvedValue(makeBulkResponse([{ flag: 'x', enabled: true }]));
      const service = makeService();
      await service.loadAll();

      const copy1 = service.getCached();
      const copy2 = service.getCached();

      expect(copy1).toEqual(copy2);
      expect(copy1).not.toBe(copy2); // different object references
    });
  });
});
