import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventManagementService } from '../../management/event.service.js';
import type { ManagementHttpClient } from '../../management-http.js';
import type { EventQuery } from '../../management-types.js';

function createMockHttp(): ManagementHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ManagementHttpClient;
}

/** The instant every relative `--since` expectation below is anchored to. */
const FIXED_NOW = '2026-08-31T12:00:00.000Z';

/** The single path argument `query()` handed to the HTTP client. */
function requestedPath(http: ManagementHttpClient): string {
  const calls = (http.get as any).mock.calls;
  expect(calls.length).toBe(1);
  return calls[0][0] as string;
}

/** The query string of that path, parsed. */
function requestedParams(http: ManagementHttpClient): URLSearchParams {
  const path = requestedPath(http);
  const qs = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  return new URLSearchParams(qs);
}

describe('EventManagementService', () => {
  let http: ManagementHttpClient;
  let service: EventManagementService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
    http = createMockHttp();
    service = new EventManagementService(http as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('endpoint', () => {
    // Regression: query() used to GET /v1/event-log, a route the API has never
    // served, so `bridge event list` always 404'd (TBP-594, 2026-08-31).
    it('query() hits /v1/event-log/audit, not /v1/event-log', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query();

      const path = requestedPath(http);
      expect(path.startsWith('/v1/event-log/audit')).toBe(true);
      expect(path).toBe('/v1/event-log/audit');
    });

    it('query() sends no query string when given no params', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query();

      expect(http.get).toHaveBeenCalledWith('/v1/event-log/audit');
      expect(requestedPath(http)).not.toContain('?');
    });

    it('query() keeps the /audit path in front of the query string', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query({ limit: 5 });

      const path = requestedPath(http);
      expect(path.startsWith('/v1/event-log/audit?')).toBe(true);
    });
  });

  describe('query parameter mapping', () => {
    it('sends type as eventName, and tenantId/userId/limit under their own names', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query({
        type: 'USER_CREATED',
        tenantId: 'tenant-1',
        userId: 'user-1',
        limit: 25,
      });

      const params = requestedParams(http);
      expect(params.get('eventName')).toBe('USER_CREATED');
      expect(params.get('tenantId')).toBe('tenant-1');
      expect(params.get('userId')).toBe('user-1');
      expect(params.get('limit')).toBe('25');
      // `type` is the SDK-facing name; the API knows it as `eventName`.
      expect(params.get('type')).toBeNull();
    });

    it('never sends appId — the server derives it from the token', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query({
        type: 'USER_CREATED',
        tenantId: 'tenant-1',
        userId: 'user-1',
        limit: 25,
        appId: 'app-should-not-leak',
      } as EventQuery & { appId: string });

      const path = requestedPath(http);
      expect(requestedParams(http).get('appId')).toBeNull();
      expect(path).not.toContain('appId');
      expect(path).not.toContain('app-should-not-leak');
    });

    it('omits params that were not supplied', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query({ tenantId: 'tenant-1' });

      const params = requestedParams(http);
      expect([...params.keys()]).toEqual(['tenantId']);
    });
  });

  describe('since → from (toIsoDate)', () => {
    // The API validates `from` with @IsDateString(), so "24h" would be
    // rejected outright — relative forms must be resolved client-side.
    const cases: Array<[string, string]> = [
      ['24h', '2026-08-30T12:00:00.000Z'],
      ['7d', '2026-08-24T12:00:00.000Z'],
      ['2w', '2026-08-17T12:00:00.000Z'],
      ['3m', '2026-06-02T12:00:00.000Z'],
    ];

    for (const [since, expected] of cases) {
      it(`converts "${since}" to an ISO-8601 date string`, async () => {
        (http.get as any).mockResolvedValue([]);

        await service.query({ since });

        const from = requestedParams(http).get('from');
        expect(from).toBe(expected);
        expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    }

    it('passes an already-ISO date through unchanged', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query({ since: '2026-01-15T08:30:00.000Z' });

      expect(requestedParams(http).get('from')).toBe('2026-01-15T08:30:00.000Z');
    });

    it('passes a plain calendar date through unchanged', async () => {
      (http.get as any).mockResolvedValue([]);

      await service.query({ since: '2026-01-15' });

      expect(requestedParams(http).get('from')).toBe('2026-01-15');
    });
  });

  describe('AuditLogRow → EventResult mapping', () => {
    it('maps a full row onto the published EventResult shape', async () => {
      const extracted = { tenantId: 'tenant-1', userId: 'user-1', plan: 'pro' };
      (http.get as any).mockResolvedValue([
        {
          timestamp: '2026-08-30T10:00:00.000Z',
          eventName: 'USER_CREATED',
          extracted,
          rawEventId: 'raw-1',
        },
      ]);

      const result = await service.query();

      expect(result).toEqual([
        {
          id: 'raw-1',
          type: 'USER_CREATED',
          tenantId: 'tenant-1',
          userId: 'user-1',
          data: extracted,
          createdAt: '2026-08-30T10:00:00.000Z',
        },
      ]);
    });

    it('maps every row, preserving order', async () => {
      (http.get as any).mockResolvedValue([
        {
          timestamp: '2026-08-30T10:00:00.000Z',
          eventName: 'A',
          extracted: {},
          rawEventId: 'raw-1',
        },
        {
          timestamp: '2026-08-29T10:00:00.000Z',
          eventName: 'B',
          extracted: {},
          rawEventId: 'raw-2',
        },
      ]);

      const result = await service.query();

      expect(result.map((e) => e.id)).toEqual(['raw-1', 'raw-2']);
      expect(result.map((e) => e.type)).toEqual(['A', 'B']);
    });

    it('returns undefined ids for a row with no extracted map', async () => {
      (http.get as any).mockResolvedValue([
        {
          timestamp: '2026-08-30T10:00:00.000Z',
          eventName: 'USER_CREATED',
          rawEventId: 'raw-1',
        },
      ]);

      const result = await service.query();

      expect(result).toEqual([
        {
          id: 'raw-1',
          type: 'USER_CREATED',
          tenantId: undefined,
          userId: undefined,
          data: undefined,
          createdAt: '2026-08-30T10:00:00.000Z',
        },
      ]);
    });

    it('drops non-string tenantId/userId rather than passing them through', async () => {
      const extracted = { tenantId: 42, userId: { nested: true }, plan: 'pro' };
      (http.get as any).mockResolvedValue([
        {
          timestamp: '2026-08-30T10:00:00.000Z',
          eventName: 'USER_CREATED',
          extracted,
          rawEventId: 'raw-1',
        },
      ]);

      const result = await service.query();

      expect(result[0].tenantId).toBeUndefined();
      expect(result[0].userId).toBeUndefined();
      // The raw map is still exposed verbatim under `data`.
      expect(result[0].data).toEqual(extracted);
    });

    it('returns an empty array when the API answers with nothing', async () => {
      (http.get as any).mockResolvedValue(undefined);

      await expect(service.query()).resolves.toEqual([]);
    });
  });
});
