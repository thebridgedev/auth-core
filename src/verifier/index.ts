/**
 * @nebulr-group/bridge-auth-core/verifier
 *
 * The credential verifier: one checker that turns a person's token, a job's
 * token or a key into one Actor context (who is calling, for which app, in
 * which workspace, with which privileges), or refuses it with a reason.
 *
 * Safe in every runtime: browsers, Node and edge runtimes. This entry imports
 * nothing but `jose` and its own files, and uses only `fetch` and Web Crypto.
 * Keep it that way: no Node built-ins, no storage, no module-level side
 * effects.
 */

export { createCredentialVerifier } from './verifier.js';
export type {
  CredentialVerifier,
  CredentialVerifierOptions,
  Verification,
} from './verifier.js';

export type { Actor, ActorCredential, ActorKind } from './actor.js';
export { KEY_KINDS, TOKEN_KINDS } from './actor.js';

export { CredentialRefusedError } from './refusal.js';
export type { Refusal, RefusalReason } from './refusal.js';

export { readCredentials } from './request.js';
export type { Credential, HeadersLike } from './request.js';

export { checkRevocation } from './revocation.js';
export type { RevocationCheck, RevocationVerdict } from './revocation.js';

export { BRIDGE_TOKEN_ALGORITHMS } from './key-set.js';
