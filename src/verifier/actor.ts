/**
 * The Actor context: the one description of who is calling.
 *
 * Every credential the verifier accepts (a person's token, a job's token, or
 * any kind of key) becomes an Actor. Code that needs to know who is calling,
 * for which app, in which workspace and with which privileges reads it here
 * and nowhere else: never from a header, a query string or a request body.
 *
 * An Actor is built only from data the verifier has checked: the signed claims
 * of a token, or the answer of the key introspection endpoint. It is frozen, so
 * nothing downstream can change who the caller is.
 */

/**
 * What kind of caller this is.
 *
 * - `person`: a signed-in person, calling with their access token.
 * - `job`: a background job, calling with its own token. A job runs for one
 *   workspace.
 * - `personal_key`: a key a member made for their own scripts. It reaches only
 *   that member's workspace and never more than the member holds. A personal
 *   key can also be made for one job (see `jobId`).
 * - `service_account_key`: a key of a service account, a member without a
 *   person. It reaches one workspace, within the service account's role.
 * - `app_key`: the app's own backend key. It reaches the whole app, across all
 *   workspaces.
 * - `service`: the key of one of The Bridge's own services. It is accepted only
 *   by a verifier configured with `trustedServiceAppId`.
 */
export type ActorKind =
  | 'person'
  | 'job'
  | 'personal_key'
  | 'service_account_key'
  | 'app_key'
  | 'service';

/** The kinds of key. A key is checked by the introspection endpoint. */
export const KEY_KINDS: readonly ActorKind[] = Object.freeze([
  'personal_key',
  'service_account_key',
  'app_key',
  'service',
] as const);

/** The kinds of token the verifier checks itself, by signature. */
export const TOKEN_KINDS: readonly ActorKind[] = Object.freeze(['person', 'job'] as const);

/** How the credential behind an Actor was checked, and when it stops working. */
export interface ActorCredential {
  /** `token` for a signed token, `key` for a key. */
  readonly type: 'token' | 'key';
  /** `signature` when the verifier checked the signature itself, `introspection` when the issuer was asked. */
  readonly checkedBy: 'signature' | 'introspection';
  /** When the credential expires, in seconds since the epoch. Null when it does not say. */
  readonly expiresAt: number | null;
  /** When the credential was issued, in seconds since the epoch. Null when it does not say. */
  readonly issuedAt: number | null;
  /** The token's unique id (`jti`), when it has one. */
  readonly tokenId: string | null;
  /** The sign-in session the token belongs to (`sid`), when it says. */
  readonly sessionId: string | null;
}

/**
 * Who is calling, for which app and workspace, and with which privileges.
 */
export interface Actor {
  /** What kind of caller this is. */
  readonly kind: ActorKind;
  /**
   * Who is calling: the user's id for a person, the key's id for a key, the
   * job's id for a job. It is the credential's subject.
   */
  readonly id: string;
  /** The app the credential belongs to. */
  readonly appId: string;
  /**
   * The workspace the credential is bound to. Null when it is bound to none:
   * an app key or a service reaches every workspace of the app, and a person
   * may be signed in without a workspace selected.
   */
  readonly workspaceId: string | null;
  /** What the caller may do, as privilege names. */
  readonly privileges: readonly string[];
  /** The scopes the credential was granted. */
  readonly scopes: readonly string[];
  /**
   * The person behind the call: the user's id for a person, the member who
   * made it for a personal key. Null for every other kind.
   */
  readonly personId: string | null;
  /**
   * The job the credential is narrowed to: set for a job's own token (equal
   * to `id`) and for a personal key made for one job. Null otherwise.
   */
  readonly jobId: string | null;
  /** The person's role in the workspace, when the credential says. */
  readonly role: string | null;
  /** How the credential was checked and when it stops working. */
  readonly credential: ActorCredential;
  /**
   * The checked claims the Actor was built from, for reading anything the
   * fields above do not lift out (for example the app's own claims). Never
   * read identity from here when a field above carries it.
   */
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Freeze an Actor and everything it holds, so no code downstream can change who the caller is. */
export function freezeActor(actor: Actor): Actor {
  Object.freeze(actor.privileges);
  Object.freeze(actor.scopes);
  Object.freeze(actor.credential);
  Object.freeze(actor.claims);
  return Object.freeze(actor);
}
