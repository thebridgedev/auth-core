import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoleManagementService } from '../../management/role.service.js';
import type { ManagementHttpClient } from '../../management-http.js';

function createMockHttp(): ManagementHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ManagementHttpClient;
}

describe('RoleManagementService', () => {
  let http: ManagementHttpClient;
  let service: RoleManagementService;

  beforeEach(() => {
    http = createMockHttp();
    service = new RoleManagementService(http as any);
  });

  describe('roles', () => {
    it('list() calls GET /v1/account/role', async () => {
      const roles = [{ id: 'r1', key: 'ADMIN' }];
      (http.get as any).mockResolvedValue(roles);

      const result = await service.list();

      expect(http.get).toHaveBeenCalledWith('/v1/account/role');
      expect(result).toEqual(roles);
    });

    it('create() calls POST /v1/account/role with the body', async () => {
      const input = {
        name: 'Admin',
        key: 'ADMIN',
        privileges: ['p1'],
        isDefault: false,
      };
      (http.post as any).mockResolvedValue({ id: 'r1', ...input });

      const result = await service.create(input);

      expect(http.post).toHaveBeenCalledWith('/v1/account/role', input);
      expect(result).toEqual({ id: 'r1', ...input });
    });

    it('update() calls PUT /v1/account/role/:id with the body', async () => {
      const update = { name: 'Admin renamed' };
      (http.put as any).mockResolvedValue({ id: 'r1', ...update });

      await service.update('r1', update);

      expect(http.put).toHaveBeenCalledWith('/v1/account/role/r1', update);
    });

    it('delete() calls DELETE /v1/account/role/:id', async () => {
      (http.delete as any).mockResolvedValue(undefined);

      await service.delete('r1');

      expect(http.delete).toHaveBeenCalledWith('/v1/account/role/r1');
    });
  });

  // TBP-592 / TBP-589 — privilege CRUD existed on the API but nothing in the
  // SDK exposed it, so `--privileges` could not resolve keys to ids.
  describe('privileges', () => {
    it('listPrivileges() calls GET /v1/account/role/privilege', async () => {
      const privileges = [
        { id: 'p1', key: 'ROLE_READ' },
        { id: 'p2', key: 'ROLE_DELETE' },
      ];
      (http.get as any).mockResolvedValue(privileges);

      const result = await service.listPrivileges();

      expect(http.get).toHaveBeenCalledWith('/v1/account/role/privilege');
      expect(http.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual(privileges);
    });

    it('createPrivilege() calls POST /v1/account/role/privilege with the body', async () => {
      const input = { key: 'REPORT_EXPORT', description: 'Export reports' };
      const created = { id: 'p9', ...input };
      (http.post as any).mockResolvedValue(created);

      const result = await service.createPrivilege(input);

      expect(http.post).toHaveBeenCalledWith('/v1/account/role/privilege', input);
      expect(http.post).toHaveBeenCalledTimes(1);
      expect(result).toEqual(created);
    });

    it('updatePrivilege() calls PUT /v1/account/role/privilege/:id with the body', async () => {
      const update = { description: 'Export reports as CSV' };
      const updated = { id: 'p9', key: 'REPORT_EXPORT', ...update };
      (http.put as any).mockResolvedValue(updated);

      const result = await service.updatePrivilege('p9', update);

      expect(http.put).toHaveBeenCalledWith('/v1/account/role/privilege/p9', update);
      expect(http.put).toHaveBeenCalledTimes(1);
      expect(result).toEqual(updated);
    });

    it('deletePrivilege() calls DELETE /v1/account/role/privilege/:id', async () => {
      (http.delete as any).mockResolvedValue(undefined);

      await service.deletePrivilege('p9');

      expect(http.delete).toHaveBeenCalledWith('/v1/account/role/privilege/p9');
      expect(http.delete).toHaveBeenCalledTimes(1);
    });

    it('privilege paths are nested under the role resource, not a sibling of it', async () => {
      (http.get as any).mockResolvedValue([]);
      (http.delete as any).mockResolvedValue(undefined);

      await service.listPrivileges();
      await service.deletePrivilege('p9');

      const paths = [
        (http.get as any).mock.calls[0][0],
        (http.delete as any).mock.calls[0][0],
      ];
      for (const path of paths) {
        expect(path.startsWith('/v1/account/role/privilege')).toBe(true);
      }
    });
  });
});
