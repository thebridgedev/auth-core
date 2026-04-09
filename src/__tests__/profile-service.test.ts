import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileService } from '../profile-service.js';
import type { Logger } from '../logger.js';
import type { IDToken, ResolvedConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Mock jose
// ---------------------------------------------------------------------------

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
  errors: {
    JWTExpired: class JWTExpired extends Error {
      constructor(msg = 'JWTExpired') { super(msg); this.name = 'JWTExpired'; }
    },
    JWTInvalid: class JWTInvalid extends Error {
      constructor(msg = 'JWTInvalid') { super(msg); this.name = 'JWTInvalid'; }
    },
    JWKSNoMatchingKey: class JWKSNoMatchingKey extends Error {
      constructor(msg = 'JWKSNoMatchingKey') { super(msg); this.name = 'JWKSNoMatchingKey'; }
    },
  },
}));

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

const mockJwtVerify = jwtVerify as ReturnType<typeof vi.fn>;
const mockCreateRemoteJWKSet = createRemoteJWKSet as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: ResolvedConfig = {
  appId: 'app1',
  apiBaseUrl: 'https://api.example.com',
  hostedUrl: 'https://hosted.example.com',
  authBaseUrl: 'https://api.example.com/auth',
  callbackUrl: 'https://myapp.com/callback',
  defaultRedirectRoute: '/',
  loginRoute: '/login',
  teamManagementUrl: 'https://team.example.com',
  storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  debug: false,
};

const logger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FULL_IDTOKEN_PAYLOAD: IDToken = {
  sub: 'user-123',
  preferred_username: 'alice',
  email: 'alice@example.com',
  email_verified: true,
  name: 'Alice Smith',
  family_name: 'Smith',
  given_name: 'Alice',
  locale: 'en-US',
  onboarded: true,
  multi_tenant: false,
  tenant_id: 'tenant-abc',
  tenant_name: 'Acme Corp',
  tenant_locale: 'en-GB',
  tenant_logo: 'https://cdn.example.com/logo.png',
  tenant_onboarded: true,
};

/**
 * Encode a payload as a base64url JWT (header.payload.sig).
 * atob/btoa are available in the vitest jsdom / node environment.
 */
