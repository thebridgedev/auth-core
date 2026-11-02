import type { Actor } from './actor.js';

/**
 * The answer of a revocation check: still allowed, or taken away.
 */
export type RevocationVerdict =
  | { readonly revoked: false }
  | { readonly revoked: true; readonly message?: string };

/**
 * A revocation check. The verifier calls it once for every credential that
 * passed every other check, just before it hands out the Actor. A credential
 * whose access was taken away is refused with the reason `revoked`, even when
 * it has not expired yet.
 */
export type RevocationCheck = (actor: Actor) => RevocationVerdict | Promise<RevocationVerdict>;

const NOT_REVOKED: RevocationVerdict = Object.freeze({ revoked: false });

/**
 * ---------------------------------------------------------------------------
 * REVOCATION SEAM: this check does nothing yet.
 * ---------------------------------------------------------------------------
 *
 * The revocation list does not exist yet. When it does, its check plugs in
 * here, so a token that is still within its lifetime stops working within
 * seconds of access being taken away. Until then every credential that passed
 * the other checks is reported as not revoked.
 *
 * A caller that already has a revocation source can pass its own check as the
 * verifier's `revocationCheck` option; this default is used only when none is
 * given.
 */
export function checkRevocation(_actor: Actor): RevocationVerdict {
  return NOT_REVOKED;
}
