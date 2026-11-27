import type { SignInOptions } from './sign-in.js';

/**
 * Where an app's users sign in, as Bridge publishes it in the sign-in options: the app's "Your app" setting
 * "Users sign in: in your app / on Bridge's pages", so switching it needs no code change in the app.
 */
export interface SignInPlace {
  /** `app`: the app's own sign-in page; `hosted`: Bridge's hosted page. */
  readonly location: 'app' | 'hosted';
  /** The app's main address (an origin), or null when it has none yet. */
  readonly main: string | null;
  /** The app's sign-in page, a path under its addresses (`/auth/login`). */
  readonly path: string;
  /** Where the links in Bridge's emails open. */
  readonly emailLinks: 'app' | 'hosted';
  /** The path a sign-in comes back to, valid on every address of the app (`/auth/oauth-callback`). */
  readonly returnPath: string;
  /** Where a signed-out user goes: the app's sign-in page, or Bridge's hosted page. Null when Bridge names none. */
  readonly url: string | null;
  /** Where a user lands after signing out. */
  readonly signedOutUrl: string | null;
}

/** An http or https address, or null. */
function web(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The sign-in place in an options answer, checked: null when Bridge names none (an app from before the setting). */
export function signInPlaceOf(options: Pick<SignInOptions, 'signIn'> | null | undefined): SignInPlace | null {
  const given = options?.signIn as Partial<SignInPlace> | undefined;
  if (given === undefined || given === null || (given.location !== 'app' && given.location !== 'hosted')) return null;
  return {
    location: given.location,
    main: web(given.main) === null ? null : (given.main as string),
    path: typeof given.path === 'string' && given.path.startsWith('/') ? given.path : '/auth/login',
    emailLinks: given.emailLinks === 'hosted' ? 'hosted' : 'app',
    returnPath: typeof given.returnPath === 'string' && given.returnPath.startsWith('/') && !given.returnPath.startsWith('//') ? given.returnPath : '/auth/oauth-callback',
    url: web(given.url),
    signedOutUrl: web(given.signedOutUrl),
  };
}

/**
 * Whether signed-out users go to Bridge's hosted page instead of the app's own sign-in forms: the app's setting says
 * `hosted` and names the page. False for an app from before the setting, which keeps what its code says.
 */
export function signsInOnHostedPage(options: Pick<SignInOptions, 'signIn'> | null | undefined): boolean {
  const place = signInPlaceOf(options);
  return place?.location === 'hosted' && place.url !== null;
}

/**
 * Where a user lands after signing out: Bridge's hosted page when the app's users sign in there; otherwise `fallback`
 * (the app's own choice, such as its home page).
 */
export function signedOutTarget(options: Pick<SignInOptions, 'signIn'> | null | undefined, fallback: string): string {
  const place = signInPlaceOf(options);
  return place?.location === 'hosted' && place.signedOutUrl !== null ? place.signedOutUrl : fallback;
}

/**
 * On Bridge's own pages (the hosted page, which signs in for other apps): where to send a visitor of an app whose
 * users sign in in the app, or null to stay. The page stays for a sign-in request (an app, a program or an
 * assistant asked for it: the assistant consent page and the TV code page are always Bridge's), for an app that
 * names no sign-in page of its own, and when the page already is the app's own.
 */
export function hostedPageRedirect(options: Pick<SignInOptions, 'signIn'> | null | undefined, here: string, onRequest: boolean): string | null {
  if (onRequest) return null;
  const place = signInPlaceOf(options);
  if (place === null || place.location !== 'app' || place.url === null) return null;
  try {
    return new URL(place.url).origin === new URL(here).origin ? null : place.url;
  } catch {
    return null;
  }
}
