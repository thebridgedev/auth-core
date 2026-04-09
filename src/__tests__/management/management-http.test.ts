import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagementHttpClient } from '../../management-http.js';
import { HttpError } from '../../errors.js';

const mockLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('ManagementHttpClient', () => {
  let client: ManagementHttpClient;

  beforeEach(() => {
    client = new ManagementHttpClient('https://api.test.dev', 'test-api-key', mockLogger);
    vi.restoreAllMocks();
  });

  it('sends x-api-key header on GET requests', async () => {
    const mockResponse = { id: '123', name: 'Test' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const result = await client.get('/v1/account/app');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.dev/v1/account/app',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('sends x-api-key header on POST with body', async () => {
    const body = { name: 'Acme' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: '1', ...body }), { status: 201 }),
    );

    await client.post('/v1/account/tenant', body);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.dev/v1/account/tenant',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });

  it('merges extra headers (e.g., x-tenant-id)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await client.get('/v1/account/tenant/user', { 'x-tenant-id': 'tenant-123' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.dev/v1/account/tenant/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
          'x-tenant-id': 'tenant-123',
        }),
      }),
    );
  });

  it('sends PUT requests with body', async () => {
    const body = { name: 'Updated' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: '1', ...body }), { status: 200 }),
    );

    await client.put('/v1/account/tenant/123', body);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.dev/v1/account/tenant/123',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(body) }),
    );
  });

  it('sends DELETE requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );

    await client.delete('/v1/account/tenant/123');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.dev/v1/account/tenant/123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws HttpError on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not found', statusCode: 404 }), { status: 404, statusText: 'Not Found' }),
    );

    await expect(client.get('/v1/account/tenant/byId/missing')).rejects.toThrow(HttpError);

    try {
      await client.get('/v1/account/tenant/byId/missing');
    } catch (err) {
      expect((err as HttpError).status).toBe(404);
    }
  });
});
