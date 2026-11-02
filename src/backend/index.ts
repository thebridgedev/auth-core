/**
 * @nebulr-group/bridge-auth-core/backend
 *
 * Framework-agnostic, Node-only auth surface for server-side Bridge plugins.
 * No NestJS, no browser/storage APIs. Safe to import from any Node backend.
 *
 * New server code should use the credential verifier
 * (`@nebulr-group/bridge-auth-core/verifier`, re-exported here): one checker
 * that turns any token or key into one Actor context.
 */

// The credential verifier and the Actor context.
export * from '../verifier/index.js';

// Migration helpers from the Actor to the older caller shapes.
export { actorToBridgeUser, actorToApiTokenClaims } from './actor-compat.js';

// JWKS-based verification (plain class, not a DI provider). Deprecated: use the credential verifier.
export { JwksService, TokenVerificationError } from './jwks-service.js';
export type { JwksServiceConfig, JwksLogger } from './jwks-service.js';

// Shared backend types + user transform. Deprecated: use the Actor.
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
