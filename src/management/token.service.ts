import type { ManagementHttpClient } from '../management-http.js';
import type { TokenRecord, CreateTokenRequest, CreateTokenResponse } from '../management-types.js';

export class TokenManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async list(): Promise<TokenRecord[]> {
    return this.http.get<TokenRecord[]>('/v1/account/api-token/app');
  }

  async create(data: CreateTokenRequest): Promise<CreateTokenResponse> {
    return this.http.post<CreateTokenResponse>('/v1/account/api-token/app', data);
  }

  async revoke(id: string): Promise<void> {
    return this.http.delete<void>(`/v1/account/api-token/app/${id}`);
  }
}
