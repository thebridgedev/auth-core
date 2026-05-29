import type { Logger } from './logger.js';
import { getTenantId, getTenantUserId, getTokenExpiry, shouldRefreshNow } from './token-utils.js';
import type { SessionStalePayload, TokenSet, TokenStorage } from './types.js';

const MIN_CHECK_INTERVAL = 10_000; // 10 seconds

export class TokenManager {
  private tokens: TokenSet | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private storageListener: ((e: StorageEvent) => void) | null = null;

  /** tenantUserId of the workspace this tab booted in. Captured once at construction
   *  so we can offer "switch back" if another tab races us. Null if no boot tokens. */
  private readonly bootTenantUserId: string | null;

  private get tokenKey(): string {
    return `bridge_tokens:${this.appId}`;
  }

  constructor(
    private readonly appId: string,
    private readonly storage: TokenStorage,
    private readonly refreshFn: (rt: string) => Promise<TokenSet | null>,
    private readonly logger: Logger,
    private readonly onTokensChanged: (tokens: TokenSet | null) => void,
    private readonly onSessionStale?: (payload: SessionStalePayload) => void,
  ) {
    this.loadFromStorage();
    this.bootTenantUserId = this.tokens?.accessToken
      ? getTenantUserId(this.tokens.accessToken)
      : null;
    this.installStorageListener();
  }

  getTokens(): TokenSet | null {
    return this.tokens;
  }

  /** tenantUserId for the workspace this tab booted in — use to revert after a cross-tab race. */
  getBootTenantUserId(): string | null {
    return this.bootTenantUserId;
  }

  isAuthenticated(): boolean {
    return !!this.tokens?.accessToken;
  }

  setTokens(tokens: TokenSet): void {
    this.tokens = tokens;
    this.storage.set(this.tokenKey, JSON.stringify(tokens));
    this.logger.debug('Tokens stored');
    this.onTokensChanged(tokens);
    this.scheduleRefresh();
  }

  clearTokens(): void {
    this.tokens = null;
    this.storage.remove(this.tokenKey);
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
    this.uninstallStorageListener();
  }

  private loadFromStorage(): void {
    try {
      const raw = this.storage.get(this.tokenKey);
      if (raw) {
        this.tokens = JSON.parse(raw);
      }
    } catch (err) {
      this.logger.error('Failed to load tokens from storage', err);
    }
  }

  /** Listen for cross-tab token writes. If a sibling tab's `switchWorkspace` overwrote our
   *  storage with a different `tid`, fire `onSessionStale` so the consumer can prompt the user.
   *  No-op outside browser environments and when `bootTenantUserId` is null (we never had a session). */
  private installStorageListener(): void {
    if (typeof window === 'undefined' || !this.bootTenantUserId) return;
    const listener = (e: StorageEvent) => {
      if (e.key !== this.tokenKey || e.newValue === e.oldValue) return;
      try {
        const previousTid = this.tokens?.accessToken
          ? getTenantId(this.tokens.accessToken)
          : null;
        if (!previousTid) return;

        if (!e.newValue) {
          // Another tab logged out. Mirror state and let onTokensChanged fire downstream.
          this.tokens = null;
          this.stopRefresh();
          this.onTokensChanged(null);
          return;
        }

        const newTokens = JSON.parse(e.newValue) as TokenSet;
        const newTid = newTokens.accessToken ? getTenantId(newTokens.accessToken) : null;
        if (!newTid) return;

        // Adopt the new tokens so any subsequent in-tab call uses the right header.
        this.tokens = newTokens;
        this.scheduleRefresh();

        if (newTid !== previousTid) {
          this.logger.warn('Cross-tab session change detected — workspace differs', {
            previousTid,
            newTid,
          });
          this.onSessionStale?.({
            previousTid,
            currentTid: newTid,
            previousTenantUserId: this.bootTenantUserId,
          });
        }
        // Same tid → just an external refresh in another tab; nothing to surface.
      } catch (err) {
        this.logger.error('Failed to handle storage event', err);
      }
    };
    window.addEventListener('storage', listener);
    this.storageListener = listener;
  }

  private uninstallStorageListener(): void {
    if (typeof window === 'undefined' || !this.storageListener) return;
    window.removeEventListener('storage', this.storageListener);
    this.storageListener = null;
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
