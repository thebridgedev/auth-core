/**
 * The guard in MCP mode: one call in front of an MCP endpoint.
 *
 * An AI assistant that connects to the endpoint without a token is told
 * where to sign in (OAuth 2.0 Protected Resource Metadata, RFC 9728): the
 * endpoint answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`,
 * and the metadata document names the app's issuer as the authorization
 * server. The assistant signs the person in there and comes back with a token
 * issued for this endpoint: its audience (`aud`) is the endpoint's address,
 * exactly as the assistant named it (RFC 8707).
 *
 * Accepted at the endpoint:
 *
 * - a token issued for this endpoint (an assistant's), and
 * - the app's own access tokens (its web app and its CLI), whose audience is
 *   the app's `bridge_access_token_audience`.
 *
 * Refused: a token for another endpoint, another app (issuer, keys or `aid`),
 * Bridge's own MCP server, an expired or ended one. The app's revocation list
 * is followed, so a connection ended in Connected tools is refused within the
 * list's lag.
 *
 * The rule runs one way: the app's normal guard (`createBridgeServer`) checks
 * the app's audience only, so an assistant's token never opens the app's API.
 *
 * Runs on Node and edge runtimes: it uses only `fetch` and Web Crypto.
 */
import { Discovery } from '../core/discovery.js';
import { BridgeError } from '../core/errors.js';
import { platformFetch, withoutRedirects, type Fetch } from '../core/http.js';
import { REVOCATION_LANES } from '../core/routes.js';
import { secureUrl } from '../core/urls.js';
import {
  createCredentialVerifier,
  createKeySet,
  createRevocationPuller,
  readCredentials,
  type Actor as VerifiedActor,
  type CredentialVerifier,
  type HeadersLike,
  type RevocationListStatus,
  type RevocationPuller,
  type Verification,
} from '../verifier/index.js';

/** Where RFC 9728 puts a protected resource's metadata. */
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** The scope Bridge offers every app's assistants: renewal with a refresh token. */
const DEFAULT_SCOPES: readonly string[] = Object.freeze(['offline_access']);

/** The protected-resource metadata document (RFC 9728, section 2). */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly resource_name?: string;
}

export interface ProtectedResourceOptions {
  /** The app's issuer: the authorization server assistants sign in at. */
  readonly issuer: string;
  /** The MCP endpoint's address, exactly as assistants are given it, such as `https://acme.example/mcp`. */
  readonly resource: string;
  /** A name for the endpoint that an assistant may show. */
  readonly resourceName?: string;
  /** The scopes to list. @default ['offline_access'] */
  readonly scopesSupported?: readonly string[];
}

/** The endpoint's address, checked: https (http only on this machine), no fragment, no query, no user name. */
function checkedResource(resource: unknown): string {
  if (typeof resource !== 'string' || secureUrl(resource) === null) {
    throw new BridgeError('misconfigured', `The MCP endpoint's address must be https (http only on localhost); got "${String(resource)}".`);
  }
  const url = new URL(resource);
  if (url.hash !== '' || resource.includes('#') || url.search !== '') {
    throw new BridgeError('misconfigured', "The MCP endpoint's address may have no query or fragment.");
  }
  return resource;
}

/**
 * Where the endpoint's metadata is served (RFC 9728, 3.1): the well-known
 * path inserted between the host and the endpoint's path, so
 * `https://acme.example/mcp` has its metadata at
 * `https://acme.example/.well-known/oauth-protected-resource/mcp`.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(checkedResource(resource));
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}${path}`;
}

/**
 * The paths the metadata is served at: the endpoint's own one (RFC 9728) and
 * the plain root one, which some assistants ask for first.
 */
export function protectedResourceMetadataPaths(resource: string): readonly string[] {
  const own = new URL(protectedResourceMetadataUrl(resource)).pathname;
  return Object.freeze(own === PROTECTED_RESOURCE_METADATA_PATH ? [own] : [own, PROTECTED_RESOURCE_METADATA_PATH]);
}

/** The metadata document for an MCP endpoint, with no network call. */
export function protectedResourceMetadata(options: ProtectedResourceOptions): ProtectedResourceMetadata {
  if (typeof options?.issuer !== 'string' || secureUrl(options.issuer) === null) {
    throw new BridgeError('misconfigured', `The issuer must be an https address (http only on localhost); got "${String(options?.issuer)}".`);
  }
  const doc: ProtectedResourceMetadata = {
    resource: checkedResource(options.resource),
    authorization_servers: Object.freeze([options.issuer]),
    bearer_methods_supported: Object.freeze(['header']),
    scopes_supported: Object.freeze([...(options.scopesSupported ?? DEFAULT_SCOPES)]),
    ...(options.resourceName === undefined || options.resourceName === '' ? {} : { resource_name: options.resourceName }),
  };
  return Object.freeze(doc);
}

