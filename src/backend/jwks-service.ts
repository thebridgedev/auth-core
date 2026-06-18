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
  /**
   * Token-introspection endpoint for API-token verification.
   *
   * API tokens are signed with the per-app HS256 secret, which a plugin never
   * holds — so the plugin cannot verify them locally. Instead it POSTs the
   * token here (`{ token }`) and the Bridge returns `{ active, sub, appId,
   * tenantId, type, privileges, exp }`. This also gives instant revocation:
   * the Bridge re-checks the backing record on every (uncached) call.
   */
  introspectionUrl: string;
  /** Expected `iss` for user tokens. */
  issuer: string;
  /** Expected `aud` for user tokens (typically the appId). */
  audience: string;
  /** How long a remote JWKS client is reused before it is re-created. @default 3600000 (1h) */
  cacheTtlMs?: number;
  /**
   * How long a successful introspection result is cached, keyed by token.
   * Trades revocation latency for fewer network calls. `0` disables caching
   * (every request introspects → instant revocation). @default 0
   */
  introspectionCacheTtlMs?: number;
  /** Optional debug logger. @default no-op */
  log?: JwksLogger;
}

/**
 * Raw shape returned by the Bridge `/account/api-token/introspect` endpoint.
 */
interface IntrospectionResponse {
  active: boolean;
  sub?: string;
  appId?: string;
  tenantId?: string | null;
  type?: string;
  privileges?: string[];
  exp?: number | null;
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
const DEFAULT_INTROSPECTION_CACHE_TTL_MS = 0; // disabled → instant revocation

/**
 * Framework-agnostic, Node-only Bridge token verification.
 *
 * Covers two paths:
 *  - **User tokens** — verified locally via remote JWKS (asymmetric PS256;
 *    issuer/audience validated). The verifier needs no secret, so offline
 *    JWKS verification is the right tool.
 *  - **API tokens** — verified via remote *introspection* (a POST to the
 *    Bridge). API tokens are signed with the per-app HS256 secret which the
 *    plugin never holds, so the secret-holder (the Bridge) is asked. This also
 *    gives instant revocation. Successful results may be cached (off by
 *    default; see `introspectionCacheTtlMs`).
 *
 * This is a plain class — NOT a DI provider. Framework plugins wrap it.
 */
export class JwksService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksInitTime = 0;

  /** token → { result, expiresAt(ms) }. Only successful introspections are cached. */
  private readonly introspectionCache = new Map<
    string,
    { result: IntrospectionResponse; expiresAt: number }
  >();

  private readonly cacheTtlMs: number;
  private readonly introspectionCacheTtlMs: number;
  private readonly log: JwksLogger;

  constructor(private readonly config: JwksServiceConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.introspectionCacheTtlMs =
      config.introspectionCacheTtlMs ?? DEFAULT_INTROSPECTION_CACHE_TTL_MS;
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
   * Verify a Bridge API token by introspecting it against the Bridge.
   *
   * Unlike user tokens, API tokens are signed with the per-app HS256 secret
   * which this verifier does not hold — so it asks the secret-holder. The
   * Bridge returns whether the token is active (signature valid AND backing
   * record live: not revoked, not expired) plus its claims.
   *
   * The returned `{ active: false }` covers every rejection (forged, tampered,
   * wrong type, revoked, expired) without distinguishing them — no information
   * leak. App-scoping is then enforced here: the introspected `appId` must
   * equal `expectedAppId`.
   *
   * @throws {TokenVerificationError}
   *   - `TOKEN_INVALID` if the token is inactive or not an API token
   *   - `APP_MISMATCH` if the token belongs to a different app
   *   - `UNKNOWN_ERROR` if the introspection request itself fails
   */
  async verifyApiToken(token: string, expectedAppId: string): Promise<ApiTokenClaims> {
    const introspection = await this.introspect(token);

    if (!introspection.active) {
      // Bridge already collapsed forged/tampered/revoked/expired → inactive.
      throw new TokenVerificationError('Invalid token', 'TOKEN_INVALID');
    }

    if (introspection.type !== 'api') {
      throw new TokenVerificationError('Wrong token type', 'TOKEN_INVALID');
    }

    if (introspection.appId !== expectedAppId) {
      throw new TokenVerificationError('Token issued for a different app', 'APP_MISMATCH');
    }

    this.log('API token verified via introspection', {
      sub: introspection.sub,
      appId: introspection.appId,
    });

    return {
      sub: introspection.sub as string,
      appId: introspection.appId as string,
      tenantId: introspection.tenantId ?? null,
      type: 'api',
      privileges: introspection.privileges ?? [],
      ...(introspection.exp != null ? { exp: introspection.exp } : {}),
    } as ApiTokenClaims;
  }

  /**
   * POST the token to the introspection endpoint, with optional short-lived
   * caching of successful results (see `introspectionCacheTtlMs`).
   */
  private async introspect(token: string): Promise<IntrospectionResponse> {
    const cached = this.getCachedIntrospection(token);
    if (cached) {
      this.log('API token introspection cache hit');
      return cached;
    }

    let response: Response;
    try {
      response = await fetch(this.config.introspectionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (error) {
      this.log('API token introspection request failed', error);
      throw new TokenVerificationError('Introspection request failed', 'UNKNOWN_ERROR');
    }

    if (!response.ok) {
      this.log('API token introspection returned a non-OK status', {
        status: response.status,
      });
      throw new TokenVerificationError('Introspection endpoint error', 'UNKNOWN_ERROR');
    }

    let body: IntrospectionResponse;
    try {
      body = (await response.json()) as IntrospectionResponse;
    } catch (error) {
      this.log('API token introspection returned invalid JSON', error);
      throw new TokenVerificationError('Introspection response invalid', 'UNKNOWN_ERROR');
    }

    if (body.active) {
      this.cacheIntrospection(token, body);
    }
    return body;
  }

  private getCachedIntrospection(token: string): IntrospectionResponse | null {
    if (this.introspectionCacheTtlMs <= 0) {
      return null;
    }
    const entry = this.introspectionCache.get(token);
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      this.introspectionCache.delete(token);
      return null;
    }
    return entry.result;
  }

  private cacheIntrospection(token: string, result: IntrospectionResponse): void {
    if (this.introspectionCacheTtlMs <= 0) {
      return;
    }
    this.introspectionCache.set(token, {
      result,
      expiresAt: Date.now() + this.introspectionCacheTtlMs,
    });
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
