import { BridgeError } from './errors.js';
import { call, type Fetch } from './http.js';
import { secureUrl } from './urls.js';
import {
  API_VERSION,
  CONTRACT_PATHS,
  REVOCATION_LANES,
  fillPath,
  type EndpointName,
  type RevocationLane,
  type Route,
} from './routes.js';

/**
 * Discovery: the issuer is the only address the SDK is given. Everything
 * else comes from the issuer's metadata at
 * `<issuer>/.well-known/openid-configuration`, which lists the endpoints of
 * each version of Bridge's API under `bridge_endpoints`. The SDK reads only
 * version 2 and refuses to start without it, so a later version never
 * changes what this SDK calls.
 */

/** What the SDK reads from the issuer's metadata. */
export interface IssuerMetadata {
  /** The issuer, exactly as its metadata names it. */
  readonly issuer: string;
  /** The app the issuer signs in to. */
  readonly appId: string;
  /** The audience Bridge's access tokens name, for servers that check them; null when the metadata does not say. */
  readonly audience: string | null;
  /** Each endpoint's address at version 2 of Bridge's API. */
  readonly endpoints: Readonly<Partial<Record<EndpointName, string>>>;
  /** Each lane of the app's revocation list, for servers that check tokens. */
  readonly revocationLanes: Readonly<Partial<Record<RevocationLane, string>>>;
  /** True when the endpoints were worked out from the standard fields because the metadata lists none (see below). */
  readonly derived: boolean;
  /** The sign-in page Bridge hosts for the app, ending in `/`, when the app registered it; null otherwise. */
  readonly signInPage: string | null;
}

/** The issuer's endpoints, ready to call. */
export interface Endpoints {
  readonly metadata: IssuerMetadata;
  /** Whether the issuer offers this route. */
  offers(route: Route): boolean;
  /** The route's address. Throws `not-offered` when the issuer does not list its endpoint. */
  url(route: Route, params?: Readonly<Record<string, string>>, query?: Readonly<Record<string, string | undefined>>): string;
}

const STANDARD_FIELDS: Readonly<Partial<Record<EndpointName, string>>> = {
  sign_in: 'authorization_challenge_endpoint',
  token: 'token_endpoint',
  revoke: 'revocation_endpoint',
  introspect: 'introspection_endpoint',
  jwks: 'jwks_uri',
};

const ENDPOINT_NAMES = Object.keys(CONTRACT_PATHS) as EndpointName[];

