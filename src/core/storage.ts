/**
 * Where the SDK keeps what must outlive a page: the refresh token and ID
 * token, a sign-up's PKCE verifier while its email link is on the way, and
 * the visitor's anonymous id. The access token is never stored; it lives in
 * memory only.
 *
 * Every key starts with `bridge:<issuer>:`, so two apps on one origin never
 * share a session.
 */
export interface BridgeStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

/** `localStorage`, when the page has it. Reads and writes that throw (private mode, quota) act as empty. */
export function localStorageAdapter(): BridgeStorage {
  const store = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return store()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        store()?.setItem(key, value);
      } catch {
        // Nothing to keep it in: the session lasts as long as the page.
      }
    },
    remove(key) {
      try {
        store()?.removeItem(key);
      } catch {
        // Nothing stored.
      }
    },
  };
}

/** In memory: for servers, tests and pages that must forget on reload. */
export function memoryStorage(): BridgeStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

/** `localStorage` in a browser, memory anywhere else. */
export function defaultStorage(): BridgeStorage {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined' ? localStorageAdapter() : memoryStorage();
}

export function storageKey(issuer: string, name: string): string {
  return `bridge:${issuer.replace(/\/+$/, '')}:${name}`;
}

export async function readJson<T>(storage: BridgeStorage, key: string): Promise<T | null> {
  const raw = await storage.get(key);
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    await storage.remove(key);
    return null;
  }
}
