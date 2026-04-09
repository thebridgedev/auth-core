import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type { ResolvedConfig, TokenSet } from './types.js';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
}

export class AuthService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
  ) {}

  createLoginUrl(options: { redirectUri?: string } = {}): string {
    const redirectUri = options.redirectUri ?? this.config.callbackUrl;
    const base = `${this.config.hostedUrl}/auth/login/${this.config.appId}`;
    return redirectUri
      ? `${base}?redirectUri=${encodeURIComponent(redirectUri)}`
      : base;
  }

  createLogoutUrl(): string {
    return `${this.config.authBaseUrl}/url/logout/${this.config.appId}`;
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    const url = `${this.config.authBaseUrl}/token/code/${this.config.appId}`;
    const body: Record<string, string> = { code };

    if (this.config.callbackUrl) {
      body.redirect_uri = this.config.callbackUrl;
      body.redirectUri = this.config.callbackUrl;
    }

    const data = await httpFetch<TokenResponse>(url, {
      method: 'POST',
      body,
    }, this.logger);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  async getCodeFromToken(accessToken: string, redirectUri?: string): Promise<string> {
    const url = `${this.config.authBaseUrl}/token/code-from-token/${this.config.appId}`;
    const body: Record<string, string> = { accessToken };
    if (redirectUri) {
      body.redirectUri = redirectUri;
    }
    const data = await httpFetch<{ code: string }>(url, {
      method: 'POST',
      body,
    }, this.logger);
    return data.code;
  }

  async refreshToken(refreshTokenValue: string): Promise<TokenSet | null> {
    const url = `${this.config.authBaseUrl}/token`;

    try {
      const data = await httpFetch<TokenResponse>(url, {
        method: 'POST',
        body: {
          client_id: this.config.appId,
          grant_type: 'refresh_token',
          refresh_token: refreshTokenValue,
        },
      }, this.logger);

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        idToken: data.id_token,
      };
    } catch (err) {
      this.logger.error('Failed to refresh token', err);
      return null;
    }
  }
}