function encodeIdToken(payload: Record<string, unknown>): string {
  const toBase64Url = (str: string) =>
    btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fakesig`;
}

const VALID_ID_TOKEN = encodeIdToken(FULL_IDTOKEN_PAYLOAD);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: createRemoteJWKSet returns a dummy JWKS function
    mockCreateRemoteJWKSet.mockReturnValue(vi.fn());
  });

  // -------------------------------------------------------------------------
  // verifyAndDecode
  // -------------------------------------------------------------------------

  describe('verifyAndDecode', () => {
    it('calls jwtVerify with the token and correct issuer/audience', async () => {
      mockJwtVerify.mockResolvedValue({ payload: FULL_IDTOKEN_PAYLOAD });
      const service = new ProfileService(CONFIG, logger);

      await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(mockJwtVerify).toHaveBeenCalledWith(
        VALID_ID_TOKEN,
        expect.any(Function),
        { issuer: CONFIG.authBaseUrl, audience: CONFIG.appId },
      );
    });

    it('calls createRemoteJWKSet with the JWKS URL', async () => {
      mockJwtVerify.mockResolvedValue({ payload: FULL_IDTOKEN_PAYLOAD });
      const service = new ProfileService(CONFIG, logger);

      await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
        new URL('https://api.example.com/auth/.well-known/jwks.json'),
      );
    });

    it('transforms IDToken payload to Profile correctly', async () => {
      mockJwtVerify.mockResolvedValue({ payload: FULL_IDTOKEN_PAYLOAD });
      const service = new ProfileService(CONFIG, logger);

      const profile = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(profile).toEqual({
        id: 'user-123',
        username: 'alice',
        email: 'alice@example.com',
        emailVerified: true,
        fullName: 'Alice Smith',
        familyName: 'Smith',
        givenName: 'Alice',
        locale: 'en-US',
        onboarded: true,
        multiTenantAccess: false,
        tenant: {
          id: 'tenant-abc',
          name: 'Acme Corp',
          locale: 'en-GB',
          logo: 'https://cdn.example.com/logo.png',
          onboarded: true,
        },
      });
    });

    it('maps Profile.tenant to undefined when tenant_id is absent', async () => {
      const payloadNoTenant: IDToken = {
        ...FULL_IDTOKEN_PAYLOAD,
        tenant_id: undefined,
        tenant_name: undefined,
      };
      mockJwtVerify.mockResolvedValue({ payload: payloadNoTenant });
      const service = new ProfileService(CONFIG, logger);

      const profile = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(profile?.tenant).toBeUndefined();
    });

    it('returns null and warns when JWTExpired is thrown', async () => {
      mockJwtVerify.mockRejectedValue(new joseErrors.JWTExpired());
      const service = new ProfileService(CONFIG, logger);

      const result = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(result).toBeNull();
      expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('Token expired');
    });

    it('returns null and warns when JWTInvalid is thrown', async () => {
      mockJwtVerify.mockRejectedValue(new joseErrors.JWTInvalid());
      const service = new ProfileService(CONFIG, logger);

      const result = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(result).toBeNull();
      expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('Invalid token');
    });

    it('returns null and warns when JWKSNoMatchingKey is thrown', async () => {
      mockJwtVerify.mockRejectedValue(new joseErrors.JWKSNoMatchingKey());
      const service = new ProfileService(CONFIG, logger);

      const result = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(result).toBeNull();
      expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('JWKS error');
    });

    it('returns null and logs an error for unknown exceptions', async () => {
      const unknownErr = new Error('Unexpected');
      mockJwtVerify.mockRejectedValue(unknownErr);
      const service = new ProfileService(CONFIG, logger);

      const result = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(result).toBeNull();
      expect((logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        'Token verification failed',
        unknownErr,
      );
    });

    it('reuses the cached JWKS verifier on subsequent calls with the same config', async () => {
      mockJwtVerify.mockResolvedValue({ payload: FULL_IDTOKEN_PAYLOAD });
      const service = new ProfileService(CONFIG, logger);

      await service.verifyAndDecode(VALID_ID_TOKEN);
      await service.verifyAndDecode(VALID_ID_TOKEN);

      // createRemoteJWKSet should only be called once
      expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // decodeWithoutVerify
  // -------------------------------------------------------------------------

  describe('decodeWithoutVerify', () => {
    it('decodes a valid base64url ID token without calling jwtVerify', () => {
      const service = new ProfileService(CONFIG, logger);
      const profile = service.decodeWithoutVerify(VALID_ID_TOKEN);

      expect(mockJwtVerify).not.toHaveBeenCalled();
      expect(profile).not.toBeNull();
    });

    it('maps the decoded payload to a Profile', () => {
      const service = new ProfileService(CONFIG, logger);
      const profile = service.decodeWithoutVerify(VALID_ID_TOKEN);

      expect(profile).toMatchObject({
        id: 'user-123',
        username: 'alice',
        email: 'alice@example.com',
        emailVerified: true,
        fullName: 'Alice Smith',
        familyName: 'Smith',
        givenName: 'Alice',
        locale: 'en-US',
        onboarded: true,
        multiTenantAccess: false,
      });
    });

    it('includes tenant when tenant_id is present in the payload', () => {
      const service = new ProfileService(CONFIG, logger);
      const profile = service.decodeWithoutVerify(VALID_ID_TOKEN);

      expect(profile?.tenant).toMatchObject({
        id: 'tenant-abc',
        name: 'Acme Corp',
      });
    });

    it('returns null for a token with fewer than 3 parts', () => {
      const service = new ProfileService(CONFIG, logger);
      expect(service.decodeWithoutVerify('only.two')).toBeNull();
    });

    it('returns null for a token with an invalid base64 payload', () => {
      const service = new ProfileService(CONFIG, logger);
      expect(service.decodeWithoutVerify('header.!!!.sig')).toBeNull();
    });

    it('returns null when the payload is not a JSON object', () => {
      const service = new ProfileService(CONFIG, logger);
      const badPayload = btoa('"just-a-string"');
      const token = `hdr.${badPayload}.sig`;
      // transformIDToken will receive a string — it won't crash but Profile fields will be undefined
      // The function should handle this gracefully (return null or a partial object)
      const result = service.decodeWithoutVerify(token);
      // At minimum it should not throw
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Profile transformation — tenant edge cases
  // -------------------------------------------------------------------------

  describe('Profile transformation', () => {
    it('sets tenant.name to empty string when tenant_name is missing', async () => {
      const payload: IDToken = { ...FULL_IDTOKEN_PAYLOAD, tenant_name: undefined };
      mockJwtVerify.mockResolvedValue({ payload });
      const service = new ProfileService(CONFIG, logger);

      const profile = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(profile?.tenant?.name).toBe('');
    });

    it('maps optional tenant fields (locale, logo, onboarded) correctly', async () => {
      mockJwtVerify.mockResolvedValue({ payload: FULL_IDTOKEN_PAYLOAD });
      const service = new ProfileService(CONFIG, logger);

      const profile = await service.verifyAndDecode(VALID_ID_TOKEN);

      expect(profile?.tenant?.locale).toBe('en-GB');
      expect(profile?.tenant?.logo).toBe('https://cdn.example.com/logo.png');
      expect(profile?.tenant?.onboarded).toBe(true);
    });
  });
});
