import type { ManagementHttpClient } from '../management-http.js';
import type { TenantResponse, CreateTenantRequest, UpdateTenantRequest } from '../management-types.js';

export class TenantManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async list(): Promise<TenantResponse[]> {
    return this.http.get<TenantResponse[]>('/v1/account/tenant');
  }

  async get(id: string): Promise<TenantResponse> {
    return this.http.get<TenantResponse>(`/v1/account/tenant/byId/${id}`);
  }

  async create(data: CreateTenantRequest): Promise<TenantResponse> {
    return this.http.post<TenantResponse>('/v1/account/tenant', data);
  }

  async update(id: string, data: UpdateTenantRequest): Promise<TenantResponse> {
    return this.http.put<TenantResponse>(`/v1/account/tenant/${id}`, data);
  }

  async delete(id: string): Promise<void> {
    return this.http.delete<void>(`/v1/account/tenant/${id}`);
  }
}
