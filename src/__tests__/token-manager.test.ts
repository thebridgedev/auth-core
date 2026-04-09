import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenManager } from '../token-manager.js';
import { MemoryAdapter } from '../token-storage.js';
import type { Logger } from '../logger.js';
import type { TokenSet } from '../types.js';

// ---------------------------------------------------------------------------
// JWT helpers — build minimal JWTs with controlled expiry
// ---------------------------------------------------------------------------

function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub: 'u', exp }));
  return `${header}.${payload}.sig`;
}

/** Returns a Unix timestamp (seconds) offset from now */
function nowSec(offsetSec = 0): number {
  return Math.floor(Date.now() / 1000) + offsetSec;
}

/** A token that expires far in the future (no refresh needed) */
function freshToken(): string {
  return makeJwt(nowSec(3600)); // 1 hour from now
}

/** A token that is already about to expire (within the 5-min threshold) */
function staleToken(): string {
  return makeJwt(nowSec(60)); // 60 seconds from now — inside 5-min threshold
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRESH_TOKENS: TokenSet = {
  accessToken: freshToken(),
  refreshToken: 'refresh-token',
  idToken: 'id-token',
};

const STALE_TOKENS: TokenSet = {
  accessToken: staleToken(),
  refreshToken: 'refresh-token-stale',
  idToken: 'id-token-stale',
};

const NEW_TOKENS: TokenSet = {
  accessToken: freshToken(),
  refreshToken: 'new-refresh',
  idToken: 'new-id',
};

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeManager(opts: {
  initialStorageValue?: string | null;
  refreshResult?: TokenSet | null;
} = {}) {
  const storage = new MemoryAdapter();
  if (opts.initialStorageValue !== undefined && opts.initialStorageValue !== null) {
    storage.set('bridge_tokens', opts.initialStorageValue);
  }

  const refreshFn = vi.fn<[string], Promise<TokenSet | null>>().mockResolvedValue(
    opts.refreshResult !== undefined ? opts.refreshResult : NEW_TOKENS,
  );
  const logger = makeLogger();
  const onTokensChanged = vi.fn();

  const manager = new TokenManager(storage, refreshFn, logger, onTokensChanged);

  return { manager, storage, refreshFn, logger, onTokensChanged };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('initialization', () => {
    it('loads tokens from storage on construction', () => {
      const { manager } = makeManager({ initialStorageValue: JSON.stringify(FRESH_TOKENS) });
      expect(manager.getTokens()).toEqual(FRESH_TOKENS);
    });

    it('starts with null tokens when storage is empty', () => {
      const { manager } = makeManager();
      expect(manager.getTokens()).toBeNull();
    });

    it('handles corrupt storage data gracefully (tokens remain null)', () => {
      const { manager, logger } = makeManager({ initialStorageValue: 'not-valid-json{{{' });
      expect(manager.getTokens()).toBeNull();
      expect((logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // setTokens
  // -------------------------------------------------------------------------

  describe('setTokens', () => {
    it('stores the tokens in memory', () => {
      const { manager } = makeManager();
      manager.setTokens(FRESH_TOKENS);
      expect(manager.getTokens()).toEqual(FRESH_TOKENS);
    });

    it('persists tokens to storage', () => {
      const storage = new MemoryAdapter();
      const manager = new TokenManager(storage, vi.fn(), makeLogger(), vi.fn());
      manager.setTokens(FRESH_TOKENS);
      expect(storage.get('bridge_tokens')).toBe(JSON.stringify(FRESH_TOKENS));
    });

    it('calls onTokensChanged with the new tokens', () => {
      const { manager, onTokensChanged } = makeManager();
      manager.setTokens(FRESH_TOKENS);
      expect(onTokensChanged).toHaveBeenCalledWith(FRESH_TOKENS);
    });

    it('calls logger.debug', () => {
      const { manager, logger } = makeManager();
      manager.setTokens(FRESH_TOKENS);
      expect((logger.debug as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // clearTokens
  // -------------------------------------------------------------------------

  describe('clearTokens', () => {
    it('sets in-memory tokens to null', () => {
      const { manager } = makeManager({ initialStorageValue: JSON.stringify(FRESH_TOKENS) });
      manager.clearTokens();
      expect(manager.getTokens()).toBeNull();
    });

    it('removes tokens from storage', () => {
      const storage = new MemoryAdapter();
      storage.set('bridge_tokens', JSON.stringify(FRESH_TOKENS));
      const manager = new TokenManager(storage, vi.fn(), makeLogger(), vi.fn());
      manager.clearTokens();
      expect(storage.get('bridge_tokens')).toBeNull();
    });

    it('calls onTokensChanged with null', () => {
      const { manager, onTokensChanged } = makeManager({ initialStorageValue: JSON.stringify(FRESH_TOKENS) });
      manager.clearTokens();
      expect(onTokensChanged).toHaveBeenCalledWith(null);
    });
  });

  // -------------------------------------------------------------------------
  // isAuthenticated
  // -------------------------------------------------------------------------

  describe('isAuthenticated', () => {
    it('returns false when no tokens are stored', () => {
      const { manager } = makeManager();
      expect(manager.isAuthenticated()).toBe(false);
    });

    it('returns true when a valid accessToken is present', () => {
      const { manager } = makeManager({ initialStorageValue: JSON.stringify(FRESH_TOKENS) });
      expect(manager.isAuthenticated()).toBe(true);
    });

    it('returns false after tokens are cleared', () => {
      const { manager } = makeManager({ initialStorageValue: JSON.stringify(FRESH_TOKENS) });
      manager.clearTokens();
      expect(manager.isAuthenticated()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // ensureFresh
  // -------------------------------------------------------------------------

  describe('ensureFresh', () => {
    it('returns true when tokens are valid and no refresh needed', async () => {
      const { manager } = makeManager({ initialStorageValue: JSON.stringify(FRESH_TOKENS) });
      const result = await manager.ensureFresh();
      expect(result).toBe(true);
    });

    it('returns false (no refresh attempt) when there are no tokens', async () => {
      const { manager } = makeManager();
      const result = await manager.ensureFresh();
      expect(result).toBe(false);
    });

    it('refreshes when token is near expiry and returns true on success', async () => {
      const { manager, refreshFn, onTokensChanged } = makeManager({
        initialStorageValue: JSON.stringify(STALE_TOKENS),
        refreshResult: NEW_TOKENS,
      });

      const result = await manager.ensureFresh();

      expect(refreshFn).toHaveBeenCalledWith(STALE_TOKENS.refreshToken);
      expect(result).toBe(true);
      expect(manager.getTokens()).toEqual(NEW_TOKENS);
      expect(onTokensChanged).toHaveBeenCalledWith(NEW_TOKENS);
    });

    it('clears tokens and returns false when refresh fails', async () => {
      const { manager, onTokensChanged } = makeManager({
        initialStorageValue: JSON.stringify(STALE_TOKENS),
        refreshResult: null,
      });

      const result = await manager.ensureFresh();

      expect(result).toBe(false);
      expect(manager.getTokens()).toBeNull();
      expect(onTokensChanged).toHaveBeenCalledWith(null);
    });

    it('returns true when accessToken is valid even with no refreshToken', async () => {
      const partialTokens: TokenSet = {
        accessToken: freshToken(),
        refreshToken: '',
        idToken: 'id',
      };
      const { manager } = makeManager({ initialStorageValue: JSON.stringify(partialTokens) });
      const result = await manager.ensureFresh();
      expect(result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // scheduleRefresh (via setTokens with fake timers)
  // -------------------------------------------------------------------------

  describe('scheduleRefresh', () => {
    it('calls refreshFn after the scheduled delay when expiry is set', async () => {
      // Token expires in 10 minutes; 5-min threshold → scheduled in ~5 min
      const tokens: TokenSet = {
        accessToken: makeJwt(nowSec(10 * 60)),
        refreshToken: 'ref',
        idToken: 'id',
      };

      // Return null so setTokens is NOT called again after refresh, preventing a recursive timer chain
      const { manager, refreshFn } = makeManager({ refreshResult: null });
      manager.setTokens(tokens);

      // Advance past the check-in time (>= 5 min)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10_001);

      expect(refreshFn).toHaveBeenCalled();
    });

    it('immediately calls refreshFn when token already needs refresh on setTokens', async () => {
      const { manager, refreshFn } = makeManager({ refreshResult: NEW_TOKENS });
      // setTokens with a stale token triggers doRefresh() immediately (synchronously calls doRefresh)
      // doRefresh is async, so we flush the microtask queue with Promise.resolve()
      manager.setTokens(STALE_TOKENS);

      // Flush microtasks so the async doRefresh() call completes
      await Promise.resolve();
      await Promise.resolve();

      expect(refreshFn).toHaveBeenCalled();
    });

    it('stops the refresh timer on destroy', async () => {
      const tokens: TokenSet = {
        accessToken: makeJwt(nowSec(10 * 60)),
        refreshToken: 'ref',
        idToken: 'id',
      };

      const { manager, refreshFn } = makeManager({ refreshResult: NEW_TOKENS });
      manager.setTokens(tokens);
      manager.destroy();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(refreshFn).not.toHaveBeenCalled();
    });
  });
});
