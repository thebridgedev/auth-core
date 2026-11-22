import { originOf } from './core/urls.js';
import { sanitizeReturnTo } from './return-to.js';

/**
 * Signing out and where the person goes next.
 *
 * `logout()` ends the session (here, in every tab, and at Bridge) and then does one of three things: stays where
 * the person is (`silent`), goes where the developer chose (`redirectTo`), or goes to the app's own sign-in page.
 * A chosen address is only used when it is one of the app's own: a link must never sign somebody out and send them to
 * another site, so anything else is refused and the default is used instead.
 */

export interface LogoutOptions {
  /**
   * Where to go once signed out: a path on this page's origin (`/goodbye`), or an address on one of the app's own
   * origins (`appOrigins`). Any other address is refused, and the default is used.
   */
  readonly redirectTo?: string;
  /**
   * Stay where the person is: sign out without leaving the page, so the app can show its own signed-out view. The
   * sign-out event still reaches everything that listens.
   */
  readonly silent?: boolean;
}

export interface LogoutResult {
  /** Where the person was sent, or null when they stayed (`silent`) or the page has no way to navigate. */
  readonly redirectTo: string | null;
}

/**
 * Reduces a chosen destination to one the app's own pages allow, or null: a same-origin path (`sanitizeReturnTo`),
 * or an `http(s)` address whose origin is this page's or one of `appOrigins`. Never a scheme payload, a
 * protocol-relative address or an address with credentials in it.
 */
export function ownDestination(value: string | null | undefined, pageOrigin: string | null, appOrigins: readonly string[] = []): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const path = sanitizeReturnTo(raw);
  if (path !== null) return path;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('//')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
  const allowed = new Set([...(pageOrigin === null ? [] : [pageOrigin]), ...appOrigins.map((each) => originOf(each)).filter((each): each is string => each !== null)]);
  return allowed.has(url.origin) ? url.href : null;
}

export interface LogoutDeps {
  /** Ends the session here, in every tab, and at Bridge. */
  readonly signOut: () => Promise<void>;
  /** The page's own origin, when there is a page. */
  readonly pageOrigin: () => string | null;
  /** The app's other origins a `redirectTo` may name. */
  readonly appOrigins: readonly string[];
  /** Where a person goes when no `redirectTo` was given, or it was refused: the app's own sign-in page. */
  readonly signedOutPage: string;
  /** Takes the browser to an address; null when the caller navigates itself. */
  readonly navigate: ((to: string) => void | Promise<void>) | null;
}

export function createLogout(deps: LogoutDeps) {
  return async function logout(options: LogoutOptions = {}): Promise<LogoutResult> {
    await deps.signOut();
    if (options.silent === true) return { redirectTo: null };
    const target = ownDestination(options.redirectTo, deps.pageOrigin(), deps.appOrigins) ?? deps.signedOutPage;
    if (deps.navigate === null) return { redirectTo: target };
    await deps.navigate(target);
    return { redirectTo: target };
  };
}
