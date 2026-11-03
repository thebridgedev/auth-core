/**
 * @nebulr-group/bridge-auth-core/verifier
 *
 * The credential verifier: one checker that turns a person's token, a job's
 * token, a key or a token issued for a key into one Actor context (who is calling, for which app, in
 * which workspace, with which privileges), or refuses it with a reason. And
 * the revocation puller, which follows the app's revocation list so access
 * that was taken away stops working within seconds.
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

export { NO_REVOCATION_CHECK } from './revocation.js';
export type { RevocationCheck, RevocationOption, RevocationVerdict } from './revocation.js';

export { createRevocationPuller, RevocationListUnavailableError } from './revocation-puller.js';
export type {
  RevocationLaneStatus,
  RevocationListStatus,
  RevocationPuller,
  RevocationPullerOptions,
} from './revocation-puller.js';
export {
  REVOCATION_ALGORITHMS,
  REVOCATION_CHECKPOINT_TYPE,
  REVOCATION_ENTRY_TYPE,
  REVOCATION_FORMAT_VERSION,
} from './revocation-entry.js';
export type { RevocationCheckpoint, RevocationEntry, RevocationKind } from './revocation-entry.js';

export { BRIDGE_TOKEN_ALGORITHMS, createKeySet } from './key-set.js';
export type { KeySet, KeySetOptions } from './key-set.js';
