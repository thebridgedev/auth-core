import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BridgeError, errorFromAnswer, parseRetryAfter, waitMinutes } from '../../core/errors.js';
import { LOCALES } from '../../i18n/messages.js';
import { call, platformFetch, withoutRedirects } from '../../core/http.js';
import { fillPath } from '../../core/routes.js';
import { localStorageAdapter, memoryStorage, readJson, storageKey } from '../../core/storage.js';
import { Emitter, Store, createPkce, isS256Challenge, pkceChallenge, readJwtPayload } from '../../core/util.js';

const headers = (values: Record<string, string>) => new Headers(values);

describe('errors: one BridgeError for both answer shapes', () => {
  it.each([
    ['wrong_credentials', 400, 'wrong-credentials'],
    ['wrong_device', 400, 'wrong-device'],
    ['invalid_link', 400, 'link-invalid'],
    ['flow_expired', 400, 'flow-expired'],
    ['invalid_grant', 400, 'signed-out'],
    ['temporarily_unavailable', 503, 'unavailable'],
    ['invalid_client', 400, 'misconfigured'],
    ['access_denied', 403, 'forbidden'],
  ])('reads the OAuth error %s as %s', (code, status, kind) => {
    const error = errorFromAnswer(status, { error: code });
    expect(error).toBeInstanceOf(BridgeError);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
  });

  it('keeps the reason of a refused sign-in as its code', () => {
    const error = errorFromAnswer(403, { error: 'access_denied', reason: 'user_suspended' });
    expect(error.kind).toBe('forbidden');
    expect(error.code).toBe('user_suspended');
  });

  it('reads a workspace that needs another sign-in step as unsupported-step, naming the step', () => {
    const error = errorFromAnswer(403, { error: 'insufficient_user_authentication', needs: 'second_step' });
    expect(error.kind).toBe('unsupported-step');
    expect(error.step).toBe('second_step');
  });

  it.each([
    [400, 'bad-request', 'invalid'],
    [401, 'credential-refused', 'signed-out'],
    [401, 'identity-recheck', 'reauthenticate'],
    [402, 'entitlement-missing', 'plan-required'],
    [403, 'privilege-missing', 'forbidden'],
    [403, 'origin-not-allowed', 'origin-not-allowed'],
    [404, 'not-found', 'not-found'],
    [409, 'conflict', 'conflict'],
    [422, 'idempotency-key-reused', 'conflict'],
    [429, 'rate-limited', 'rate-limited'],
    [503, 'unavailable', 'unavailable'],
  ])('reads a %i %s problem as %s', (status, kind, expected) => {
    const error = errorFromAnswer(status, { type: `urn:bridge:problem:${kind}`, title: kind, status, detail: 'Why.' });
    expect(error.kind).toBe(expected);
    expect(error.code).toBe(kind);
    expect(error.message).toBe('Why.');
    expect(error.problem?.status).toBe(status);
  });

  it('names the missing plan feature of a 402', () => {
    const error = errorFromAnswer(402, { type: 'urn:bridge:problem:entitlement-missing', title: 'x', status: 402, entitlement: 'reports' });
    expect(error.entitlement).toBe('reports');
  });

  it('reads a fresh-sign-in challenge from WWW-Authenticate', () => {
    const error = errorFromAnswer(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, headers({ 'www-authenticate': 'Bearer realm="bridge", error="insufficient_user_authentication", max_age=300' }));
    expect(error.kind).toBe('reauthenticate');
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(errorFromAnswer(429, {}, headers({ 'retry-after': '7' })).retryAfterSeconds).toBe(7);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('reads sign-in protection: paused with the minutes to wait, or locked, the same for every email', () => {
    const paused = errorFromAnswer(429, { error: 'too_many_attempts', error_description: 'Too many attempts. Try again in 12 minutes.', retry_after: 701 }, headers({ 'retry-after': '701' }));
    expect(paused).toMatchObject({ kind: 'rate-limited', code: 'too_many_attempts', retryAfterSeconds: 701, message: 'Too many attempts. Try again in 12 minutes.' });
    expect(waitMinutes(paused)).toBe(12);
    expect(waitMinutes(errorFromAnswer(429, { error: 'too_many_attempts' }, headers({ 'retry-after': '5' })))).toBe(1);
    const locked = errorFromAnswer(429, { error: 'account_locked', error_description: 'Locked.' });
    expect(locked).toMatchObject({ kind: 'rate-limited', code: 'account_locked', retryAfterSeconds: null });
    expect(waitMinutes(locked)).toBeNull();
    expect(waitMinutes(new Error('x'))).toBeNull();
  });

  it('says a wait of 1 minute in the singular, in every language', () => {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      expect(messages['login.error.tooManyAttempts'], locale).toContain('{minutes}');
      expect(messages['login.error.tooManyAttemptsOneMinute'], locale).not.toContain('{minutes}');
    }
    expect(LOCALES['en']?.['login.error.tooManyAttemptsOneMinute']).toBe('Too many attempts. Try again in 1 minute.');
  });

  it('gives a 404 that carries nothing the not-found kind', () => {
    expect(errorFromAnswer(404, { type: 'about:blank', title: 'Not Found', status: 404 }).kind).toBe('not-found');
  });

  it('treats any 5xx as unavailable, never as a yes', () => {
    expect(errorFromAnswer(500, 'oops').kind).toBe('unavailable');
    expect(errorFromAnswer(502, undefined).kind).toBe('unavailable');
  });
});

describe('http', () => {
  it('sends the token only in the Authorization header, and JSON bodies', async () => {
    const seen: Request[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const answer = await call<{ ok: boolean }>(fetchFn, 'https://bridge.test/v2/accounts/me', { method: 'PATCH', token: 'tok', body: { firstName: 'A' } });
    expect(answer.body.ok).toBe(true);
    const request = seen[0] as Request;
    expect(request.headers.get('authorization')).toBe('Bearer tok');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.url).not.toContain('tok');
    expect(await request.text()).toBe('{"firstName":"A"}');
  });

  it('sends the app key only as x-api-key', async () => {
    let sent: Headers | undefined;
    const fetchFn = (async (_: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await call(fetchFn, 'https://bridge.test/v2/billing/usage', { method: 'POST', apiKey: 'key-1', body: {} });
    expect(sent?.get('x-api-key')).toBe('key-1');
    expect(sent?.get('authorization')).toBeNull();
  });

  it('revalidates with If-None-Match and reads a 304 as not modified', async () => {
    let sent: Headers | undefined;
    const fetchFn = (async (_: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(null, { status: 304, headers: { etag: '"r1"' } });
    }) as typeof fetch;
    const answer = await call(fetchFn, 'https://bridge.test/x', { method: 'POST', etag: '"r1"', body: {} });
    expect(sent?.get('if-none-match')).toBe('"r1"');
    expect(answer.notModified).toBe(true);
    expect(answer.etag).toBe('"r1"');
  });

  it('turns a failed fetch into a network error', async () => {
    const fetchFn = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    await expect(call(fetchFn, 'https://bridge.test/v2/accounts/me', { method: 'GET' })).rejects.toMatchObject({ kind: 'network', status: 0 });
  });

  it('throws the refusal as a BridgeError', async () => {
    const fetchFn = (async () => Response.json({ error: 'wrong_credentials' }, { status: 400 })) as typeof fetch;
    await expect(call(fetchFn, 'https://bridge.test/x', { method: 'POST', body: {} })).rejects.toMatchObject({ kind: 'wrong-credentials' });
  });

  it('never follows a redirect, so a token or key never reaches an address Bridge did not give', async () => {
    let init: RequestInit | undefined;
    const fetchFn = (async (_: RequestInfo | URL, given?: RequestInit) => {
      init = given;
      return new Response(null, { status: 307, headers: { location: 'https://evil.test/' } });
    }) as typeof fetch;
    await expect(call(fetchFn, 'https://bridge.test/v2/billing/usage', { method: 'POST', apiKey: 'k', body: {} })).rejects.toMatchObject({ kind: 'misconfigured', status: 307 });
    expect(init?.redirect).toBe('manual');
    const guarded = withoutRedirects(fetchFn);
    await expect(guarded('https://bridge.test/jwks.json')).rejects.toThrow(/redirect/);
  });

  it('binds the platform fetch so it can be stored and called as a method', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response('{}'));
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const holder = { fetchFn: platformFetch() };
      await holder.fetchFn('https://bridge.test/');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('routes', () => {
  it('fills and encodes parameters, and refuses a missing one', () => {
    expect(fillPath('/members/{memberId}', { memberId: 'a/b' })).toBe('/members/a%2Fb');
    expect(() => fillPath('/members/{memberId}', {})).toThrow(/memberId/);
  });
});

describe('PKCE (S256, RFC 7636)', () => {
  it('makes a 43-character verifier and its SHA-256 challenge', async () => {
    const pair = await createPkce();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isS256Challenge(pair.challenge)).toBe(true);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
  });

  it('gives a fixed verifier its fixed challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mJ92K9qJGmFfKxkKwMXTd7F3U9l2IA')).toBe('4Yopt6oJ5aVoNLToDPj3zp0FVXVcmG_D0u9dfIWcyrA');
  });

  it('makes a different pair every time', async () => {
    const [a, b] = await Promise.all([createPkce(), createPkce()]);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('util', () => {
  it('reads a JWT payload and refuses anything else', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', email: 'é@x.test' })).toString('base64url');
    expect(readJwtPayload(`e30.${payload}.sig`)).toEqual({ sub: 'u1', email: 'é@x.test' });
    expect(readJwtPayload('not-a-jwt')).toBeNull();
    expect(readJwtPayload(`e30.${Buffer.from('[1]').toString('base64url')}.s`)).toBeNull();
    expect(readJwtPayload(null)).toBeNull();
  });

  it('keeps calling listeners when one throws, and reports it', () => {
    const emitter = new Emitter<{ [name: string]: unknown; ping: number; error: unknown }>();
    const errors: unknown[] = [];
    const heard: number[] = [];
    emitter.on('error', (error) => errors.push(error));
    emitter.on('ping', () => {
      throw new Error('boom');
    });
    emitter.on('ping', (value) => heard.push(value));
    emitter.emit('ping', 1);
    expect(heard).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it('tells a store subscriber the value now and on every change', () => {
    const store = new Store(1);
    const seen: number[] = [];
    const stop = store.subscribe((value) => seen.push(value));
    store.set(2);
    stop();
    store.set(3);
    expect(seen).toEqual([1, 2]);
  });
});

describe('storage', () => {
  it('keys everything by issuer, so two apps on one origin never share a session', () => {
    expect(storageKey('https://a.test/identity-access/apps/one/', 'session')).toBe('bridge:https://a.test/identity-access/apps/one:session');
    expect(storageKey('https://a.test/identity-access/apps/one', 'session')).not.toBe(storageKey('https://a.test/identity-access/apps/two', 'session'));
  });

  it('drops a stored value that is not JSON', async () => {
    const storage = memoryStorage();
    await storage.set('k', '{nope');
    expect(await readJson(storage, 'k')).toBeNull();
    expect(await storage.get('k')).toBeNull();
  });

  it('acts as empty where localStorage is missing or throws', () => {
    const adapter = localStorageAdapter();
    expect(adapter.get('x')).toBeNull();
    expect(() => adapter.set('x', 'y')).not.toThrow();
  });
});
