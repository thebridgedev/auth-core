/**
 * Which addresses the SDK sends credentials to. Tokens, keys and the
 * issuer's metadata travel only over TLS (`https:`, and `wss:` for Live).
 * Plain `http:` and `ws:` are accepted only for this machine (`localhost`,
 * `127.0.0.1`, `[::1]`), for development.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The address, without a trailing slash, when it is secure for credentials; null otherwise. */
export function secureUrl(value: unknown, scheme: 'https:' | 'wss:' = 'https:'): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  const plain = scheme === 'https:' ? 'http:' : 'ws:';
  if (url.protocol !== scheme && !(url.protocol === plain && LOOPBACK_HOSTS.has(url.hostname))) return null;
  return value.replace(/\/+$/, '');
}

/** The origin of an address, or null when it is not one. */
export function originOf(value: string, base?: string): string | null {
  try {
    return new URL(value, base).origin;
  } catch {
    return null;
  }
}
