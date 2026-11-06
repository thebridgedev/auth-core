import { BridgeError } from './core/errors.js';
import { isS256Challenge } from './core/util.js';

/**
 * Hand-off mode: a sign-in page that signs a person in for a program on
 * their own machine, such as a command-line tool, instead of for itself.
 *
 * The program opens the page with its PKCE challenge, a loopback address
 * and a `state`. The page signs in with that challenge (`signIn.handoff`),
 * never trades the code, and sends the browser back to the loopback address
 * with the code. Only the program holds the verifier, so only it can trade
 * the code for tokens.
 *
 * The return address must be a loopback address with a literal IP
 * (RFC 8252, 7.3): `http://127.0.0.1:<port>/…` or `http://[::1]:<port>/…`.
 * Never `localhost`, which a hosts file can point anywhere, and never any
 * other host, so a crafted link cannot send a code off the person's machine.
 */

export interface HandoffRequest {
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly redirectUri: string;
  readonly state: string;
}

/** Whether an address is a loopback address a code may be returned to. */
export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || url.hash !== '') return false;
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return false;
  return url.port !== '';
}

/**
 * Reads and checks a hand-off request from the page's query string:
 * `code_challenge`, `code_challenge_method=S256`, `redirect_uri` and `state`.
 * Throws `invalid` for anything else, so the page never signs in for a
 * request it cannot answer safely.
 */
export function readHandoffRequest(search: string | URLSearchParams): HandoffRequest {
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const codeChallenge = params.get('code_challenge');
  const method = params.get('code_challenge_method');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');
  if (!isS256Challenge(codeChallenge)) throw new BridgeError('invalid', 'The hand-off needs an S256 code_challenge.');
  if (method !== 'S256') throw new BridgeError('invalid', 'The hand-off needs code_challenge_method=S256.');
  if (redirectUri === null || !isLoopbackRedirect(redirectUri)) {
    throw new BridgeError('invalid', 'The hand-off returns only to http://127.0.0.1:<port>/ or http://[::1]:<port>/.');
  }
  if (state === null || state.length < 8 || state.length > 512) throw new BridgeError('invalid', 'The hand-off needs a state of 8 to 512 characters.');
  return { codeChallenge, codeChallengeMethod: 'S256', redirectUri, state };
}

/** The address to send the browser to once the code is issued. */
export function handoffReturnUrl(request: HandoffRequest, code: string): string {
  if (!isLoopbackRedirect(request.redirectUri)) throw new BridgeError('invalid', 'The hand-off returns only to a loopback address.');
  const url = new URL(request.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', request.state);
  return url.toString();
}
