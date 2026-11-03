import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * The only algorithm The Bridge signs access tokens with.
 *
 * Pinned on the verifier because the published keys carry no `alg` of their
 * own: left unpinned, a verifier accepts any algorithm the key type supports,
 * which is the algorithm-confusion class of attack. Pinning also refuses
 * unsigned tokens (`alg: none`) and HMAC tokens made with a public key.
 */
export const BRIDGE_TOKEN_ALGORITHMS: readonly string[] = Object.freeze(['PS256']);

/** How long a loaded key set is used before it is fetched again. */
export const DEFAULT_KEY_SET_MAX_AGE_MS = 10 * 60 * 1000;
/** The shortest time between two fetches of one key set. */
export const DEFAULT_KEY_SET_COOLDOWN_MS = 30 * 1000;
/** After a fetch that failed before any key was loaded, how long until the next try. */
const RETRY_AFTER_FAILURE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

/** Error codes a key set rejects with. Codes, not classes, so they hold across bundles. */
export const KEY_SET_NOT_FOUND = 'ERR_BRIDGE_KEY_SET_NOT_FOUND';
export const KEY_SET_UNAVAILABLE = 'ERR_BRIDGE_KEY_SET_UNAVAILABLE';

class KeySetError extends Error {
  constructor(
    readonly code: typeof KEY_SET_NOT_FOUND | typeof KEY_SET_UNAVAILABLE,
    message: string,
  ) {
    super(message);
    this.name = 'KeySetError';
  }
}

export interface KeySetOptions {
  /** Where the app's public keys are published (a JSON Web Key Set URL). */
  url?: string;
  /** The key set itself, instead of a URL. Never fetched. */
  keys?: JSONWebKeySet;
  /** The fetch to load a remote key set with. @default the global fetch */
  fetch?: typeof fetch;
  /**
   * How long a loaded key set is used before it is fetched again, so a key
   * taken out of the set stops being accepted.
   * @default 600000 (10 minutes)
   */
  maxAgeMs?: number;
  /**
   * The shortest time between two fetches. A token or entry that names a key
   * id the set does not hold makes it fetch again (a rotated key), but never
   * sooner than this, however many such tokens arrive.
   * @default 30000
   */
  cooldownMs?: number;
  /** How long to wait for the key set. @default 5000 */
  timeoutMs?: number;
  /** The clock, in milliseconds. For tests. @default Date.now */
  now?: () => number;
}

/**
 * One app's published public keys, fetched once and shared by everything
 * that checks a signature for that app: the credential verifier and the
 * revocation puller.
 */
export interface KeySet {
  /**
   * The published keys. Fetched on first use, then again when older than
   * `maxAgeMs` or when `kid` names a key the set does not hold, never more
   * than once per `cooldownMs`. While a fetch fails, the keys loaded before
   * keep being used.
   *
   * Rejects with an error whose `code` is `ERR_BRIDGE_KEY_SET_NOT_FOUND` when
   * the issuer answers that there is no such key set (404 or 410), and
   * `ERR_BRIDGE_KEY_SET_UNAVAILABLE` when no keys could be loaded.
   */
  keys(kid?: string): Promise<JSONWebKeySet>;
  /** The key a token was signed with, in the form `jwtVerify` takes. */
  readonly getKey: JWTVerifyGetKey;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function holds(set: JSONWebKeySet | null, kid: string): boolean {
  return set !== null && set.keys.some((key) => key.kid === kid);
}

/**
 * Create one app's key set. Pass the same key set to the verifier and the
 * revocation puller (their `keySet` option) so the keys are fetched once.
 */
export function createKeySet(options: KeySetOptions): KeySet {
  if (options.keys) {
    const fixed = options.keys;
    const local = createLocalJWKSet(fixed);
    return { keys: async () => fixed, getKey: (header, token) => local(header, token) };
  }
  if (typeof options.url !== 'string' || options.url.length === 0) {
    throw new TypeError('A key set URL or a key set is required to check signatures.');
  }

  const url = options.url;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_KEY_SET_MAX_AGE_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_KEY_SET_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.now ?? (() => Date.now());
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  let current: JSONWebKeySet | null = null;
  let local: JWTVerifyGetKey | null = null;
  let notFound = false;
  let loadedAt = -Infinity;
  let attemptedAt = -Infinity;
  let loading: Promise<void> | null = null;

  function load(): Promise<void> {
    if (loading) return loading;
    attemptedAt = clock();
    loading = (async () => {
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: timeoutSignal(timeoutMs),
        });
        if (response.status === 404 || response.status === 410) {
          current = null;
          local = null;
          notFound = true;
          return;
        }
        if (!response.ok) throw new Error(`the key set answered ${response.status}`);
        const body = (await response.json()) as JSONWebKeySet;
        const resolver = createLocalJWKSet(body);
        current = body;
        local = resolver;
        notFound = false;
        loadedAt = clock();
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function keys(kid?: string): Promise<JSONWebKeySet> {
    if (loading) {
      await loading.catch(() => undefined);
    } else {
      const now = clock();
      const due = now - attemptedAt >= cooldownMs;
      const fetchNow =
        current === null
          ? notFound
            ? due
            : now - attemptedAt >= RETRY_AFTER_FAILURE_MS
          : due && (now - loadedAt > maxAgeMs || (kid !== undefined && !holds(current, kid)));
      if (fetchNow) {
        // A failed fetch keeps the keys loaded before; without any, the check below rejects.
        await load().catch(() => undefined);
      }
    }
    if (notFound) throw new KeySetError(KEY_SET_NOT_FOUND, 'No keys are published for this app.');
    if (current === null) throw new KeySetError(KEY_SET_UNAVAILABLE, "The app's signing keys could not be loaded.");
    return current;
  }

  return {
    keys,
    async getKey(header, token) {
      await keys(typeof header.kid === 'string' ? header.kid : undefined);
      // `keys` resolved, so a key set is loaded and `local` matches it.
      return (local as JWTVerifyGetKey)(header, token);
    },
  };
}

export interface KeySetSource {
  /** Where the app's public signing keys are published (a JSON Web Key Set). */
  url?: string;
  /** The key set itself, instead of a URL. */
  keys?: JSONWebKeySet;
  /** How long a remote key set client is reused. @default 1 hour */
  ttlMs?: number;
  /** The fetch to load a remote key set with. @default the global fetch */
  fetch?: typeof fetch;
}

const LEGACY_KEY_SET_TTL_MS = 60 * 60 * 1000;

/**
 * The key resolver of the deprecated `JwksService`, kept as it was so that
 * class behaves exactly as before. New code uses `createKeySet`.
 */
export function createKeySetResolver(source: KeySetSource): () => JWTVerifyGetKey {
  if (source.keys) {
    const fixed = createLocalJWKSet(source.keys);
    return () => fixed;
  }
  if (!source.url) {
    throw new TypeError('A key set URL or a key set is required to check tokens.');
  }

  const urlText = source.url;
  const ttlMs = source.ttlMs ?? LEGACY_KEY_SET_TTL_MS;
  const fetchImpl = source.fetch;
  let remote: JWTVerifyGetKey | null = null;
  let createdAt = 0;

  return () => {
    const now = Date.now();
    if (!remote || now - createdAt > ttlMs) {
      // Parsed on first use, so a misconfigured URL fails a check, not construction.
      const url = new URL(urlText);
      remote = fetchImpl
        ? createRemoteJWKSet(url, {
            [customFetch]: (input: string | URL, init?: RequestInit) => fetchImpl(input, init),
          })
        : createRemoteJWKSet(url);
      createdAt = now;
    }
    return remote;
  };
}
