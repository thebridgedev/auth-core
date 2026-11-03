import { jwtVerify, type JSONWebKeySet } from 'jose';
import type { Actor } from './actor.js';
import {
  actorFromIntrospection,
  createIntrospectionClient,
  type IntrospectionResult,
} from './key-introspection.js';
import {
  BRIDGE_TOKEN_ALGORITHMS,
  KEY_SET_NOT_FOUND,
  KEY_SET_UNAVAILABLE,
  createKeySet,
  type KeySet,
} from './key-set.js';
import { CredentialRefusedError, refuse, type Refusal, type RefusalReason } from './refusal.js';
import { readCredentials, type Credential, type HeadersLike } from './request.js';
import { revocationCheckFrom, type RevocationCheck, type RevocationOption } from './revocation.js';
import { actorFromTokenClaims } from './token-claims.js';

/** How a verifier is set up. One verifier checks credentials for one app. */
export interface CredentialVerifierOptions {
  /** The app this verifier checks credentials for. Tokens and keys of any other app are refused. */
  appId: string;
  /** The issuer every token must come from (its `iss`). */
  issuer: string;
  /**
   * The audience every token must name (its `aud`): the API this verifier
   * protects. Required, and never taken to be the app id.
   */
  audience: string;

  /** Where the app's public signing keys are published (a JSON Web Key Set URL). */
  jwksUrl?: string;
  /** The app's public signing keys themselves, instead of `jwksUrl`. */
  jwks?: JSONWebKeySet;
  /**
   * The app's key set, made with `createKeySet`, instead of `jwksUrl` or
   * `jwks`. Pass the same one to the revocation puller so the keys are
   * fetched once.
   */
  keySet?: KeySet;
  /** How long a loaded key set is used before it is fetched again. @default 10 minutes */
  jwksCacheTtlMs?: number;
  /** How many seconds of clock difference to allow on expiry and "not before". @default 0 */
  clockToleranceSeconds?: number;

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
   * - a revocation check: a function that gets each Actor that passed every
   *   other check and says whether its access was taken away;
   * - `'none'`: follow no revocation. A token whose access was taken away
   *   keeps working until it expires.
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

/**
 * The access token type (RFC 9068). Only tokens whose `typ` header says they
 * are access tokens (`at+jwt`, or `application/at+jwt`) are accepted: an ID
 * token, a plain `JWT` or an untyped token is refused, even when it is signed
 * with the app's key.
 */
const ACCESS_TOKEN_TYPE = 'at+jwt';

type Log = (message: string, details?: Record<string, unknown>) => void;

/** Everything needed to check one app's credentials. Shared by the one-app and the many-app verifier. */
export interface AppRules {
  readonly appId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly keySet: KeySet;
  readonly clockToleranceSeconds: number;
  readonly trustedServiceAppId?: string;
  readonly revocationCheck: RevocationCheck;
  readonly log: Log;
}

/** Map a jose or key set error to a refusal. Uses stable error codes, not classes, so it works across bundles and realms. */
function refusalFromVerifyError(error: unknown): Refusal {
  const code = (error as { code?: unknown } | null)?.code;
  const claim = (error as { claim?: unknown } | null)?.claim;
  switch (code) {
    case KEY_SET_NOT_FOUND:
      return refuse('unknown_app', 'No signing keys are published for this app.');
    case KEY_SET_UNAVAILABLE:
      return refuse('unavailable', "The app's signing keys could not be loaded.");
    case 'ERR_JWT_EXPIRED':
      return refuse('expired', 'The token has expired.');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (claim === 'iss') return refuse('wrong_issuer', 'The token was issued by someone else.');
      if (claim === 'aud') return refuse('wrong_audience', 'The token was issued for a different audience.');
      if (claim === 'nbf') return refuse('not_yet_valid', 'The token is not valid yet.');
      if (claim === 'typ') return refuse('wrong_type', 'The token is not an access token.');
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

export function isCompactJws(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts[0].length > 0 && parts[1].length > 0;
}

function refused(rules: Pick<AppRules, 'log'>, refusal: Refusal): Verification {
  rules.log('Credential refused', { reason: refusal.reason });
  return { ok: false, refusal };
}

/** The last step for every credential: the revocation check, then the Actor. */
async function finish(rules: AppRules, actor: Actor): Promise<Verification> {
  let verdict;
  try {
    verdict = await rules.revocationCheck(actor);
  } catch {
    return refused(rules, refuse('unavailable', 'Whether access was taken away could not be checked.'));
  }
  if (verdict.revoked) {
    return refused(rules, refuse('revoked', verdict.message ?? 'Access was taken away.'));
  }
  rules.log('Credential accepted', { kind: actor.kind, appId: actor.appId, workspaceId: actor.workspaceId });
  return { ok: true, actor };
}

/**
 * Check a token against one app's rules: signature (algorithm pinned),
 * type, issuer, audience, lifetime, app; then the revocation check, which
 * runs only for a token that passed everything else.
 */
export async function checkToken(rules: AppRules, token: string): Promise<Verification> {
  if (!isCompactJws(token)) return refused(rules, refuse('malformed', 'The token is malformed.'));

  let payload;
  try {
    ({ payload } = await jwtVerify(token, rules.keySet.getKey, {
      issuer: rules.issuer,
      audience: rules.audience,
      algorithms: [...BRIDGE_TOKEN_ALGORITHMS],
      requiredClaims: ['exp', 'sub'],
      clockTolerance: rules.clockToleranceSeconds,
      typ: ACCESS_TOKEN_TYPE,
    }));
  } catch (error) {
    return refused(rules, refusalFromVerifyError(error));
  }

  const built = actorFromTokenClaims(payload, rules.appId);
  if ('refusal' in built) return refused(rules, built.refusal);
  return finish(rules, built.actor);
}

/** Turn the introspection endpoint's answer about a key into a verification against one app's rules. */
export async function checkKeyAnswer(rules: AppRules, result: IntrospectionResult): Promise<Verification> {
  if ('refusal' in result) return refused(rules, result.refusal);
  const built = actorFromIntrospection(result.answer, {
    appId: rules.appId,
    trustedServiceAppId: rules.trustedServiceAppId,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if ('refusal' in built) return refused(rules, built.refusal);
  return finish(rules, built.actor);
}

export function requireText(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(message);
}

/**
 * Create the credential verifier for one app.
 *
 * It turns a person's token, a job's token, a key or a token issued for a key
 * into one Actor context, or refuses it with a reason. Tokens are checked
 * here, by signature, against the app's published keys: the algorithm is
 * pinned, and the type (`at+jwt` only), issuer, audience, app and lifetime
 * are all checked. Keys are checked by the issuer's introspection endpoint.
 *
 * Runs unchanged in browsers, on servers and at the edge: it uses only `fetch`
 * and Web Crypto.
 */
export function createCredentialVerifier(options: CredentialVerifierOptions): CredentialVerifier {
  if (!options) throw new TypeError('createCredentialVerifier: options are required.');
  requireText(options.appId, 'createCredentialVerifier: `appId` is required.');
  requireText(options.issuer, 'createCredentialVerifier: `issuer` is required.');
  requireText(
    options.audience,
    'createCredentialVerifier: `audience` is required: the audience your API expects in tokens. It is never the app id by default.',
  );
  if (!options.keySet && !options.jwks && !options.jwksUrl) {
    throw new TypeError('createCredentialVerifier: `jwksUrl`, `jwks` or `keySet` is required.');
  }

  const log: Log = options.log ?? (() => {});
  const fetchImpl: typeof fetch | undefined = options.fetch;
  const rules: AppRules = {
    appId: options.appId,
    issuer: options.issuer,
    audience: options.audience,
    keySet:
      options.keySet ??
      createKeySet({ url: options.jwksUrl, keys: options.jwks, maxAgeMs: options.jwksCacheTtlMs, fetch: fetchImpl }),
    clockToleranceSeconds: options.clockToleranceSeconds ?? 0,
    trustedServiceAppId: options.trustedServiceAppId,
    revocationCheck: revocationCheckFrom(options.revocationCheck),
    log,
  };

  const introspect: ((key: string) => Promise<IntrospectionResult>) | null = options.introspectionUrl
    ? createIntrospectionClient({
        url: options.introspectionUrl,
        fetch: fetchImpl ?? ((input, init) => fetch(input, init)),
        cacheTtlMs: options.introspectionCacheTtlMs,
        timeoutMs: options.introspectionTimeoutMs,
      })
    : null;

  async function verify(credential: Credential | null | undefined): Promise<Verification> {
    if (!credential || typeof credential.value !== 'string' || credential.value.length === 0) {
      return refused(rules, refuse('missing', 'No credential was presented.'));
    }
    if (credential.type === 'token') return checkToken(rules, credential.value);
    if (credential.type === 'key') {
      if (!introspect) return refused(rules, refuse('not_accepted', 'Keys are not accepted here.'));
      return checkKeyAnswer(rules, await introspect(credential.value));
    }
    return refused(rules, refuse('malformed', 'Unknown credential type.'));
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
