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
 * it has not expired yet. A check that throws makes the verifier refuse with
 * `unavailable`, never accept.
 *
 * Usually a revocation puller's `check` (see `createRevocationPuller`).
 */
export type RevocationCheck = (actor: Actor) => RevocationVerdict | Promise<RevocationVerdict>;

/**
 * The explicit opt-out from revocation, for the verifier's `revocationCheck`
 * option: this verifier follows no revocation list, so a token whose access
 * was taken away keeps working until it expires. Use it only where no list
 * can reach, such as a tool that runs for one access-token lifetime at most.
 */
export const NO_REVOCATION_CHECK = 'none';

/** What the verifier's `revocationCheck` option accepts. */
export type RevocationOption = RevocationCheck | typeof NO_REVOCATION_CHECK;

const NOT_REVOKED: RevocationVerdict = Object.freeze({ revoked: false });

/** Turn the option into the check the verifier runs. A missing option is refused: it is never a silent no-op. */
export function revocationCheckFrom(option: RevocationOption | undefined): RevocationCheck {
  if (option === NO_REVOCATION_CHECK) return () => NOT_REVOKED;
  if (typeof option === 'function') return option;
  throw new TypeError(
    "createCredentialVerifier: `revocationCheck` is required. Pass a revocation puller's `check` " +
      "(see createRevocationPuller), or 'none' to rely on tokens expiring.",
  );
}
