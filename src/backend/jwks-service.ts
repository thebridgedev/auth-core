import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JwtClaims, ApiTokenClaims } from './types.js';

/**
 * Optional logger. Defaults to a no-op so the service is silent unless a
 * consumer wires one in (e.g. NestJS forwards `BridgeConfigService.log`).
 */
export type JwksLogger = (message: string, ...args: unknown[]) => void;

/**
 * Construction config for the framework-agnostic JwksService.
 *
 * Everything the verification logic needs is injected — there is no hardcoded
 * URL, issuer, audience, or TTL. Framework wrappers (NestJS, etc.) construct
 * this from their own config service.
 */
export interface JwksServiceConfig {
  /** JWKS endpoint for user-token verification. */
  jwksUrl: string;
  /** JWKS endpoint for API-token verification (cached independently). */
  apiTokenJwksUrl: string;
  /** Expected `iss` for user tokens. */
  issuer: string;
  /** Expected `aud` for user tokens (typically the appId). */
  audience: string;
  /** How long a remote JWKS client is reused before it is re-created. @default 3600000 (1h) */
  cacheTtlMs?: number;
  /** Optional debug logger. @default no-op */
  log?: JwksLogger;
}

/**
 * Error thrown on token verification failure.
 *
 * `code` is a stable, framework-agnostic discriminator:
 * `TOKEN_EXPIRED` | `TOKEN_INVALID` | `JWKS_NO_MATCH` | `CLAIM_VALIDATION_FAILED`
 * | `APP_MISMATCH` | `UNKNOWN_ERROR`.
 */
export class TokenVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Framework-agnostic, Node-only JWKS-based JWT verification.
 *
 * Covers BOTH the user-token path (issuer/audience validated) and the
 * API-token path (type + appId validated). The two JWKS clients are cached
 * independently with the same TTL behavior.
 *
 * This is a plain class — NOT a DI provider. Framework plugins wrap it.
 */
export class JwksService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksInitTime = 0;

  private apiTokenJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private apiTokenJwksInitTime = 0;

  private readonly cacheTtlMs: number;
  private readonly log: JwksLogger;

  constructor(private readonly config: JwksServiceConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.log = config.log ?? (() => {});
  }

  /**
   * Initialize or refresh the user-token JWKS client.
   */
  private ensureJwks(): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();

    if (!this.jwks || now - this.jwksInitTime > this.cacheTtlMs) {
      this.log('Initializing JWKS client', { url: this.config.jwksUrl });
      this.jwks = createRemoteJWKSet(new URL(this.config.jwksUrl));
      this.jwksInitTime = now;
    }

    return this.jwks;
  }

  /**
   * Initialize or refresh the API-token JWKS client (cached independently).
   */
  private ensureApiTokenJwks(): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();

    if (!this.apiTokenJwks || now - this.apiTokenJwksInitTime > this.cacheTtlMs) {
      this.log('Initializing API token JWKS client', { url: this.config.apiTokenJwksUrl });
      this.apiTokenJwks = createRemoteJWKSet(new URL(this.config.apiTokenJwksUrl));
      this.apiTokenJwksInitTime = now;
    }

    return this.apiTokenJwks;
  }

  /**
   * Verify a user JWT and return its claims.
   *
   * @throws {TokenVerificationError} if the token is invalid or expired.
   */
  async verifyToken(token: string): Promise<JwtClaims> {
    const jwks = this.ensureJwks();

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });

      this.log('Token verified successfully', {
        sub: payload.sub,
        iss: payload.iss,
        aud: payload.aud,
      });

      return payload as JwtClaims;
    } catch (error) {
      throw this.mapVerificationError(error, 'Token');
    }
  }

  /**
   * Verify a Bridge API token JWT and return its claims.
   *
   * Uses a separate JWKS client (cached independently from the user-token
   * client). Validates `type === 'api'` and `appId === expectedAppId`.
   *
   * @throws {TokenVerificationError} if the token is invalid, expired, the
   *   wrong type, or issued for a different app.
   */
  async verifyApiToken(token: string, expectedAppId: string): Promise<ApiTokenClaims> {
    const jwks = this.ensureApiTokenJwks();

    try {
      const { payload } = await jwtVerify(token, jwks);

      if (payload['type'] !== 'api') {
        throw new TokenVerificationError('Wrong token type', 'TOKEN_INVALID');
      }

      if (payload['appId'] !== expectedAppId) {
        throw new TokenVerificationError('Token issued for a different app', 'APP_MISMATCH');
      }

      this.log('API token verified successfully', {
        sub: payload.sub,
        appId: payload['appId'],
      });

      return payload as unknown as ApiTokenClaims;
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        throw error;
      }
      throw this.mapVerificationError(error, 'API token');
    }
  }

  /**
   * Map a jose verification error to a stable TokenVerificationError.
   */
  private mapVerificationError(error: unknown, label: string): TokenVerificationError {
    if (error instanceof joseErrors.JWTExpired) {
      this.log(`${label} verification failed: Token expired`);
      return new TokenVerificationError('Token expired', 'TOKEN_EXPIRED');
    }
    if (error instanceof joseErrors.JWTInvalid) {
      this.log(`${label} verification failed: Invalid token`);
      return new TokenVerificationError('Invalid token', 'TOKEN_INVALID');
    }
    if (error instanceof joseErrors.JWKSNoMatchingKey) {
      this.log(`${label} verification failed: No matching key in JWKS`);
      return new TokenVerificationError('Invalid token signature', 'JWKS_NO_MATCH');
    }
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      this.log(`${label} verification failed: Claim validation failed`, (error as Error).message);
      return new TokenVerificationError('Token claim validation failed', 'CLAIM_VALIDATION_FAILED');
    }

    this.log(`${label} verification failed: Unknown error`, error);
    return new TokenVerificationError('Token verification failed', 'UNKNOWN_ERROR');
  }
}
