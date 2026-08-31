import type { ManagementHttpClient } from '../management-http.js';
import type {
  RoleResponse,
  CreateRoleRequest,
  UpdateRoleRequest,
  PrivilegeResponse,
  CreatePrivilegeRequest,
  UpdatePrivilegeRequest,
} from '../management-types.js';

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

  // ── Privileges ────────────────────────────────────────────────────────────
  //
  // TBP-592 / TBP-589 — the API has served full privilege CRUD under
  // `/account/role/privilege` all along; nothing exposed it. Provisioning an
  // app with custom privileges therefore meant raw HTTP against the account
  // API, and `--privileges` could not resolve keys to ids because there was no
  // way to list them.

  async listPrivileges(): Promise<PrivilegeResponse[]> {
    return this.http.get<PrivilegeResponse[]>('/v1/account/role/privilege');
  }

  async createPrivilege(data: CreatePrivilegeRequest): Promise<PrivilegeResponse> {
    return this.http.post<PrivilegeResponse>('/v1/account/role/privilege', data);
  }

  async updatePrivilege(id: string, data: UpdatePrivilegeRequest): Promise<PrivilegeResponse> {
    return this.http.put<PrivilegeResponse>(`/v1/account/role/privilege/${id}`, data);
  }

  /**
   * Requires the `ROLE_DELETE` privilege on the calling token. Destructive
   * privileges are opt-in and never granted by default (TBP-552), so a token
   * from a plain `bridge auth login` is refused with 403 — use
   * `bridge auth login --admin` (TBP-593).
   */
  async deletePrivilege(id: string): Promise<void> {
    return this.http.delete<void>(`/v1/account/role/privilege/${id}`);
  }
}
