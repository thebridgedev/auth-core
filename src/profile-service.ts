import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import type { Logger } from './logger.js';
import type { IDToken, Profile, ResolvedConfig } from './types.js';

export class ProfileService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private cachedIssuer: string | null = null;
  private cachedAudience: string | null = null;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
  ) {}

  async verifyAndDecode(idToken: string): Promise<Profile | null> {
    try {
      this.ensureVerifier();
      const { payload } = await jwtVerify(idToken, this.jwks!, {
        issuer: this.config.authBaseUrl,
        audience: this.config.appId,
      });
      return transformIDToken(payload as unknown as IDToken);
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        this.logger.warn('Token expired');
      } else if (err instanceof joseErrors.JWTInvalid) {
        this.logger.warn('Invalid token');
      } else if (err instanceof joseErrors.JWKSNoMatchingKey) {
        this.logger.warn('JWKS error');
      } else {
        this.logger.error('Token verification failed', err);
      }
      return null;
    }
  }

  /** Decode without verification — use only when JWKS is unavailable */
  decodeWithoutVerify(idToken: string): Profile | null {
    try {
      const parts = idToken.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return transformIDToken(payload as IDToken);
    } catch {
      return null;
    }
  }

  private ensureVerifier(): void {
    if (
      !this.jwks ||
      this.cachedIssuer !== this.config.authBaseUrl ||
      this.cachedAudience !== this.config.appId
    ) {
      this.jwks = createRemoteJWKSet(
        new URL(`${this.config.authBaseUrl}/.well-known/jwks.json`),
      );
      this.cachedIssuer = this.config.authBaseUrl;
      this.cachedAudience = this.config.appId;
    }
  }
}

function transformIDToken(payload: IDToken): Profile {
  return {
    id: payload.sub,
    username: payload.preferred_username,
    email: payload.email,
    emailVerified: payload.email_verified,
    fullName: payload.name,
    familyName: payload.family_name,
    givenName: payload.given_name,
    locale: payload.locale,
    onboarded: payload.onboarded,
    multiTenantAccess: payload.multi_tenant,
    tenant: payload.tenant_id
      ? {
          id: payload.tenant_id,
          name: payload.tenant_name || '',
          locale: payload.tenant_locale,
          logo: payload.tenant_logo,
          onboarded: payload.tenant_onboarded,
        }
      : undefined,
  };
}
