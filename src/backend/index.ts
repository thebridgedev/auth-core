/**
 * @nebulr-group/bridge-auth-core/backend
 *
 * Framework-agnostic, Node-only auth surface for server-side Bridge plugins.
 * No NestJS, no browser/storage APIs. Safe to import from any Node backend.
 */

// JWKS-based verification (plain class, not a DI provider)
export { JwksService, TokenVerificationError } from './jwks-service.js';
export type { JwksServiceConfig, JwksLogger } from './jwks-service.js';

// Shared backend types + user transform
export type { JwtClaims, BridgeUser, ApiTokenClaims } from './types.js';
export { transformJwtToBridgeUser } from './types.js';

// Token utilities (reused from the shared token-utils — no duplication)
export {
  decodeJwtPayload,
  getTokenExpiry,
  isTokenExpired,
  getTenantId,
  getTenantUserId,
} from '../token-utils.js';
