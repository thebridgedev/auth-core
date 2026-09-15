// TBP-669 — Bridge refuses sign-in from an origin missing from the app's
// allowed origins with `403 {"message":"Origin not allowed"}`. The SDK used to
// pass that through as a bare "Origin not allowed", and a magic-link sign-in
// hung on "Signing in…" because the failed token exchange left the auth state
// at `credentials-validated`. These tests pin both halves: the error names the
// origin and the fix, and a failed exchange ends the sign-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetOriginNotAllowedReports, httpFetch } from '../http.js';
import {
  ALLOWED_ORIGINS_ADMIN_PATH,
  HttpError,
  ORIGIN_NOT_ALLOWED_DOCS_URL,
  OriginNotAllowedError,
  isOriginNotAllowedError,
} from '../errors.js';
import { BridgeAuth } from '../bridge-auth.js';
import { MemoryAdapter } from '../token-storage.js';
import { en, LOCALES } from '../i18n/messages.js';
import type { Logger } from '../logger.js';

const ORIGIN = 'http://localhost:5181';
const ORIGIN_403 = { message: 'Origin not allowed', error: 'Forbidden', statusCode: 403 };

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mkLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  _resetOriginNotAllowedReports();
  vi.stubGlobal('location', { origin: ORIGIN });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpFetch — origin not in the allowlist', () => {
  it('throws OriginNotAllowedError naming the origin and where to add it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(403, ORIGIN_403)));
    const err = await httpFetch('https://api.test/auth/token/direct', { method: 'POST' }, mkLogger()).catch((e) => e);

    expect(err).toBeInstanceOf(OriginNotAllowedError);
    expect(err).toBeInstanceOf(HttpError); // status checks keep working
    expect(isOriginNotAllowedError(err)).toBe(true);
    expect(err).toMatchObject({ status: 403, code: 'ORIGIN_NOT_ALLOWED', origin: ORIGIN });
    expect(err.message).toBe(
      `This app's allowed origins in Bridge don't include ${ORIGIN} — add it in Bridge admin under ${ALLOWED_ORIGINS_ADMIN_PATH}.`,
    );
  });

  it('logs one console line with the fix and a docs link, once per origin', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(403, ORIGIN_403)));
    const logger = mkLogger();
    await httpFetch('https://api.test/auth/token/direct', {}, logger).catch(() => {});
    await httpFetch('https://api.test/auth/authenticate', {}, logger).catch(() => {});

    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(logger.error.mock.calls[0][0]);
    expect(line).not.toContain('\n');
    expect(line).toContain('/auth/token/direct');
    expect(line).toContain(ORIGIN);
    expect(line).toContain(ALLOWED_ORIGINS_ADMIN_PATH);
    expect(line).toContain(ORIGIN_NOT_ALLOWED_DOCS_URL);
  });

  it('leaves every other 403 alone — its own message, HTTP_403, no console line', async () => {
    const logger = mkLogger();
    for (const body of [{ message: 'User is disabled' }, { message: 'Forbidden resource' }, {}]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(403, body)));
      const err = await httpFetch('https://api.test/auth/authenticate', {}, logger).catch((e) => e);
      expect(isOriginNotAllowedError(err)).toBe(false);
      expect(err).toMatchObject({ status: 403, code: 'HTTP_403' });
      if ('message' in body) expect(err.message).toBe(body.message);
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not mistake a 401 with the same words for the allowlist refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { message: 'Origin not allowed' })));
    const err = await httpFetch('https://api.test/x', {}, mkLogger()).catch((e) => e);
    expect(isOriginNotAllowedError(err)).toBe(false);
    expect(err).toMatchObject({ status: 401, code: 'HTTP_401' });
  });
});

describe('BridgeAuth — a failed token exchange ends the sign-in', () => {
  const singleTenant = {
    session: 'sess1',
    expires: 3600,
    mfaState: 'DISABLED',
    tenantUsers: [{ id: 'tu1', username: 'u', fullName: 'U', tenant: { id: 't1', name: 'T', logo: '' } }],
  };

  function mkAuth() {
    return new BridgeAuth({
      appId: 'test-app',
      apiBaseUrl: 'https://api.test',
      hostedUrl: 'https://hosted.test',
      callbackUrl: 'https://app.test/callback',
      storage: new MemoryAdapter(),
      debug: false,
    });
  }

  /** First call (credentials / magic link / passkey) succeeds; the exchange (`token/direct`) is refused. */
  function refuseExchange() {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/token/direct') ? respond(403, ORIGIN_403) : respond(200, singleTenant),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const flows: Array<[string, (a: BridgeAuth) => Promise<unknown>]> = [
    ['magic link', (a) => a.authenticateWithMagicLinkToken('magic-token')],
    ['password', (a) => a.authenticate('user@test.com', 'pw')],
    ['passkey', (a) => a.authenticateWithPasskey({ id: 'cred' })],
  ];

  for (const [name, signIn] of flows) {
    it(`${name}: rejects with the origin error and returns to unauthenticated`, async () => {
      const fetchMock = refuseExchange();
      const auth = mkAuth();
      const states: string[] = [];
      auth.on('auth:state-change', (s) => states.push(s as string));

      const err = await signIn(auth).catch((e) => e);

      expect(fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname)).toContain('/auth/token/direct');
      expect(isOriginNotAllowedError(err)).toBe(true);
      // The regression: the state stayed at credentials-validated, which a
      // state-driven form renders as "Signing in…" forever.
      expect(auth.getAuthState()).toBe('unauthenticated');
      expect(states).toContain('credentials-validated');
      expect(states[states.length - 1]).toBe('unauthenticated');
      expect(auth.isAuthenticated()).toBe(false);
      auth.destroy();
    });
  }

  it('a successful exchange is unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/token/direct')
          ? respond(200, { access_token: 'at', refresh_token: 'rt', id_token: 'idt' })
          : respond(200, singleTenant),
      ),
    );
    const auth = mkAuth();
    await auth.authenticateWithMagicLinkToken('magic-token');
    expect(auth.getAuthState()).toBe('authenticated');
    auth.destroy();
  });
});

describe('i18n — error.originNotAllowed', () => {
  it('exists in every locale and keeps the {origin} placeholder', () => {
    expect(en['error.originNotAllowed']).toContain(ALLOWED_ORIGINS_ADMIN_PATH);
    for (const [name, catalogue] of Object.entries(LOCALES)) {
      expect(catalogue['error.originNotAllowed'], name).toContain('{origin}');
      // The admin UI is English — the path must match what the admin sees.
      expect(catalogue['error.originNotAllowed'], name).toContain(ALLOWED_ORIGINS_ADMIN_PATH);
    }
  });
});