/** A quoted-string for an HTTP header parameter (RFC 9110, 5.6.4). */
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
}

/**
 * The `WWW-Authenticate` value for a refused call (RFC 6750, 3; RFC 9728, 5.1):
 * always `resource_metadata`, and `error="invalid_token"` when a token came and
 * was refused.
 */
export function mcpChallenge(metadataUrl: string, refused?: { readonly description?: string }): string {
  const parts = [`resource_metadata=${quoted(metadataUrl)}`];
  if (refused !== undefined) {
    parts.push('error="invalid_token"');
    if (refused.description !== undefined && refused.description !== '') parts.push(`error_description=${quoted(refused.description)}`);
  }
  return `Bearer ${parts.join(', ')}`;
}

/** Who is calling the MCP endpoint, from the checked token only. */
export interface McpCaller {
  /** `person` for a signed-in person (always, for an assistant), or another kind for the app's own tokens. */
  readonly kind: VerifiedActor['kind'];
  /** The token's subject: the user's id for a person. */
  readonly id: string;
  /** The person behind the call; null for a token with no person. */
  readonly userId: string | null;
  /** The workspace the token is for; null when it names none. */
  readonly workspaceId: string | null;
  /** The person's role in the workspace, when the token says. */
  readonly role: string | null;
  /** The person's own privileges in the app. An assistant holds no delete privilege unless deleting was allowed at consent. */
  readonly privileges: readonly string[];
  /** The scopes granted. */
  readonly scopes: readonly string[];
  /**
   * Whether the caller may delete: the token is not limited (no `management`
   * scope), or deleting was allowed when the person approved the tool (`delete`).
   */
  readonly mayDelete: boolean;
  /** Who holds the token: an assistant connected to this endpoint, or the app's own web app or CLI. */
  readonly client: { readonly id: string | null; readonly kind: 'assistant' | 'app' };
  readonly appId: string;
  readonly sessionId: string | null;
  /** The person's email, when the token carries it. */
  readonly email: string | null;
  /** The workspace's standing, such as `active`, when the token says. */
  readonly standing: string | null;
  /** When the token expires, in seconds since the epoch. */
  readonly expiresAt: number | null;
  /** The verifier's full answer, for anything not lifted out above. */
  readonly actor: VerifiedActor;
}

/** A refusal, as the parts of the answer to send: status, headers and a JSON body. */
export interface McpRefusal {
  readonly status: 401 | 503;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly error: string; readonly error_description: string };
  /** The verifier's reason (`missing`, `expired`, `wrong_audience`, `revoked`, `unavailable`, ...). */
  readonly reason: string;
}

export type McpCheck = { readonly ok: true; readonly caller: McpCaller; readonly token: string } | { readonly ok: false; readonly refusal: McpRefusal };

export interface McpGuardOptions {
  /** The app's issuer, as for the browser SDK. */
  readonly issuer: string;
  /** The MCP endpoint's address, exactly as assistants are given it: `https://acme.example/mcp`. */
  readonly resource: string;
  /** A name for the endpoint that an assistant may show. */
  readonly resourceName?: string;
  /** The scopes the metadata lists. @default ['offline_access'] */
  readonly scopesSupported?: readonly string[];
  /** The audience of the app's own access tokens. Read from the issuer's metadata; give it only for an issuer that does not publish it. */
  readonly audience?: string;
  /**
   * Whether the app's own access tokens (web app, CLI) are accepted too.
   * @default true
   */
  readonly acceptAppTokens?: boolean;
  readonly fetch?: Fetch;
  /** How far behind the revocation list may fall before checks answer `unavailable`. @default 300000 (5 minutes) */
  readonly maxLagMs?: number;
  /** How often to fetch new revocation entries. @default 2000 */
  readonly revocationIntervalMs?: number;
  /** The first wait before the issuer's metadata is read again after a failure. @default 1000 */
  readonly discoveryRetryMs?: number;
  /** Debug messages. Never receives a credential. */
  readonly log?: (message: string, details?: Record<string, unknown>) => void;
}

/** A request, or anything with its headers (and, for `isMetadataRequest`, its method and URL). */
export interface McpRequestLike {
  readonly headers: HeadersLike;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
}

