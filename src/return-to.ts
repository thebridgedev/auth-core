/**
 * Return-to handling for the SDK-mode route guard (TBP-629).
 *
 * When the guard turns an unauthenticated visitor away from a protected route,
 * the path they asked for has to survive the trip through the login page or the
 * deep link is lost. In SDK mode that means carrying it as a query parameter on
 * the consumer's own login route.
 *
 * A query parameter is the deliberate choice over sessionStorage. Storage has a
 * smaller attack surface — nothing attacker-controllable ever enters the URL —
 * but it does not survive a cross-tab click, and a link mailed to somebody and
 * opened in a fresh tab is the exact case that prompted this. Storage would
 * silently fail at the only job it was hired for.
 *
 * The cost of that choice is that the value is attacker-controllable, so it is
 * untrusted input and this module treats it as such. Consumers should not have
 * to know that: {@link sanitizeReturnTo} is applied on the way in AND on the way
 * out, so a hostile value cannot reach a navigation call even if a consumer
 * forgets to check.
 */

/** Query parameter carrying the return target. Matches hosted mode's `redirectUri`
 *  vocabulary on purpose, so consumers do not learn a second name for one idea. */
export const DEFAULT_RETURN_TO_PARAM = 'redirectUri';

/**
 * Reduce an untrusted return target to a same-origin path, or null.
 *
 * Only same-origin, path-absolute targets survive. Everything else is rejected
 * rather than repaired — a value we have to fix up is a value we do not
 * understand, and "understood well enough to edit" is how open redirects get
 * shipped.
 *
 * Rejected, and why each one matters:
 *
 * | Input | Why |
 * |---|---|
 * | `https://evil.test/x` | absolute URL — classic open redirect |
 * | `//evil.test/x` | protocol-relative; browsers treat it as absolute |
 * | `/\evil.test` , `\\evil.test` | browsers normalise `\` to `/`, so this IS protocol-relative |
 * | `javascript:alert(1)` | scheme payload; no leading `/` so it fails anyway, rejected explicitly for clarity |
 * | `x/y` | relative — resolves against whatever page it lands on, so the destination is not knowable here |
 * | anything with CR/LF/TAB/NUL | header and URL smuggling |
 *
 * Note `/\` and `\\` are checked on the RAW string before any normalisation.
 * Checking after normalising would be checking the wrong string, which is the
 * usual way this validation is written wrong.
 */
export function sanitizeReturnTo(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (raw.length === 0) return null;

  // Control characters anywhere — smuggling vectors, never legitimate in a path.
  // Written as escapes, not literal bytes: a raw NUL in a source file is a hazard
  // in its own right.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  // Must be path-absolute. This alone kills `javascript:`, `data:`, `https://…`
  // and every relative form, but the explicit cases below are what a reader
  // checks this function against.
  if (!raw.startsWith('/')) return null;

  // Protocol-relative, in both spellings the browser accepts.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;

  // A backslash anywhere in the authority position is the same trick with an
  // extra step; reject the character outright rather than reasoning about where
  // it is safe.
  if (raw.includes('\\')) return null;

  return raw;
}

/**
 * Build the login route with the return target attached.
 *
 * Returns `loginRoute` untouched when there is nothing safe to carry, so the
 * caller never has to branch on it. Preserves any query string the consumer
 * already put on their `loginRoute`.
 */
export function withReturnTo(
  loginRoute: string,
  returnTo: string | null | undefined,
  param: string = DEFAULT_RETURN_TO_PARAM,
): string {
  const safe = sanitizeReturnTo(returnTo);
  if (!safe) return loginRoute;

  const separator = loginRoute.includes('?') ? '&' : '?';
  return `${loginRoute}${separator}${param}=${encodeURIComponent(safe)}`;
}

/**
 * Read the return target back off the login page's URL, validated.
 *
 * This is the half consumers would otherwise have to write themselves, and the
 * half where forgetting the validation is an open redirect. Accepts a `URL`, a
 * `URLSearchParams`, or a raw query/href string so it can be called from a load
 * function, a component, or a plain browser context without ceremony.
 *
 * Returns null when absent or unsafe — callers should fall back to their own
 * default route, never navigate to null.
 */
export function readReturnTo(
  source: URL | URLSearchParams | string | null | undefined,
  param: string = DEFAULT_RETURN_TO_PARAM,
): string | null {
  if (!source) return null;

  let params: URLSearchParams;
  if (source instanceof URLSearchParams) {
    params = source;
  } else if (typeof source === 'string') {
    try {
      // Works for a full href, and for a bare "?a=b" or "a=b".
      params = source.includes('://')
        ? new URL(source).searchParams
        : new URLSearchParams(source.startsWith('?') ? source.slice(1) : source);
    } catch {
      return null;
    }
  } else {
    params = source.searchParams;
  }

  return sanitizeReturnTo(params.get(param));
}

/**
 * Storage key for the hosted-mode return target. Namespaced like the other
 * Bridge-owned sessionStorage entries (`bridge_checkout_session_id`).
 */
export const RETURN_TO_STORAGE_KEY = 'bridge_return_to';

/**
 * Hosted mode carries the return target in sessionStorage, NOT in the URL
 * (TBP-629).
 *
 * This is not a stylistic difference from SDK mode — it is forced. Hosted login
 * hands `redirectUri` to the OAuth authorize call, and bridge-api validates it
 * with `appConfig.allowedRedirectUris.includes(redirect_uri)`: an exact string
 * match. Appending `?redirectUri=/deep/link` to the callback URL would fail that
 * check and break login outright, so the OAuth contract has to stay byte-for-byte
 * what it is today.
 *
 * sessionStorage is sound here for a reason that does NOT hold in general: the
 * whole round-trip happens in one tab and returns to the origin that wrote the
 * value. The visitor opens the deep link (tab A), we stash and redirect tab A to
 * the hosted portal, they sign in, the portal returns tab A to our callback on
 * our origin — where the value is still sitting.
 *
 * Every failure mode here is "fall back to the default route", never "throw":
 * Safari in private mode throws on setItem, and SSR has no sessionStorage at all.
 * Losing a deep link is the bug we are fixing; breaking login would be worse.
 */
export function stashReturnTo(value: string | null | undefined): void {
  const safe = sanitizeReturnTo(value);
  if (!safe) return;
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, safe);
  } catch {
    // Private mode / quota / disabled storage — deep link is lost, login is not.
  }
}

/**
 * Read and CLEAR the stashed return target. One-shot by design: a value left
 * behind would hijack the next login in this tab, sending somebody to a page
 * they asked for ten minutes ago.
 *
 * Re-sanitized on the way out. The value is same-origin and was sanitized on the
 * way in, so this is belt-and-braces — but it is the difference between "storage
 * was tampered with" being a routing oddity and being an open redirect.
 */
export function takeReturnTo(): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
    sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    return sanitizeReturnTo(raw);
  } catch {
    return null;
  }
}

