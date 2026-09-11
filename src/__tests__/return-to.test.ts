import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_RETURN_TO_PARAM,
  RETURN_TO_STORAGE_KEY,
  readReturnTo,
  sanitizeReturnTo,
  stashReturnTo,
  takeReturnTo,
  withReturnTo,
} from '../return-to.js';

// Regression: SDK-mode route guard dropped the attempted URL, so every protected
// deep link collapsed to the app's default route after login (TBP-629). The value
// travels in the URL, so it is attacker-controllable on both the write and the
// read side — these tests exist to keep it from becoming an open redirect.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The real-world case that prompted the ticket: an emailed deep link. */
const DEEP_LINK = '/incident-exported-file/KEY/IV/incident/123';

/**
 * Every hostile input is paired with a `safeTwin` — a value the SAME mechanism
 * must still accept. Without the twin, a `sanitizeReturnTo` that returned null
 * unconditionally would pass the whole table, and the tests would be proving
 * nothing.
 */
const HOSTILE: Array<{ label: string; input: string; safeTwin: string }> = [
  { label: 'absolute https URL', input: 'https://evil.test/x', safeTwin: '/x' },
  { label: 'absolute http URL', input: 'http://evil.test', safeTwin: '/evil.test' },
  { label: 'protocol-relative //', input: '//evil.test/x', safeTwin: '/evil.test/x' },
  { label: 'backslash-relative /\\', input: '/\\evil.test', safeTwin: '/evil.test' },
  { label: 'double backslash', input: '\\\\evil.test', safeTwin: '/evil.test' },
  { label: 'backslash mid-path', input: '/path\\back', safeTwin: '/path/back' },
  { label: 'javascript: scheme', input: 'javascript:alert(1)', safeTwin: '/alert' },
  { label: 'data: scheme', input: 'data:text/html,x', safeTwin: '/text/html,x' },
  { label: 'relative path', input: 'relative/path', safeTwin: '/relative/path' },
  { label: 'empty string', input: '', safeTwin: '/a' },
  { label: 'whitespace only', input: '   ', safeTwin: '/a' },
  { label: 'embedded LF', input: '/a\nb', safeTwin: '/ab' },
  { label: 'embedded CR', input: '/a\rb', safeTwin: '/ab' },
  { label: 'embedded TAB', input: '/a\tb', safeTwin: '/ab' },
  { label: 'embedded NUL', input: '/a\u0000b', safeTwin: '/ab' },
  { label: 'embedded DEL', input: '/a\u007fb', safeTwin: '/ab' },
];

/** Values that must survive byte-for-byte — the whole point of the feature. */
const SAFE: string[] = [
  '/a',
  '/a/b?c=d&e=f',
  DEEP_LINK,
  '/files/report%20final.pdf',
  '/search?q=%2Fetc%2Fpasswd&page=2',
  '/a/b/',
];

// ---------------------------------------------------------------------------
// sanitizeReturnTo
// ---------------------------------------------------------------------------

describe('sanitizeReturnTo', () => {
  describe('rejects untrusted values', () => {
    for (const { label, input, safeTwin } of HOSTILE) {
      it(`rejects ${label} (${JSON.stringify(input)}) while still accepting its safe twin`, () => {
        expect(sanitizeReturnTo(input)).toBeNull();
        // Paired positive on the same mechanism: a blanket `return null` fails here.
        expect(sanitizeReturnTo(safeTwin)).toBe(safeTwin);
      });
    }

    it('rejects non-string inputs while still accepting a string path', () => {
      const nonStrings: unknown[] = [null, undefined, 123, 0, true, false, {}, [], () => '/a'];
      for (const value of nonStrings) {
        expect(sanitizeReturnTo(value as string)).toBeNull();
      }
      expect(sanitizeReturnTo('/a')).toBe('/a');
    });
  });

  describe('accepts same-origin paths verbatim', () => {
    for (const value of SAFE) {
      it(`returns ${JSON.stringify(value)} unchanged`, () => {
        expect(sanitizeReturnTo(value)).toBe(value);
      });
    }

    it('trims surrounding whitespace rather than rejecting the path', () => {
      expect(sanitizeReturnTo(`  ${DEEP_LINK}  `)).toBe(DEEP_LINK);
    });
  });
});

// ---------------------------------------------------------------------------
// withReturnTo
// ---------------------------------------------------------------------------