export interface McpGuard {
  /** Resolves once the issuer's metadata was read and the checks are set up. */
  readonly ready: Promise<void>;
  /** The endpoint's address. */
  readonly resource: string;
  /** Where the endpoint's metadata is served, as `WWW-Authenticate` names it. */
  readonly metadataUrl: string;
  /** The paths to serve the metadata at (mount `metadataHandler` on each). */
  readonly metadataPaths: readonly string[];
  /** The metadata document. */
  metadata(): ProtectedResourceMetadata;
  /** Whether a request asks for the metadata: a GET or HEAD to one of `metadataPaths`. */
  isMetadataRequest(request: { readonly method?: string | undefined; readonly url?: string | undefined }): boolean;
  /** The metadata as a Fetch `Response`, with CORS open so browser-based assistants can read it. */
  metadataResponse(): Response;
  /** A Fetch handler that answers with the metadata. */
  metadataHandler(): (request?: Request) => Response;
  /** Checks the request's bearer token. Never throws; a refusal carries the answer's parts. */
  check(request: McpRequestLike): Promise<McpCheck>;
  /** Checks one bearer token. */
  checkToken(token: string | null | undefined): Promise<McpCheck>;
  /** A refusal as a Fetch `Response`. */
  refusalResponse(refusal: McpRefusal): Response;
  /**
   * Wraps a Fetch handler: answers the metadata requests itself, refuses calls
   * without a valid token, and calls `handler` with the caller otherwise.
   */
  protect(handler: (request: Request, caller: McpCaller) => Response | Promise<Response>): (request: Request) => Promise<Response>;
  /** How the revocation list is followed, for a health check. */
  status(): RevocationListStatus | null;
  /** Stops following the revocation list. */
  close(): Promise<void>;
}

const CORS: Readonly<Record<string, string>> = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
});

function bearerOf(headers: HeadersLike): string | null {
  return readCredentials(headers).find((credential) => credential.type === 'token')?.value ?? null;
}

function pathOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function stringClaim(claims: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Whether a token's scopes allow deleting: not limited (`management`), or limited with `delete` granted. */
export function scopesAllowDelete(scopes: readonly string[]): boolean {
  return !scopes.includes('management') || scopes.includes('delete');
}

function callerOf(actor: VerifiedActor, kind: 'assistant' | 'app'): McpCaller {
  const claims = actor.claims;
  return Object.freeze({
    kind: actor.kind,
    id: actor.id,
    userId: actor.personId,
    workspaceId: actor.workspaceId,
    role: actor.role,
    privileges: actor.privileges,
    scopes: actor.scopes,
    mayDelete: scopesAllowDelete(actor.scopes),
    client: Object.freeze({ id: stringClaim(claims, 'client_id') ?? stringClaim(claims, 'azp'), kind }),
    appId: actor.appId,
    sessionId: actor.credential.sessionId,
    email: stringClaim(claims, 'email'),
    standing: stringClaim(claims, 'wst'),
    expiresAt: actor.credential.expiresAt,
    actor,
  });
}

/**
 * The guard in MCP mode for one endpoint of one app.
 *
 * ```ts
 * const guard = bridgeMcpGuard({ issuer, resource: 'https://acme.example/mcp' });
 * const answer = await guard.check(request);
 * if (!answer.ok) return guard.refusalResponse(answer.refusal);
 * answer.caller.userId; answer.caller.workspaceId; answer.caller.privileges;
 * ```
 */
export function bridgeMcpGuard(options: McpGuardOptions): McpGuard {
  if (!options) throw new BridgeError('misconfigured', 'bridgeMcpGuard: options are required.');
  const doc = protectedResourceMetadata(options);
  const resource = doc.resource;
  const metadataUrl = protectedResourceMetadataUrl(resource);
  const metadataPaths = protectedResourceMetadataPaths(resource);
  const acceptAppTokens = options.acceptAppTokens ?? true;
  const log = options.log ?? (() => {});
  const fetchFn = options.fetch ?? platformFetch();
  const guardedFetch = withoutRedirects(fetchFn);
  const discovery = new Discovery(options.issuer, fetchFn, { retryMinMs: options.discoveryRetryMs ?? 1000 });

  let forEndpoint: CredentialVerifier | null = null;
  let forApp: CredentialVerifier | null = null;
  let puller: RevocationPuller | null = null;
  let settingUp: Promise<void> | null = null;

  async function build(): Promise<void> {
    const found = (await discovery.get()).metadata;
    if (forEndpoint !== null) return;
    const audience = found.audience ?? options.audience;
    if (acceptAppTokens && (audience === undefined || audience === '')) {
      throw new BridgeError('misconfigured', "The issuer's metadata does not name the app's access tokens' audience: pass `audience`.");
    }
    if (audience === resource) {
      throw new BridgeError('misconfigured', "The MCP endpoint's address is the app's own token audience; give the endpoint its own address.");
    }
    const jwksUrl = found.endpoints.jwks;
    if (jwksUrl === undefined) throw new BridgeError('misconfigured', "The issuer's metadata lists no key set (jwks).");
    const lanes: Record<string, string> = {};
    for (const lane of REVOCATION_LANES) {
      const url = found.revocationLanes[lane];
      if (url === undefined) throw new BridgeError('misconfigured', `The issuer's metadata lists no "${lane}" lane of the revocation list.`);
      lanes[lane] = url;
    }
    // One key set and one revocation list for both checks: the keys are fetched once, the list followed once.
    const keySet = createKeySet({ url: jwksUrl, fetch: guardedFetch });
    const made = createRevocationPuller({
      appId: found.appId,
      lanes,
      keySet,
      fetch: guardedFetch,
      ...(options.maxLagMs === undefined ? {} : { maxLagMs: options.maxLagMs }),
      ...(options.revocationIntervalMs === undefined ? {} : { intervalMs: options.revocationIntervalMs }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }).start();
    const common = { appId: found.appId, issuer: found.issuer, keySet, revocationCheck: made.check, fetch: guardedFetch, ...(options.log === undefined ? {} : { log: options.log }) };
    forEndpoint = createCredentialVerifier({ ...common, audience: resource });
    forApp = acceptAppTokens && audience !== undefined ? createCredentialVerifier({ ...common, audience }) : null;
    puller = made;
  }

  function setUp(): Promise<void> {
    if (forEndpoint !== null) return Promise.resolve();
    settingUp ??= build().finally(() => {
      settingUp = null;
    });
    return settingUp;
  }

  const ready = setUp();
  ready.catch(() => undefined);

  function refusal(status: 401 | 503, reason: string, description: string, tokenCame: boolean): { ok: false; refusal: McpRefusal } {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (status === 401) headers['WWW-Authenticate'] = mcpChallenge(metadataUrl, tokenCame ? { description } : undefined);
    else headers['Retry-After'] = '5';
    const error = status === 503 ? 'temporarily_unavailable' : tokenCame ? 'invalid_token' : 'unauthorized';
    return { ok: false, refusal: Object.freeze({ status, headers: Object.freeze(headers), body: Object.freeze({ error, error_description: description }), reason }) };
  }

  function fromVerification(verification: Verification & { ok: false }): { ok: false; refusal: McpRefusal } {
    const { reason, message } = verification.refusal;
    if (reason === 'unavailable') return refusal(503, reason, message, true);
    return refusal(401, reason, message, true);
  }

  async function checkToken(token: string | null | undefined): Promise<McpCheck> {
    if (typeof token !== 'string' || token === '') {
      return refusal(401, 'missing', 'Sign in to use this endpoint: its metadata names where.', false);
    }
    try {
      await setUp();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return refusal(503, 'unavailable', `Tokens cannot be checked yet: ${reason}`, true);
    }
    const first = await (forEndpoint as CredentialVerifier).verify({ type: 'token', value: token });
    if (first.ok) {
      // An assistant always acts for a person.
      if (first.actor.kind !== 'person') return refusal(401, 'wrong_type', 'This kind of token is not accepted here.', true);
      log('MCP call by an assistant', { appId: first.actor.appId });
      return { ok: true, caller: callerOf(first.actor, 'assistant'), token };
    }
    // Issued for some other audience: it may be one of the app's own tokens.
    if (first.refusal.reason === 'wrong_audience' && forApp !== null) {
      const second = await forApp.verify({ type: 'token', value: token });
      if (second.ok) return { ok: true, caller: callerOf(second.actor, 'app'), token };
      if (second.refusal.reason === 'wrong_audience') return refusal(401, 'wrong_audience', 'The token was issued for another endpoint.', true);
      return fromVerification(second);
    }
    return fromVerification(first);
  }

  function refusalResponse(answer: McpRefusal): Response {
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { ...answer.headers, ...CORS } });
  }

  function metadataResponse(): Response {
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS },
    });
  }

  function isMetadataRequest(request: { readonly method?: string | undefined; readonly url?: string | undefined }): boolean {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const path = pathOf(request.url);
    return path !== null && metadataPaths.includes(path.replace(/\/+$/, '') || '/');
  }

  return {
    ready,
    resource,
    metadataUrl,
    metadataPaths,
    metadata: () => doc,
    isMetadataRequest,
    metadataResponse,
    metadataHandler: () => () => metadataResponse(),
    check: (request) => checkToken(bearerOf(request.headers)),
    checkToken,
    refusalResponse,
    protect(handler) {
      return async (request: Request): Promise<Response> => {
        if (isMetadataRequest(request)) return metadataResponse();
        if (request.method.toUpperCase() === 'OPTIONS') {
          return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' } });
        }
        const answer = await checkToken(bearerOf(request.headers));
        if (!answer.ok) return refusalResponse(answer.refusal);
        return handler(request, answer.caller);
      };
    },
    status: () => puller?.status() ?? null,
    async close() {
      puller?.stop();
    },
  };
}
