import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpFetch } from '../http.js';
import { HttpError } from '../errors.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/**
 * Build a minimal Response-like object that `httpFetch` uses:
 * ok, status, statusText, json(), text().
 */
function makeResponse(opts: {
  ok: boolean;
  status: number;
  statusText?: string;
  jsonBody?: unknown;
  textBody?: string;
  jsonThrows?: boolean;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.statusText ?? '',
    json: opts.jsonThrows
      ? vi.fn().mockRejectedValue(new SyntaxError('invalid json'))
      : vi.fn().mockResolvedValue(opts.jsonBody ?? {}),
    text: vi.fn().mockResolvedValue(opts.textBody ?? (opts.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : '')),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('httpFetch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset fetch global before each test
    (globalThis as any).fetch = undefined;
  });

  describe('successful responses', () => {
    it('returns parsed JSON from a successful response', async () => {
      const data = { id: 1, name: 'Alice' };
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: data }));

      const result = await httpFetch<typeof data>('https://api.example.com/data', {}, noopLogger);
      expect(result).toEqual(data);
    });

    it('sends Content-Type: application/json header by default', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', {}, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.headers).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('merges caller-provided headers with Content-Type', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', {
        headers: { Authorization: 'Bearer tok' },
      }, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      });
    });

    it('caller-provided headers can override Content-Type', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', {
        headers: { 'Content-Type': 'text/plain' },
      }, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.headers['Content-Type']).toBe('text/plain');
    });

    it('uses GET as the default HTTP method', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', {}, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.method).toBe('GET');
    });

    it('uses the provided HTTP method', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', { method: 'POST' }, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.method).toBe('POST');
    });

    it('serialises the body to JSON when provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));
      const payload = { username: 'alice', password: 's3cr3t' };

      await httpFetch('https://api.example.com/login', { method: 'POST', body: payload }, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.body).toBe(JSON.stringify(payload));
    });

    it('does not include a body property when body is undefined', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', {}, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.body).toBeUndefined();
    });

    it('passes credentials when provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', { credentials: 'include' }, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.credentials).toBe('include');
    });

    it('does not set credentials when not provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/data', {}, noopLogger);

      const [, fetchInit] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchInit.credentials).toBeUndefined();
    });

    it('calls the correct URL', async () => {
      const url = 'https://api.example.com/v1/resource';
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch(url, {}, noopLogger);

      const [calledUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledUrl).toBe(url);
    });
  });

  describe('error responses', () => {
    it('throws HttpError when the response is not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 404, statusText: 'Not Found', jsonBody: {} }),
      );

      await expect(httpFetch('https://api.example.com/missing', {}, noopLogger)).rejects.toBeInstanceOf(HttpError);
    });

    it('thrown HttpError has the correct HTTP status code', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 401, statusText: 'Unauthorized', jsonBody: {} }),
      );

      await expect(httpFetch('https://api.example.com/secure', {}, noopLogger)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('thrown HttpError.code is HTTP_{status}', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 403, statusText: 'Forbidden', jsonBody: {} }),
      );

      await expect(httpFetch('https://api.example.com/admin', {}, noopLogger)).rejects.toMatchObject({
        code: 'HTTP_403',
      });
    });

    it('uses the message field from the error body when present', async () => {
      const errorBody = { message: 'Token has expired', code: 'TOKEN_EXPIRED' };
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 401, statusText: 'Unauthorized', jsonBody: errorBody }),
      );

      await expect(httpFetch('https://api.example.com/data', {}, noopLogger)).rejects.toMatchObject({
        message: 'Token has expired',
      });
    });

    it('falls back to "HTTP {status}: {statusText}" when body has no message field', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 500, statusText: 'Internal Server Error', jsonBody: { detail: 'oops' } }),
      );

      await expect(httpFetch('https://api.example.com/data', {}, noopLogger)).rejects.toMatchObject({
        message: 'HTTP 500: Internal Server Error',
      });
    });

    it('falls back to "HTTP {status}: {statusText}" when body is a plain string', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 503, statusText: 'Service Unavailable', jsonBody: 'down for maintenance' }),
      );

      await expect(httpFetch('https://api.example.com/data', {}, noopLogger)).rejects.toMatchObject({
        message: 'HTTP 503: Service Unavailable',
      });
    });

    it('attaches the parsed error body to the thrown HttpError', async () => {
      const errorBody = { message: 'Not Found', resource: '/missing' };
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({ ok: false, status: 404, statusText: 'Not Found', jsonBody: errorBody }),
      );

      await expect(httpFetch('https://api.example.com/missing', {}, noopLogger)).rejects.toMatchObject({
        body: errorBody,
      });
    });

    it('falls back to text body when JSON parsing fails', async () => {
      const resp = {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
        text: vi.fn().mockResolvedValue('upstream timeout'),
      } as unknown as Response;
      globalThis.fetch = vi.fn().mockResolvedValue(resp);

      await expect(httpFetch('https://api.example.com/data', {}, noopLogger)).rejects.toMatchObject({
        status: 502,
        body: 'upstream timeout',
      });
    });
  });

  describe('logger integration', () => {
    it('calls logger.debug with method and URL before the request', async () => {
      const debugSpy = vi.fn();
      const logger: Logger = { debug: debugSpy, warn: vi.fn(), error: vi.fn() };
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, jsonBody: {} }));

      await httpFetch('https://api.example.com/path', { method: 'POST' }, logger);

      expect(debugSpy).toHaveBeenCalledWith('POST https://api.example.com/path');
    });
  });
});
