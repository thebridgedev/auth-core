import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantManagementService } from '../../management/tenant.service.js';
import type { ManagementHttpClient } from '../../management-http.js';

function createMockHttp(): ManagementHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ManagementHttpClient;
}

describe('TenantManagementService', () => {
  let http: ReturnType<typeof createMockHttp>;
  let service: TenantManagementService;

  beforeEach(() => {
    http = createMockHttp();
    service = new TenantManagementService(http as any);
  });

  it('list() calls GET /v1/account/tenant', async () => {
    const tenants = [{ id: 't1', name: 'Acme' }];
    (http.get as any).mockResolvedValue(tenants);

    const result = await service.list();

    expect(http.get).toHaveBeenCalledWith('/v1/account/tenant');
    expect(result).toEqual(tenants);
  });

  it('get(id) calls GET /v1/account/tenant/byId/:id', async () => {
    const tenant = { id: 't1', name: 'Acme' };
    (http.get as any).mockResolvedValue(tenant);

    const result = await service.get('t1');

    expect(http.get).toHaveBeenCalledWith('/v1/account/tenant/byId/t1');
    expect(result).toEqual(tenant);
  });

  it('create() calls POST /v1/account/tenant', async () => {
    const input = { owner: { email: 'admin@acme.com' }, name: 'Acme' };
    const created = { id: 't1', ...input };
    (http.post as any).mockResolvedValue(created);

    const result = await service.create(input);

    expect(http.post).toHaveBeenCalledWith('/v1/account/tenant', input);
    expect(result).toEqual(created);
  });

  it('update() calls PUT /v1/account/tenant/:id', async () => {
    const update = { name: 'Acme Updated' };
    (http.put as any).mockResolvedValue({ id: 't1', ...update });

    await service.update('t1', update);

    expect(http.put).toHaveBeenCalledWith('/v1/account/tenant/t1', update);
  });

  it('delete() calls DELETE /v1/account/tenant/:id', async () => {
    (http.delete as any).mockResolvedValue(undefined);

    await service.delete('t1');

    expect(http.delete).toHaveBeenCalledWith('/v1/account/tenant/t1');
  });
});
