/**
 * Migration helpers from the Actor context to the older caller shapes.
 *
 * Server code that still hands a `BridgeUser` or `ApiTokenClaims` to its own
 * handlers can switch to the credential verifier first and convert here, then
 * move its handlers to the Actor one at a time.
 */
import type { Actor } from '../verifier/actor.js';
import { transformJwtToBridgeUser, type ApiTokenClaims, type BridgeUser, type JwtClaims } from './types.js';

/**
 * The `BridgeUser` for a person's Actor, built exactly as before from the
 * token's checked claims. Null for any other kind of caller.
 *
 * @deprecated Read the `Actor` directly. Kept so existing handlers keep working.
 */
export function actorToBridgeUser(actor: Actor): BridgeUser | null {
  if (actor.kind !== 'person') return null;
  return transformJwtToBridgeUser(actor.claims as unknown as JwtClaims);
}

/**
 * The `ApiTokenClaims` for a key's Actor, in the shape the key check returned
 * before. Null for a person or a job.
 *
 * @deprecated Read the `Actor` directly. Kept so existing handlers keep working.
 */
export function actorToApiTokenClaims(actor: Actor): ApiTokenClaims | null {
  if (actor.credential.type !== 'key') return null;
  return {
    sub: actor.id,
    appId: actor.appId,
    tenantId: actor.workspaceId,
    type: 'api',
    privileges: [...actor.privileges],
    ...(actor.credential.expiresAt !== null ? { exp: actor.credential.expiresAt } : {}),
  };
}
