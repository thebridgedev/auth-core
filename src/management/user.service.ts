import type { ManagementHttpClient } from '../management-http.js';
import type { UserResponse, InviteUserRequest, UpdateUserRequest } from '../management-types.js';

export class UserManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  private tenantHeader(tenantId: string): Record<string, string> {
    return { 'x-tenant-id': tenantId };
  }

  async list(tenantId: string): Promise<UserResponse[]> {
    return this.http.get<UserResponse[]>('/v1/account/tenant/user', this.tenantHeader(tenantId));
  }

  async get(tenantId: string, userId: string): Promise<UserResponse> {
    return this.http.get<UserResponse>(`/v1/account/tenant/user/${userId}`, this.tenantHeader(tenantId));
  }

  async invite(tenantId: string, data: InviteUserRequest): Promise<UserResponse> {
    return this.http.post<UserResponse>('/v1/account/tenant/user', data, this.tenantHeader(tenantId));
  }

  async update(tenantId: string, userId: string, data: UpdateUserRequest): Promise<UserResponse> {
    return this.http.put<UserResponse>(`/v1/account/tenant/user/${userId}`, data, this.tenantHeader(tenantId));
  }

  async remove(tenantId: string, userId: string): Promise<void> {
    return this.http.delete<void>(`/v1/account/tenant/user/${userId}`, this.tenantHeader(tenantId));
  }
}
