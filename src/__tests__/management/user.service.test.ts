import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserManagementService } from '../../management/user.service.js';
import type { ManagementHttpClient } from '../../management-http.js';

function createMockHttp(): ManagementHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ManagementHttpClient;
}

describe('UserManagementService', () => {
  let http: ReturnType<typeof createMockHttp>;
  let service: UserManagementService;

  beforeEach(() => {
    http = createMockHttp();
    service = new UserManagementService(http as any);
  });

  it('list() passes x-tenant-id header', async () => {
    (http.get as any).mockResolvedValue([]);

    await service.list('tenant-123');

    expect(http.get).toHaveBeenCalledWith('/v1/account/tenant/user', { 'x-tenant-id': 'tenant-123' });
  });

  it('invite() sends user data with tenant header', async () => {
    const input = { username: 'alice@acme.com', role: 'ADMIN' };
    (http.post as any).mockResolvedValue({ id: 'u1', ...input });

    await service.invite('tenant-123', input);

    expect(http.post).toHaveBeenCalledWith('/v1/account/tenant/user', input, { 'x-tenant-id': 'tenant-123' });
  });

  it('update() sends PUT with tenant header', async () => {
    const update = { role: 'OWNER' };
    (http.put as any).mockResolvedValue({ id: 'u1', ...update });

    await service.update('tenant-123', 'u1', update);

    expect(http.put).toHaveBeenCalledWith('/v1/account/tenant/user/u1', update, { 'x-tenant-id': 'tenant-123' });
  });

  it('remove() sends DELETE with tenant header', async () => {
    (http.delete as any).mockResolvedValue(undefined);

    await service.remove('tenant-123', 'u1');

    expect(http.delete).toHaveBeenCalledWith('/v1/account/tenant/user/u1', { 'x-tenant-id': 'tenant-123' });
  });
});
