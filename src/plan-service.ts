import { BridgeAuthError } from './errors.js';
import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type { ResolvedConfig, TokenSet } from './types.js';

export class PlanService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly getTokens: () => TokenSet | null,
    private readonly logger: Logger,
  ) {}

  async setSecurityCookie(): Promise<void> {
    const token = this.getTokens()?.accessToken;
    if (!token) {
      throw new BridgeAuthError('No access token available. Please log in first.');
    }

    await httpFetch(
      `${this.config.apiBaseUrl}/cloud-views/security/setCookie`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      },
      this.logger,
    );
    this.logger.debug('Security cookie set');
  }

  async getHandoverUrl(): Promise<string> {
    const accessToken = this.getTokens()?.accessToken;
    if (!accessToken) {
      throw new BridgeAuthError('No access token available. Please log in first.');
    }

    const data = await httpFetch<{ code: string }>(
      `${this.config.authBaseUrl}/handover/code/${this.config.appId}`,
      { method: 'POST', body: { accessToken } },
      this.logger,
    );

    if (!data.code) {
      throw new BridgeAuthError('Handover response did not contain a code');
    }

    return `${this.config.hostedUrl}/subscription-portal/selectPlan?code=${data.code}`;
  }

  async redirectToPlanSelection(): Promise<void> {
    const url = await this.getHandoverUrl();
    this.logger.debug('Redirecting to plan selection', url);
    window.location.href = url;
  }
}
