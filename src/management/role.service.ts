import type { ManagementHttpClient } from '../management-http.js';
import type { RoleResponse, CreateRoleRequest, UpdateRoleRequest } from '../management-types.js';

export class RoleManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async list(): Promise<RoleResponse[]> {
    return this.http.get<RoleResponse[]>('/v1/account/role');
  }

  async create(data: CreateRoleRequest): Promise<RoleResponse> {
    return this.http.post<RoleResponse>('/v1/account/role', data);
  }

  async update(id: string, data: UpdateRoleRequest): Promise<RoleResponse> {
    return this.http.put<RoleResponse>(`/v1/account/role/${id}`, data);
  }

  async delete(id: string): Promise<void> {
    return this.http.delete<void>(`/v1/account/role/${id}`);
  }
}
