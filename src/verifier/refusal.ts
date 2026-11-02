/**
 * Why a credential was refused.
 *
 * Every refusal names one reason, so a caller can answer correctly: ask the
 * person to sign in again for `expired`, retry later for `unavailable`, and
 * treat everything else as "not a valid credential for this app".
 *
 * - `missing`: no credential was presented.
 * - `malformed`: not a well-formed token or key.
 * - `expired`: past its expiry time.
 * - `not_yet_valid`: before its "not before" time.
 * - `wrong_algorithm`: not signed with the one algorithm The Bridge uses (this
 *   covers unsigned tokens, `alg: none`).
 * - `bad_signature`: the signature does not match; the token was changed or
 *   signed with a key that is not the app's.
 * - `unknown_key`: signed with a key that is not in the app's key set, such as
 *   another app's key.
 * - `wrong_issuer`: issued by someone else.
 * - `wrong_audience`: issued for a different audience.
 * - `wrong_app`: issued for a different app.
 * - `wrong_type`: the wrong kind of token or key for this use, such as an ID
 *   token presented as an access token.
 * - `invalid_claims`: a claim the verifier needs is missing or malformed.
 * - `inactive`: the issuer says the key is not active (unknown, expired or
 *   revoked).
 * - `revoked`: access was taken away before the credential expired.
 * - `not_accepted`: this verifier is not set up to accept this kind of
 *   credential.
 * - `unavailable`: the verifier could not reach what it needs to decide (the
 *   key set or the introspection endpoint). The credential is refused, never
 *   accepted, while this lasts.
 */
export type RefusalReason =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_algorithm'
  | 'bad_signature'
  | 'unknown_key'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_app'
  | 'wrong_type'
  | 'invalid_claims'
  | 'inactive'
  | 'revoked'
  | 'not_accepted'
  | 'unavailable';

/** A refusal: one reason and a short message. Never contains the credential itself. */
export interface Refusal {
  readonly reason: RefusalReason;
  readonly message: string;
}

export function refuse(reason: RefusalReason, message: string): Refusal {
  return Object.freeze({ reason, message });
}

/** Thrown by `verifyOrThrow` when a credential is refused. */
export class CredentialRefusedError extends Error {
  readonly reason: RefusalReason;
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = 'CredentialRefusedError';
    this.reason = refusal.reason;
    this.refusal = refusal;
  }
}
