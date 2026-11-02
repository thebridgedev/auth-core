import { jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import type { Actor } from './actor.js';
import {
  actorFromIntrospection,
  createIntrospectionClient,
  type IntrospectionResult,
} from './key-introspection.js';
import { BRIDGE_TOKEN_ALGORITHMS, createKeySetResolver } from './key-set.js';
import { CredentialRefusedError, refuse, type Refusal, type RefusalReason } from './refusal.js';
import { readCredentials, type Credential, type HeadersLike } from './request.js';
import { revocationCheckFrom, type RevocationOption } from './revocation.js';
import { actorFromTokenClaims } from './token-claims.js';

/** How a verifier is set up. One verifier checks credentials for one app. */
export interface CredentialVerifierOptions {
  /** The app this verifier checks credentials for. Tokens and keys of any other app are refused. */
  appId: string;
  /** The issuer every token must come from (its `iss`). */
  issuer: string;
  /** The audience every token must name (its `aud`). @default appId */
  audience?: string;

  /** Where the app's public signing keys are published (a JSON Web Key Set URL). */
  jwksUrl?: string;
  /** The app's public signing keys themselves, instead of `jwksUrl`. */
  jwks?: JSONWebKeySet;
  /** How long a remote key set client is reused. @default 1 hour */
  jwksCacheTtlMs?: number;
  /** How many seconds of clock difference to allow on expiry and "not before". @default 0 */
  clockToleranceSeconds?: number;
  /**
   * Accept tokens whose type header is `JWT` or missing, as well as `at+jwt`.
   * Turn off once every token in circulation carries the `at+jwt` type.
   * @default true
   */
  acceptPlainJwtType?: boolean;

  /** The issuer's key introspection endpoint. Without it, keys are refused with `not_accepted`. */
  introspectionUrl?: string;
  /** How long a successful key check is reused. `0` asks every time, so revocation is instant. @default 0 */
  introspectionCacheTtlMs?: number;
  /** How long to wait for the introspection endpoint. @default 5000 */
  introspectionTimeoutMs?: number;
  /**
   * The app whose service keys may call across apps. Unset: service keys are
   * refused. Only The Bridge's own services set this.
   */
  trustedServiceAppId?: string;

  /**
   * How this verifier learns that access was taken away before a credential
   * expires. Required, so no verifier skips revocation without saying so:
   *
   * - a revocation check, usually a revocation puller's `check`, which
   *   follows the app's revocation list (see `createRevocationPuller`);
   * - `'none'`: follow no list. A token whose access was taken away keeps
   *   working until it expires. Only for places no list reaches.
   */
  revocationCheck: RevocationOption;
  /** The fetch used for the key set and the introspection endpoint. @default the global fetch */
  fetch?: typeof fetch;
  /** Optional debug logger. Never receives a credential. */
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/** The verifier's answer: an Actor, or a refusal that says why. */
export type Verification =
  | { readonly ok: true; readonly actor: Actor }
  | { readonly ok: false; readonly refusal: Refusal };

export interface CredentialVerifier {
  /** Check one credential. Never throws for a bad credential; the refusal says why. */
  verify(credential: Credential | null | undefined): Promise<Verification>;
  /** Check one credential and return its Actor, or throw a `CredentialRefusedError`. */
  verifyOrThrow(credential: Credential | null | undefined): Promise<Actor>;
  /**
   * Check the credential a request carries. Reads only the `Authorization:
   * Bearer` and `x-api-key` headers, the bearer token first. Never reads the
   * body, the query string or any other header.
   */
  verifyRequest(request: { readonly headers: HeadersLike }): Promise<Verification>;
}

const TOKEN_TYPE_ACCESS = 'at+jwt';
const TOKEN_TYPE_PLAIN = 'jwt';

/** Map a jose error to a refusal. Uses jose's stable error codes, not classes, so it works across bundles and realms. */
function refusalFromJoseError(error: unknown): Refusal {
  const code = (error as { code?: unknown } | null)?.code;
  const claim = (error as { claim?: unknown } | null)?.claim;
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return refuse('expired', 'The token has expired.');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (claim === 'iss') return refuse('wrong_issuer', 'The token was issued by someone else.');
      if (claim === 'aud') return refuse('wrong_audience', 'The token was issued for a different audience.');
      if (claim === 'nbf') return refuse('not_yet_valid', 'The token is not valid yet.');
      return refuse('invalid_claims', 'A claim the token needs is missing or malformed.');
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return refuse('wrong_algorithm', 'The token is not signed with the expected algorithm.');
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return refuse('bad_signature', "The token's signature does not match.");
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return refuse('unknown_key', "The token is not signed with one of the app's keys.");
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return refuse('bad_signature', "The token's signature does not match.");
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_INVALID':
      return refuse('unavailable', "The app's signing keys could not be loaded.");
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
    case 'ERR_JOSE_NOT_SUPPORTED':
    case 'ERR_JWK_INVALID':
      return refuse('malformed', 'The token is malformed.');
    default:
      // Anything else (a network failure while loading the key set, or an
      // error jose does not classify) is never an acceptance.
      return refuse('unavailable', 'The token could not be checked.');
  }
}

function isCompactJws(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Create the credential verifier for one app.
 *
 * It turns a person's token, a job's token or a key into one Actor context,
 * or refuses it with a reason. Tokens are checked here, by signature, against
 * the app's published keys: the algorithm is pinned, and the issuer, audience,
 * app, type and lifetime are all checked. Keys are checked by the issuer's
 * introspection endpoint.
 *
 * Runs unchanged in browsers, on servers and at the edge: it uses only `fetch`
 * and Web Crypto.
 */
export function createCredentialVerifier(options: CredentialVerifierOptions): CredentialVerifier {
  if (!options || typeof options.appId !== 'string' || options.appId.length === 0) {
    throw new TypeError('createCredentialVerifier: `appId` is required.');
  }
  if (typeof options.issuer !== 'string' || options.issuer.length === 0) {
    throw new TypeError('createCredentialVerifier: `issuer` is required.');
  }
  if (!options.jwks && !options.jwksUrl) {
    throw new TypeError('createCredentialVerifier: `jwksUrl` or `jwks` is required.');
  }

  const appId = options.appId;
  const audience = options.audience ?? appId;
  const acceptPlainJwtType = options.acceptPlainJwtType ?? true;
  const revocationCheck = revocationCheckFrom(options.revocationCheck);
  const log = options.log ?? (() => {});
  const fetchImpl: typeof fetch | undefined = options.fetch;

  const keySet: () => JWTVerifyGetKey = createKeySetResolver({
    url: options.jwksUrl,
    keys: options.jwks,
    ttlMs: options.jwksCacheTtlMs,
    fetch: fetchImpl,
  });

  const introspect: ((key: string) => Promise<IntrospectionResult>) | null = options.introspectionUrl
    ? createIntrospectionClient({
        url: options.introspectionUrl,
        fetch: fetchImpl ?? ((input, init) => fetch(input, init)),
        cacheTtlMs: options.introspectionCacheTtlMs,
        timeoutMs: options.introspectionTimeoutMs,
      })
    : null;

  async function finish(actor: Actor): Promise<Verification> {
    let verdict;
    try {
      verdict = await revocationCheck(actor);
    } catch {
      return refused(refuse('unavailable', 'Whether access was taken away could not be checked.'));
    }
    if (verdict.revoked) {
      return refused(refuse('revoked', verdict.message ?? 'Access was taken away.'));
    }
    log('Credential accepted', { kind: actor.kind, appId: actor.appId, workspaceId: actor.workspaceId });
    return { ok: true, actor };
  }

  function refused(refusal: Refusal): Verification {
    log('Credential refused', { reason: refusal.reason });
    return { ok: false, refusal };
  }

  async function verifyToken(token: string): Promise<Verification> {
    if (!isCompactJws(token)) return refused(refuse('malformed', 'The token is malformed.'));

    let payload;
    let protectedHeader;
    try {
      ({ payload, protectedHeader } = await jwtVerify(token, keySet(), {
        issuer: options.issuer,
        audience,
        algorithms: [...BRIDGE_TOKEN_ALGORITHMS],
        requiredClaims: ['exp', 'sub'],
        clockTolerance: options.clockToleranceSeconds ?? 0,
      }));
    } catch (error) {
      return refused(refusalFromJoseError(error));
    }

    const type = typeof protectedHeader.typ === 'string' ? protectedHeader.typ.toLowerCase() : undefined;
    const typeAccepted =
      type === TOKEN_TYPE_ACCESS ||
      type === `application/${TOKEN_TYPE_ACCESS}` ||
      (acceptPlainJwtType && (type === undefined || type === TOKEN_TYPE_PLAIN));
    if (!typeAccepted) {
      return refused(refuse('wrong_type', 'The token is not an access token.'));
    }

    const built = actorFromTokenClaims(payload, appId);
    if ('refusal' in built) return refused(built.refusal);
    return finish(built.actor);
  }

  async function verifyKey(key: string): Promise<Verification> {
    if (!introspect) return refused(refuse('not_accepted', 'Keys are not accepted here.'));
    const result = await introspect(key);
    if ('refusal' in result) return refused(result.refusal);
    const built = actorFromIntrospection(result.answer, {
      appId,
      trustedServiceAppId: options.trustedServiceAppId,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if ('refusal' in built) return refused(built.refusal);
    return finish(built.actor);
  }

  async function verify(credential: Credential | null | undefined): Promise<Verification> {
    if (!credential || typeof credential.value !== 'string' || credential.value.length === 0) {
      return refused(refuse('missing', 'No credential was presented.'));
    }
    if (credential.type === 'token') return verifyToken(credential.value);
    if (credential.type === 'key') return verifyKey(credential.value);
    return refused(refuse('malformed', 'Unknown credential type.'));
  }

  return {
    verify,
    async verifyOrThrow(credential) {
      const result = await verify(credential);
      if (!result.ok) throw new CredentialRefusedError(result.refusal);
      return result.actor;
    },
    async verifyRequest(request) {
      const [first] = readCredentials(request.headers);
      return verify(first);
    },
  };
}

export type { RefusalReason };
