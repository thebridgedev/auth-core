import { BridgeAuthError } from './errors.js';
import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type { ResolvedConfig, TokenSet } from './types.js';

// --- Public types ---

export interface ApiToken {
  id: string;
  name: string;
  privileges: string[];
  tenantId: string | null;
  expireAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}

export interface AvailablePrivilege {
  key: string;
  description: string;
}

export interface CreateApiTokenInput {
  name: string;
  privileges: string[];
  expireAt?: string;
}

export interface CreateApiTokenResponse {
  token: string;
  record: ApiToken;
}

// --- Service ---

export class ApiTokenService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly getTokens: () => TokenSet | null,
    private readonly logger: Logger,
  ) {}

  /** List privileges available for new tokens. */
  async listAvailablePrivileges(): Promise<AvailablePrivilege[]> {
    return this.request<AvailablePrivilege[]>('GET', '/account/api-token/me/app/available-privileges');
  }

  /** List all app-scoped API tokens for the current user's app. */
  async listTokens(): Promise<ApiToken[]> {
    return this.request<ApiToken[]>('GET', '/account/api-token/me/app');
  }

  /** Create a new app-scoped API token. The returned `token` is a signed JWT shown only once. */
  async createToken(input: CreateApiTokenInput): Promise<CreateApiTokenResponse> {
    return this.request<CreateApiTokenResponse>('POST', '/account/api-token/me/app', input);
  }

  /** Revoke (delete) an API token by ID. */
  async revokeToken(id: string): Promise<void> {
    await this.request<{ success: boolean }>('DELETE', `/account/api-token/me/app/${id}`);
  }

  // --- Private helper ---

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tokens = this.getTokens();
    if (!tokens?.accessToken) {
      throw new BridgeAuthError('Not authenticated. Please log in first.', 'UNAUTHENTICATED');
    }

    const url = `${this.config.apiBaseUrl}/v1${path}`;
    return httpFetch<T>(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'x-app-id': this.config.appId,
        },
        body,
      },
      this.logger,
    );
  }
}
