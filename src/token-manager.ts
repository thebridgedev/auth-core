import type { Logger } from './logger.js';
import { getTokenExpiry, shouldRefreshNow } from './token-utils.js';
import type { TokenSet, TokenStorage } from './types.js';

const TOKEN_KEY = 'bridge_tokens';
const MIN_CHECK_INTERVAL = 10_000; // 10 seconds

export class TokenManager {
  private tokens: TokenSet | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: TokenStorage,
    private readonly refreshFn: (rt: string) => Promise<TokenSet | null>,
    private readonly logger: Logger,
    private readonly onTokensChanged: (tokens: TokenSet | null) => void,
  ) {
    this.loadFromStorage();
  }

  getTokens(): TokenSet | null {
    return this.tokens;
  }

  isAuthenticated(): boolean {
    return !!this.tokens?.accessToken;
  }

  setTokens(tokens: TokenSet): void {
    this.tokens = tokens;
    this.storage.set(TOKEN_KEY, JSON.stringify(tokens));
    this.logger.debug('Tokens stored');
    this.onTokensChanged(tokens);
    this.scheduleRefresh();
  }

  clearTokens(): void {
    this.tokens = null;
    this.storage.remove(TOKEN_KEY);
    this.stopRefresh();
    this.onTokensChanged(null);
  }

  /** Check if refresh is needed and do it now if so. Returns true if tokens are valid after. */
  async ensureFresh(): Promise<boolean> {
    if (!this.tokens?.accessToken || !this.tokens.refreshToken) {
      return !!this.tokens?.accessToken;
    }
    if (shouldRefreshNow(this.tokens.accessToken)) {
      const newTokens = await this.refreshFn(this.tokens.refreshToken);
      if (newTokens) {
        this.setTokens(newTokens);
        return true;
      }
      this.clearTokens();
      return false;
    }
    return true;
  }

  startAutoRefresh(): void {
    this.stopRefresh();
    this.scheduleRefresh();
  }

  stopRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  destroy(): void {
    this.stopRefresh();
  }

  private loadFromStorage(): void {
    try {
      const raw = this.storage.get(TOKEN_KEY);
      if (raw) {
        this.tokens = JSON.parse(raw);
      }
    } catch (err) {
      this.logger.error('Failed to load tokens from storage', err);
    }
  }

  private scheduleRefresh(): void {
    this.stopRefresh();
    const accessToken = this.tokens?.accessToken;
    if (!accessToken) return;

    const exp = getTokenExpiry(accessToken);
    if (!exp) return;

    if (shouldRefreshNow(accessToken)) {
      this.doRefresh();
      return;
    }

    // 5 min threshold
    const checkIn = Math.max(exp - Date.now() - 5 * 60 * 1000, MIN_CHECK_INTERVAL);
    this.refreshTimer = setTimeout(() => this.doRefresh(), checkIn);
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens?.refreshToken) return;
    this.logger.debug('Attempting token refresh');

    const newTokens = await this.refreshFn(this.tokens.refreshToken);
    if (newTokens) {
      this.logger.debug('Token refreshed successfully');
      this.setTokens(newTokens);
    } else {
      this.logger.warn('Token refresh failed');
      this.clearTokens();
    }
  }
}