/** A hosted page's address: https (http only on this machine), ending in `/`, with no query or fragment. */
function pageUrl(value: unknown): string | null {
  const url = absoluteUrl(value);
  if (url === null || typeof value !== 'string' || !value.endsWith('/') || value.includes('?') || value.includes('#')) return null;
  return value;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Every address the metadata gives must be https (http only on this machine, for development). */
function absoluteUrl(value: unknown): string | null {
  return secureUrl(value, 'https:');
}

function misconfigured(message: string): BridgeError {
  return new BridgeError('misconfigured', message);
}

/** An address the metadata lists: null when it lists none, refused when it lists one that is not https. */
function listedUrl(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const url = absoluteUrl(value);
  if (url === null) throw misconfigured(`The issuer's metadata lists "${name}" at an address that is not https: ${String(value)}.`);
  return url;
}

/** The metadata document's address for an issuer. */
export function metadataUrl(issuer: string): string {
  return `${trimSlash(issuer)}/.well-known/openid-configuration`;
}

/** Reads the issuer's metadata. Refuses an issuer that does not name itself, or offers no version 2. */
export function readMetadata(issuer: string, document: unknown): IssuerMetadata {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw misconfigured(`The issuer's metadata at ${metadataUrl(issuer)} is not a JSON object.`);
  }
  const doc = document as Record<string, unknown>;
  // OpenID Connect Discovery 1.0, 4.3: the metadata must name the issuer it was fetched for.
  if (typeof doc['issuer'] !== 'string' || trimSlash(doc['issuer']) !== trimSlash(issuer)) {
    throw misconfigured(`The issuer's metadata names "${String(doc['issuer'])}", not the issuer it was fetched for (${issuer}).`);
  }
  const named = doc['issuer'];
  const published = doc['bridge_endpoints'];
  if (published === undefined) return derivedMetadata(named, doc);

  const versions = published !== null && typeof published === 'object' ? (published as Record<string, unknown>) : {};
  const v2 = versions[API_VERSION];
  if (v2 === null || typeof v2 !== 'object') {
    const offered = Object.keys(versions).join(', ') || 'none';
    throw misconfigured(`The issuer does not offer version ${API_VERSION} of Bridge's API, which this SDK speaks (it offers: ${offered}).`);
  }
  const listed = v2 as Record<string, unknown>;
  // Version 2's own copy of the standard endpoints comes first. The standard fields point at the version
  // `bridge_api_version` names: they stand in, for an issuer that lists no copy, only when that is 2.
  const standardIsV2 = doc['bridge_api_version'] === undefined || String(doc['bridge_api_version']) === API_VERSION;
  const endpoints: Partial<Record<EndpointName, string>> = {};
  for (const name of ENDPOINT_NAMES) {
    const standard = standardIsV2 ? STANDARD_FIELDS[name] : undefined;
    const url = listedUrl(listed[name], name) ?? (standard === undefined ? null : listedUrl(doc[standard], standard));
    if (url !== null) endpoints[name] = url;
  }
  const appId = doc['bridge_app'];
  if (typeof appId !== 'string' || appId === '') throw misconfigured("The issuer's metadata does not name its app (bridge_app).");
  for (const required of ['sign_in', 'token', 'accounts'] as const) {
    if (endpoints[required] === undefined) throw misconfigured(`The issuer's metadata lists no "${required}" endpoint for version ${API_VERSION}.`);
  }
  const lanes: Partial<Record<RevocationLane, string>> = {};
  const givenLanes = doc['bridge_revocation_lanes'];
  if (givenLanes !== null && typeof givenLanes === 'object') {
    for (const lane of REVOCATION_LANES) {
      const url = listedUrl((givenLanes as Record<string, unknown>)[lane], `${lane} lane`);
      if (url !== null) lanes[lane] = url;
    }
  }
  const audience = doc['bridge_access_token_audience'];
  return Object.freeze({
    issuer: named,
    appId,
    audience: typeof audience === 'string' && audience !== '' ? audience : null,
    endpoints: Object.freeze(endpoints),
    revocationLanes: Object.freeze(lanes),
    derived: false,
    signInPage: pageUrl(listed['sign_in_page']),
  });
}

/**
 * FALLBACK, for an issuer whose metadata does not list `bridge_endpoints`
 * yet. Remove once every issuer publishes the full list.
 *
 * The standard fields already point at version 2 of the API
 * (`…/v2/identity-access/apps/<app>/token`). Every other endpoint is worked
 * out from where the token endpoint is, using the paths of Bridge's API
 * contract. Endpoints Bridge does not serve yet are left out, so the SDK
 * answers `not-offered` for them. The audience is not in the standard
 * fields: a server must be given it.
 */
function derivedMetadata(issuer: string, doc: Readonly<Record<string, unknown>>): IssuerMetadata {
  const tokenEndpoint = listedUrl(doc['token_endpoint'], 'token_endpoint');
  const match = tokenEndpoint?.match(/^(.*\/v2)\/identity-access\/apps\/([^/]+)\/token$/);
  if (tokenEndpoint === null || tokenEndpoint === undefined || match === null || match === undefined) {
    throw misconfigured(`The issuer's metadata lists no version ${API_VERSION} endpoints (bridge_endpoints), and its token endpoint is not one this SDK can work them out from.`);
  }
  const root = match[1].slice(0, -'/v2'.length);
  const appId = decodeURIComponent(match[2]);
  const at = (path: string) => root + path.replace('{appId}', encodeURIComponent(appId));
  const endpoints: Partial<Record<EndpointName, string>> = {};
  for (const name of ENDPOINT_NAMES) {
    const standard = STANDARD_FIELDS[name];
    const url = standard === undefined ? null : listedUrl(doc[standard], standard);
    endpoints[name] = url ?? at(CONTRACT_PATHS[name]);
  }
  // An issuer that publishes no endpoint list predates these: refused as `not-offered` rather than called.
  for (const pending of ['sign_in_options', 'invites', 'invite_preview', 'live_connection', 'sign_in_requests'] as const) delete endpoints[pending];
  const lanes: Partial<Record<RevocationLane, string>> = {};
  for (const lane of REVOCATION_LANES) {
    lanes[lane] = at(`/v2/${lane}/apps/{appId}/revocations/${lane}`);
  }
  return Object.freeze({ issuer, appId, audience: null, endpoints: Object.freeze(endpoints), revocationLanes: Object.freeze(lanes), derived: true, signInPage: null });
}

