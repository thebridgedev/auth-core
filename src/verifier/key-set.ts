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

/** How long a remote key set client is reused before it is created again. */
export const DEFAULT_KEY_SET_TTL_MS = 60 * 60 * 1000;

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

/**
 * Resolve the key a token was signed with, from the app's key set.
 *
 * A remote key set is fetched on first use and kept; an unknown key id makes
 * it fetch again (key rotation), at most once per cooldown. The client itself
 * is created again after `ttlMs`, so a long-running process never holds on to
 * a stale set forever.
 */
export function createKeySetResolver(source: KeySetSource): () => JWTVerifyGetKey {
  if (source.keys) {
    const local = createLocalJWKSet(source.keys);
    return () => local;
  }
  if (!source.url) {
    throw new TypeError('A key set URL or a key set is required to check tokens.');
  }

  const urlText = source.url;
  const ttlMs = source.ttlMs ?? DEFAULT_KEY_SET_TTL_MS;
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
