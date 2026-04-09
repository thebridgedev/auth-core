import type { ManagementHttpClient } from '../management-http.js';
import type { AppResponse, UpdateAppRequest, CredentialsState, UpdateCredentialsRequest } from '../management-types.js';

export class AppManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async get(): Promise<AppResponse> {
    return this.http.get<AppResponse>('/v1/account/app');
  }

  async update(data: UpdateAppRequest): Promise<AppResponse> {
    return this.http.put<AppResponse>('/v1/account/app', data);
  }

  async getCredentialsState(): Promise<CredentialsState> {
    return this.http.get<CredentialsState>('/v1/account/app/credentialsState');
  }

  async updateCredentials(data: UpdateCredentialsRequest): Promise<CredentialsState> {
    return this.http.put<CredentialsState>('/v1/account/app/credentials', data);
  }
}
