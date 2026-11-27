import { originOf } from './core/urls.js';
import { sanitizeReturnTo } from './return-to.js';

/**
 * Signing out and where the person goes next.
 *
 * `logout()` ends the session (here, in every tab, and at Bridge) and then does one of three things: stays where
 * the person is (`silent`), goes where the developer chose (`redirectTo`), or goes to the default.
 *
 * Both the default and the addresses a chosen one may be on come from Bridge, in the app's sign-in options
 * (`signOut`), so the app configures nothing: the default is the sign-out address the app lists in its
 * settings, or Bridge's sign-in page for an app whose users sign in there, else the app's own sign-in page
 * (`signedOutPage`). A chosen address is used only on this page's origin or one of the app's browser origins as Bridge
 * publishes them: a link must never sign somebody out and send them to another site, so anything else is refused and
 * the default is used instead. When Bridge cannot be asked in a moment, the app's own sign-in page and this page's
 * origin are all that is used, so signing out never waits on it.
 */

export interface LogoutOptions {
  /**
   * Where to go once signed out: a path on this page's origin (`/goodbye`), or an address on one of the app's browser
   * origins as Bridge lists them. Any other address is refused, and the default is used.
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

/** What the app's sign-in options say about signing out. */
export interface SignOutSettings {
  /** Where a signed-out person goes by default; null for the app's own sign-in page. */
  readonly page: string | null;
  /** The app's browser origins as it saved them (`https://*.acme.com`, `http://localhost:*` included). */
  readonly origins: readonly string[];
}

/**
 * Whether `origin` is one an app's saved browser origin names, as Bridge matches them: exactly; `scheme://*.host[:port]`
 * for any subdomain of the host (not the host itself), on that port or, with `:*`, any; or `…:*` for any port.
 */
export function matchesOrigin(entry: string, origin: string): boolean {
  if (entry === origin) return true;
  const wildcard = /^([a-z][a-z0-9+.-]*):\/\/\*\.([^/]+)$/i.exec(entry);
  if (wildcard !== null) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== `${(wildcard[1] ?? '').toLowerCase()}:`) return false;
    let host = (wildcard[2] ?? '').toLowerCase();
    let port: string | undefined;
    const colon = host.lastIndexOf(':');
    if (colon !== -1) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
    if (!parsed.hostname.endsWith(`.${host}`)) return false;
    if (port === undefined) return parsed.port === '';
    return port === '*' || parsed.port === port;
  }
  if (entry.endsWith(':*')) {
    const prefix = entry.slice(0, -1);
    return origin.startsWith(prefix) && /^\d{1,5}$/.test(origin.slice(prefix.length));
  }
  return false;
}

/** An address Bridge gave as the default, if it is one a browser may be sent to (http or https, no credentials). */
function pageAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Reduces a chosen destination to one the app's own pages allow, or null: a same-origin path (`sanitizeReturnTo`),
 * or an `http(s)` address whose origin is this page's or one of `appOrigins`. Never a scheme payload, a
 * protocol-relative address or an address with credentials in it.
 */
export function ownDestination(value: string | null | undefined, pageOrigin: string | null, appOrigins: readonly string[] = []): string | null {
  // appOrigins: the app's saved browser origins as Bridge publishes them, wildcards included.
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
  if (pageOrigin !== null && url.origin === pageOrigin) return url.href;
  // A saved origin is matched as Bridge matches it; one that is a full address is taken by its origin.
  return appOrigins.some((each) => matchesOrigin(each, url.origin) || originOf(each) === url.origin) ? url.href : null;
}

export interface LogoutDeps {
  /** Ends the session here, in every tab, and at Bridge. */
  readonly signOut: () => Promise<void>;
  /** The page's own origin, when there is a page. */
  readonly pageOrigin: () => string | null;
  /** Origins the developer listed in the plugin's config (`appOrigins`, kept for one release): a `redirectTo` may name them too. */
  readonly appOrigins: readonly string[];
  /** The app's own sign-in page: where a person goes when Bridge names no default and no `redirectTo` was given or it was refused. */
  readonly signedOutPage: string;
  /** What the app's sign-in options say about signing out, from Bridge; rejects or gives undefined when they cannot be read. */
  readonly settings: () => Promise<SignOutSettings | undefined>;
  /** How long to wait for the sign-in options once signed out, in milliseconds. @default 3000 */
  readonly settingsWait?: number;
  /** Takes the browser to an address; null when the caller navigates itself. */
  readonly navigate: ((to: string) => void | Promise<void>) | null;
}

/** The sign-in options' sign-out part, or undefined when they cannot be read within `wait`: signing out never waits on Bridge. */
async function settingsWithin(read: () => Promise<SignOutSettings | undefined>, wait: number): Promise<SignOutSettings | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), wait);
  });
  try {
    const reading = read().catch(() => undefined);
    return await Promise.race([reading, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createLogout(deps: LogoutDeps) {
  return async function logout(options: LogoutOptions = {}): Promise<LogoutResult> {
    // Asked alongside the sign-out, never instead of it: a sign-out ends the session even when Bridge cannot say where to go.
    const asked = options.silent === true ? Promise.resolve(undefined) : settingsWithin(deps.settings, deps.settingsWait ?? 3000);
    await deps.signOut();
    if (options.silent === true) return { redirectTo: null };
    const settings = await asked;
    const origins = [...(Array.isArray(settings?.origins) ? settings.origins.filter((each): each is string => typeof each === 'string') : []), ...deps.appOrigins];
    const fallback = pageAddress(settings?.page) ?? deps.signedOutPage;
    const target = ownDestination(options.redirectTo, deps.pageOrigin(), origins) ?? fallback;
    if (deps.navigate === null) return { redirectTo: target };
    await deps.navigate(target);
    return { redirectTo: target };
  };
}
