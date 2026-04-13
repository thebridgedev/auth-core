import type { Logger } from './logger.js';
import type { ResolvedConfig, SsoOptions, SsoResult } from './types.js';

const DEFAULT_WIDTH = 500;
const DEFAULT_HEIGHT = 600;
const POPUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages SSO federation kickoff in either 'redirect' or 'popup' mode.
 *
 * Redirect mode (default) navigates the current tab to the federation endpoint
 * and lets the provider's OAuth callback chain bring the user back normally.
 * Popup mode opens window.open and resolves via postMessage — useful for
 * embedded widgets.
 */
export class SsoPopupManager {
  private popup: Window | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
  ) {}

  startSsoLogin(provider: string, opts?: SsoOptions): Promise<SsoResult> {
    const mode = opts?.mode ?? 'redirect';
    if (mode === 'redirect') {
      return this.startRedirect(provider);
    }
    return this.startPopup(provider, opts);
  }

  private startRedirect(provider: string): Promise<SsoResult> {
    const url = new URL(`${this.config.authBaseUrl}/auth/federation/${this.config.appId}`);
    url.searchParams.set('provider', provider);

    this.logger.debug('SSO redirect kickoff', url.toString());
    window.location.assign(url.toString());

    // Tab is navigating away — this promise intentionally never resolves.
    return new Promise<SsoResult>(() => { /* no-op */ });
  }

  private startPopup(provider: string, opts?: SsoOptions): Promise<SsoResult> {
    return new Promise((resolve, reject) => {
      const width = opts?.width ?? DEFAULT_WIDTH;
      const height = opts?.height ?? DEFAULT_HEIGHT;
      const left = Math.round((screen.width - width) / 2);
      const top = Math.round((screen.height - height) / 2);

      const url = new URL(`${this.config.authBaseUrl}/auth/federation/${this.config.appId}`);
      url.searchParams.set('provider', provider);
      url.searchParams.set('mode', 'popup');
      url.searchParams.set('targetOrigin', window.location.origin);

      this.popup = window.open(
        url.toString(),
        'bridge-sso-popup',
        `width=${width},height=${height},left=${left},top=${top},popup=yes`,
      );

      if (!this.popup) {
        reject(new Error('Failed to open SSO popup. Check popup blocker settings.'));
        return;
      }

      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error('SSO popup timed out'));
      }, POPUP_TIMEOUT_MS);

      const pollTimer = setInterval(() => {
        if (this.popup?.closed) {
          clearInterval(pollTimer);
          clearTimeout(timeout);
          this.cleanup();
          reject(new Error('SSO popup was closed by user'));
        }
      }, 500);

      this.messageHandler = (event: MessageEvent) => {
        const expectedOrigin = new URL(this.config.authBaseUrl).origin;
        if (event.origin !== expectedOrigin) {
          this.logger.debug(`Ignoring postMessage from ${event.origin}, expected ${expectedOrigin}`);
          return;
        }

        const data = event.data;
        if (!data || typeof data.type !== 'string' || !data.type.startsWith('auth_')) return;

        clearTimeout(timeout);
        clearInterval(pollTimer);
        this.cleanup();

        this.logger.debug('SSO popup result', data.type);

        resolve({
          type: data.type,
          session: data.session,
          expires: data.expires,
          mfaState: data.mfaState,
          tenantUsers: data.tenantUsers,
          tokens: data.tokens,
          error: data.error,
        } as SsoResult);
      };

      window.addEventListener('message', this.messageHandler);
    });
  }

  close(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.popup && !this.popup.closed) {
      this.popup.close();
    }
    this.popup = null;
  }
}