export function endpointsFrom(metadata: IssuerMetadata): Endpoints {
  return Object.freeze({
    metadata,
    offers: (route: Route) => metadata.endpoints[route.at] !== undefined,
    url(route: Route, params?: Readonly<Record<string, string>>, query?: Readonly<Record<string, string | undefined>>) {
      const base = metadata.endpoints[route.at];
      if (base === undefined) {
        throw new BridgeError('not-offered', `This issuer does not offer ${route.pending ?? `the "${route.at}" endpoint`} yet.`);
      }
      const url = base + fillPath(route.path, params);
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) search.set(name, value);
      const encoded = search.toString();
      return encoded === '' ? url : `${url}?${encoded}`;
    },
  });
}

/** Fetches and reads the issuer's metadata. */
export async function discover(issuer: string, fetchFn: Fetch): Promise<Endpoints> {
  if (absoluteUrl(issuer) === null) throw misconfigured(`The issuer must be an https address (http only on localhost); got "${issuer}".`);
  const answer = await call<unknown>(fetchFn, metadataUrl(issuer), { method: 'GET' });
  return endpointsFrom(readMetadata(issuer, answer.body));
}

export interface DiscoveryOptions {
  /** The first wait after a failed read. @default 1000 */
  readonly retryMinMs?: number;
  /** The longest wait between reads. @default 60000 */
  readonly retryMaxMs?: number;
  readonly now?: () => number;
}

/**
 * The issuer's metadata, read once it can be. A failed read is never kept:
 * the next call reads again, waiting longer after each failure, so a client
 * started while Bridge was briefly unreachable recovers on its own. Within
 * the wait, calls fail at once with the last error rather than asking again.
 */
export class Discovery {
  private endpoints: Endpoints | null = null;
  private inflight: Promise<Endpoints> | null = null;
  private lastError: unknown = null;
  private nextTryAt = 0;
  private waitMs: number;
  private readonly now: () => number;

  constructor(
    private readonly issuer: string,
    private readonly fetchFn: Fetch,
    private readonly options: DiscoveryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.waitMs = options.retryMinMs ?? 1000;
  }

  /** The endpoints, once read; null before. */
  current(): Endpoints | null {
    return this.endpoints;
  }

  /** How long until the next read may be tried, in ms. 0 when it may be tried now. */
  retryInMs(): number {
    return Math.max(0, this.nextTryAt - this.now());
  }

  /** The endpoints, reading them when they are not held. `now` reads even within the wait (a person just asked for something). */
  get(options: { readonly now?: boolean } = {}): Promise<Endpoints> {
    if (this.endpoints !== null) return Promise.resolve(this.endpoints);
    if (this.inflight !== null) return this.inflight;
    if (!options.now && this.lastError !== null && this.now() < this.nextTryAt) return Promise.reject(this.lastError);
    this.inflight = discover(this.issuer, this.fetchFn)
      .then((endpoints) => {
        this.endpoints = endpoints;
        this.lastError = null;
        return endpoints;
      })
      .catch((error: unknown) => {
        this.lastError = error;
        this.nextTryAt = this.now() + this.waitMs;
        this.waitMs = Math.min(this.options.retryMaxMs ?? 60_000, this.waitMs * 2);
        throw error;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
