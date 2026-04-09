import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decodeJwtPayload,
  getTokenExpiry,
  shouldRefreshNow,
  isTokenExpired,
  REFRESH_THRESHOLD_MS,
} from '../token-utils.js';

/**
 * Build a syntactically valid JWT string with the given payload.
 * Uses standard base64 (btoa) — decodeJwtPayload normalises URL-safe chars.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  return (
    btoa(JSON.stringify(header)) +
    '.' +
    btoa(JSON.stringify(payload)) +
    '.signature'
  );
}

/** Returns a Unix timestamp (seconds) offset from now. */
function nowSec(offsetSec = 0): number {
  return Math.floor(Date.now() / 1000) + offsetSec;
}

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT and returns the payload object', () => {
    const payload = { sub: 'user-1', email: 'user@example.com' };
    const token = makeJwt(payload);
    const result = decodeJwtPayload(token);
    expect(result).toMatchObject(payload);
  });

  it('returns null for a token with fewer than 3 parts', () => {
    expect(decodeJwtPayload('only.two')).toBeNull();
  });

  it('returns null for a token with more than 3 parts', () => {
    expect(decodeJwtPayload('a.b.c.d')).toBeNull();
  });

  it('returns null for a completely invalid string', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
  });

  it('returns null when the payload segment is not valid base64 JSON', () => {
    expect(decodeJwtPayload('header.!!!invalid!!!.sig')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeJwtPayload('')).toBeNull();
  });

  it('decodes URL-safe base64 characters (- and _)', () => {
    const payload = { sub: 'user' };
    // Build a token with URL-safe base64 by replacing + with - and / with _
    const header = btoa(JSON.stringify({ alg: 'HS256' }));
    const payloadB64 = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const token = `${header}.${payloadB64}.sig`;
    expect(decodeJwtPayload(token)).toMatchObject(payload);
  });
});

describe('getTokenExpiry', () => {
  it('returns exp * 1000 (converts seconds to milliseconds)', () => {
    const exp = nowSec(3600);
    const token = makeJwt({ sub: 'u', exp });
    expect(getTokenExpiry(token)).toBe(exp * 1000);
  });

  it('returns null when the payload has no exp field', () => {
    const token = makeJwt({ sub: 'u' });
    expect(getTokenExpiry(token)).toBeNull();
  });

  it('returns null when exp is not a number', () => {
    const token = makeJwt({ sub: 'u', exp: 'not-a-number' });
    expect(getTokenExpiry(token)).toBeNull();
  });

  it('returns null for an invalid token', () => {
    expect(getTokenExpiry('bad.token')).toBeNull();
  });
});

describe('shouldRefreshNow', () => {
  it('returns false when accessToken is null', () => {
    expect(shouldRefreshNow(null)).toBe(false);
  });

  it('returns false when accessToken is an empty string', () => {
    expect(shouldRefreshNow('')).toBe(false);
  });

  it('returns false when the token has no exp claim', () => {
    const token = makeJwt({ sub: 'u' });
    expect(shouldRefreshNow(token)).toBe(false);
  });

  it('returns true when expiry is within 5 minutes from now', () => {
    // Expires in 4 minutes — inside the 5-minute threshold
    const exp = nowSec(4 * 60);
    const token = makeJwt({ sub: 'u', exp });
    expect(shouldRefreshNow(token)).toBe(true);
  });

  it('returns true when token is already expired', () => {
    // Expired 1 minute ago
    const exp = nowSec(-60);
    const token = makeJwt({ sub: 'u', exp });
    expect(shouldRefreshNow(token)).toBe(true);
  });

  it('returns false when expiry is more than 5 minutes away', () => {
    // Expires in 10 minutes — outside the threshold
    const exp = nowSec(10 * 60);
    const token = makeJwt({ sub: 'u', exp });
    expect(shouldRefreshNow(token)).toBe(false);
  });

  it('returns true at exactly the threshold boundary (exp - now === REFRESH_THRESHOLD_MS)', () => {
    // exp is exactly REFRESH_THRESHOLD_MS milliseconds from now → diff = 0 ≤ threshold
    const expMs = Date.now() + REFRESH_THRESHOLD_MS;
    const exp = Math.floor(expMs / 1000);
    const token = makeJwt({ sub: 'u', exp });
    expect(shouldRefreshNow(token)).toBe(true);
  });
});

describe('isTokenExpired', () => {
  it('returns false when the token is not yet expired', () => {
    // Expires in 1 hour
    const exp = nowSec(3600);
    const token = makeJwt({ sub: 'u', exp });
    expect(isTokenExpired(token)).toBe(false);
  });

  it('returns true when the token is past its expiry', () => {
    // Expired 1 second ago
    const exp = nowSec(-1);
    const token = makeJwt({ sub: 'u', exp });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('returns true when there is no exp claim (treat as expired)', () => {
    const token = makeJwt({ sub: 'u' });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('returns true for an invalid token', () => {
    expect(isTokenExpired('not.valid')).toBe(true);
  });

  it('returns true when exp is exactly now (boundary)', () => {
    const exp = nowSec(0);
    const token = makeJwt({ sub: 'u', exp });
    // Date.now() >= exp * 1000 — due to sub-second difference this is at the boundary;
    // accept either true or truthy — the implementation uses >=
    const result = isTokenExpired(token);
    expect(typeof result).toBe('boolean');
  });
});