describe('withReturnTo', () => {
  it('appends the return target with ? when the login route has no query', () => {
    expect(withReturnTo('/login', '/dashboard')).toBe(
      `/login?${DEFAULT_RETURN_TO_PARAM}=%2Fdashboard`,
    );
  });

  it('appends with & when the login route already carries a query', () => {
    const url = withReturnTo('/login?mode=sso', '/dashboard');
    expect(url).toBe(`/login?mode=sso&${DEFAULT_RETURN_TO_PARAM}=%2Fdashboard`);
    // The existing query must survive, not be replaced.
    expect(new URL(url, 'https://app.test').searchParams.get('mode')).toBe('sso');
  });

  it('URL-encodes the value so a query in the deep link cannot break out', () => {
    const url = withReturnTo('/login', '/a/b?c=d&e=f');
    expect(url).toBe(`/login?${DEFAULT_RETURN_TO_PARAM}=%2Fa%2Fb%3Fc%3Dd%26e%3Df`);
    // And it decodes back to exactly what went in — encoding, not mangling.
    expect(new URL(url, 'https://app.test').searchParams.get(DEFAULT_RETURN_TO_PARAM)).toBe(
      '/a/b?c=d&e=f',
    );
  });

  it('honours a custom param name', () => {
    expect(withReturnTo('/login', '/dashboard', 'next')).toBe('/login?next=%2Fdashboard');
    // …and does not also write the default name.
    expect(withReturnTo('/login', '/dashboard', 'next')).not.toContain(DEFAULT_RETURN_TO_PARAM);
  });

  it('returns the login route untouched for hostile or empty values', () => {
    for (const { input } of HOSTILE) {
      expect(withReturnTo('/login', input)).toBe('/login');
    }
    expect(withReturnTo('/login', null)).toBe('/login');
    expect(withReturnTo('/login', undefined)).toBe('/login');
    // Paired positive: the same call DOES append when the value is safe.
    expect(withReturnTo('/login', DEEP_LINK)).toBe(
      `/login?${DEFAULT_RETURN_TO_PARAM}=${encodeURIComponent(DEEP_LINK)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// readReturnTo
// ---------------------------------------------------------------------------

describe('readReturnTo', () => {
  it('round-trips a value written by withReturnTo', () => {
    const loginUrl = withReturnTo('/login', DEEP_LINK);
    expect(readReturnTo(loginUrl.slice(loginUrl.indexOf('?')))).toBe(DEEP_LINK);
  });

  it('reads from a URL object', () => {
    const url = new URL(`https://app.test/login?${DEFAULT_RETURN_TO_PARAM}=%2Fdashboard`);
    expect(readReturnTo(url)).toBe('/dashboard');
  });

  it('reads from URLSearchParams', () => {
    const params = new URLSearchParams({ [DEFAULT_RETURN_TO_PARAM]: DEEP_LINK });
    expect(readReturnTo(params)).toBe(DEEP_LINK);
  });

  it('reads from a full href string', () => {
    expect(
      readReturnTo(`https://app.test/login?${DEFAULT_RETURN_TO_PARAM}=%2Fa%2Fb%3Fc%3Dd`),
    ).toBe('/a/b?c=d');
  });

  it('reads from a bare query string with a leading ?', () => {
    expect(readReturnTo(`?${DEFAULT_RETURN_TO_PARAM}=%2Fdashboard`)).toBe('/dashboard');
  });

  it('reads from a bare query string without a leading ?', () => {
    expect(readReturnTo(`${DEFAULT_RETURN_TO_PARAM}=%2Fdashboard`)).toBe('/dashboard');
  });

  it('honours a custom param name', () => {
    expect(readReturnTo('?next=%2Fdashboard', 'next')).toBe('/dashboard');
    // The default name must not be read when a custom one was asked for.
    expect(readReturnTo('?next=%2Fdashboard')).toBeNull();
  });

  it('returns null when the param is absent, and the value when present', () => {
    expect(readReturnTo('?other=1')).toBeNull();
    expect(readReturnTo(new URL('https://app.test/login'))).toBeNull();
    expect(readReturnTo(null)).toBeNull();
    expect(readReturnTo(undefined)).toBeNull();
    expect(readReturnTo('')).toBeNull();
    expect(readReturnTo(`?${DEFAULT_RETURN_TO_PARAM}=%2Fdashboard`)).toBe('/dashboard');
  });

  // This is the one that matters: the reader must validate independently of the
  // writer, because the URL a login page loads with was written by whoever sent
  // the link — not necessarily by withReturnTo.
  describe('validates hostile values already present in the URL', () => {
    for (const { label, input, safeTwin } of HOSTILE) {
      it(`refuses ${label} planted in the query while still reading its safe twin`, () => {
        const hostileUrl = new URL(
          `https://app.test/login?${DEFAULT_RETURN_TO_PARAM}=${encodeURIComponent(input)}`,
        );
        expect(readReturnTo(hostileUrl)).toBeNull();

        const safeUrl = new URL(
          `https://app.test/login?${DEFAULT_RETURN_TO_PARAM}=${encodeURIComponent(safeTwin)}`,
        );
        expect(readReturnTo(safeUrl)).toBe(safeTwin);
      });
    }

    it('refuses a raw, unencoded absolute URL planted in the query', () => {
      expect(readReturnTo(`?${DEFAULT_RETURN_TO_PARAM}=https://evil.test/x`)).toBeNull();
      expect(readReturnTo(`?${DEFAULT_RETURN_TO_PARAM}=/x`)).toBe('/x');
    });
  });
});

// ---------------------------------------------------------------------------
// Exported vocabulary
// ---------------------------------------------------------------------------

describe('DEFAULT_RETURN_TO_PARAM', () => {
  it('matches hosted mode’s redirectUri vocabulary', () => {
    expect(DEFAULT_RETURN_TO_PARAM).toBe('redirectUri');
  });
});

// ---------------------------------------------------------------------------
// Hosted-mode sessionStorage handoff
// ---------------------------------------------------------------------------

// Hosted mode cannot use the query parameter: `createLoginUrl()` feeds
// `redirectUri` into the OAuth authorize call and bridge-api validates it with
// `appConfig.allowedRedirectUris.includes(redirect_uri)` — an exact string
// match — so appending anything would break login outright (TBP-629).

type StorageFake = {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

/**
 * A real in-memory sessionStorage backed by a Map, so assertions can look at
 * what is actually stored rather than only at call counts. `throwOn` turns any
 * subset of the methods into the Safari-private-mode / disabled-storage case.
 */
function installSessionStorage(throwOn: Array<keyof StorageFake> = []) {
  const store = new Map<string, string>();
  const boom = (name: string) => () => {
    throw new DOMException(`${name} is not available`);
  };
  const storage: StorageFake = {
    getItem: vi.fn(
      throwOn.includes('getItem')
        ? boom('getItem')
        : (key: string) => (store.has(key) ? store.get(key)! : null),
    ),
    setItem: vi.fn(
      throwOn.includes('setItem')
        ? boom('setItem')
        : (key: string, value: string) => {
            store.set(key, value);
          },
    ),
    removeItem: vi.fn(
      throwOn.includes('removeItem')
        ? boom('removeItem')
        : (key: string) => {
            store.delete(key);
          },
    ),
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage,
    writable: true,
    configurable: true,
  });
  return { store, storage };
}

function uninstallSessionStorage() {
  delete (globalThis as unknown as Record<string, unknown>).sessionStorage;
}

describe('RETURN_TO_STORAGE_KEY', () => {
  it('is namespaced like the other Bridge-owned storage entries', () => {
    expect(RETURN_TO_STORAGE_KEY).toBe('bridge_return_to');
  });
});

describe('stashReturnTo / takeReturnTo (hosted mode)', () => {
  // A throwing or stale sessionStorage leaking out of this file would be worse
  // than the coverage gap it was added to close.
  afterEach(() => {
    uninstallSessionStorage();
  });

  it('round-trips a deep link through sessionStorage', () => {
    const { store } = installSessionStorage();
    stashReturnTo('/a/b?c=d');
    expect(store.get(RETURN_TO_STORAGE_KEY)).toBe('/a/b?c=d');
    expect(takeReturnTo()).toBe('/a/b?c=d');
  });

  it('is one-shot: the value is consumed, removed, and re-stashable', () => {
    const { store, storage } = installSessionStorage();

    stashReturnTo(DEEP_LINK);
    expect(takeReturnTo()).toBe(DEEP_LINK);

    // Actually gone from storage — not merely "not returned again". A value
    // left behind would hijack the NEXT login in this tab.
    expect(storage.removeItem).toHaveBeenCalledWith(RETURN_TO_STORAGE_KEY);
    expect(store.has(RETURN_TO_STORAGE_KEY)).toBe(false);
    expect(globalThis.sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull();
    expect(takeReturnTo()).toBeNull();

    // Paired positive: the mechanism still works for the next login, so the
    // nulls above mean "consumed", not "broken".
    stashReturnTo('/reports/42');
    expect(takeReturnTo()).toBe('/reports/42');
  });

  it('never writes a hostile value to storage, while a safe one is stored', () => {
    for (const { label, input, safeTwin } of HOSTILE) {
      const { store, storage } = installSessionStorage();

      stashReturnTo(input);
      expect(store.has(RETURN_TO_STORAGE_KEY), `stored hostile ${label}`).toBe(false);
      expect(storage.setItem, `setItem called for hostile ${label}`).not.toHaveBeenCalled();
      expect(takeReturnTo()).toBeNull();

      // Same mechanism, safe twin: proves the no-op above is the sanitizer
      // refusing, not stashReturnTo being inert.
      stashReturnTo(safeTwin);
      expect(store.get(RETURN_TO_STORAGE_KEY)).toBe(safeTwin);
      expect(takeReturnTo()).toBe(safeTwin);
    }
  });

  it('rejects and clears a hostile value planted directly into storage', () => {
    for (const { label, input } of HOSTILE) {
      const { store } = installSessionStorage();

      // Bypass stashReturnTo entirely — this is tampered/legacy storage.
      store.set(RETURN_TO_STORAGE_KEY, input);
      expect(takeReturnTo(), `accepted planted ${label}`).toBeNull();
      // …and it is still cleared, so it cannot be retried on the next login.
      expect(store.has(RETURN_TO_STORAGE_KEY), `left planted ${label} behind`).toBe(false);

      // Paired positive: a safe value planted the same way IS returned.
      store.set(RETURN_TO_STORAGE_KEY, DEEP_LINK);
      expect(takeReturnTo()).toBe(DEEP_LINK);
    }
  });

  it('swallows a throwing setItem — losing a deep link beats breaking login', () => {
    installSessionStorage(['setItem']);
    expect(() => stashReturnTo(DEEP_LINK)).not.toThrow();
    expect(takeReturnTo()).toBeNull();

    // Paired positive: with healthy storage the same call does store it.
    uninstallSessionStorage();
    const { store } = installSessionStorage();
    stashReturnTo(DEEP_LINK);
    expect(store.get(RETURN_TO_STORAGE_KEY)).toBe(DEEP_LINK);
  });

  it('swallows a throwing getItem and returns null', () => {
    installSessionStorage(['getItem']);
    expect(() => takeReturnTo()).not.toThrow();
    expect(takeReturnTo()).toBeNull();

    uninstallSessionStorage();
    const { store } = installSessionStorage();
    store.set(RETURN_TO_STORAGE_KEY, DEEP_LINK);
    expect(takeReturnTo()).toBe(DEEP_LINK);
  });

  it('swallows a throwing removeItem and returns null', () => {
    const { store } = installSessionStorage(['removeItem']);
    store.set(RETURN_TO_STORAGE_KEY, DEEP_LINK);
    expect(() => takeReturnTo()).not.toThrow();
    // The read cannot be trusted to be one-shot when the clear failed, so the
    // value is withheld rather than handed out uncleared.
    expect(takeReturnTo()).toBeNull();

    uninstallSessionStorage();
    const healthy = installSessionStorage();
    healthy.store.set(RETURN_TO_STORAGE_KEY, DEEP_LINK);
    expect(takeReturnTo()).toBe(DEEP_LINK);
  });

  it('is a no-op under SSR, where sessionStorage does not exist', () => {
    uninstallSessionStorage();
    expect(typeof (globalThis as unknown as Record<string, unknown>).sessionStorage).toBe(
      'undefined',
    );
    expect(() => stashReturnTo(DEEP_LINK)).not.toThrow();
    expect(() => takeReturnTo()).not.toThrow();
    expect(takeReturnTo()).toBeNull();

    // Paired positive: once storage exists, the same two calls work.
    const { store } = installSessionStorage();
    stashReturnTo(DEEP_LINK);
    expect(store.get(RETURN_TO_STORAGE_KEY)).toBe(DEEP_LINK);
    expect(takeReturnTo()).toBe(DEEP_LINK);
  });
});
