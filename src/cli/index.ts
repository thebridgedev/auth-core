/// <reference types="node" />
/**
 * @nebulr-group/bridge-auth-core/cli
 *
 * Sign-in for an app's own command-line tool, in about ten lines:
 *
 * ```ts
 * import { createBridgeCli } from '@nebulr-group/bridge-auth-core/cli';
 *
 * const auth = createBridgeCli({ issuer: process.env.BRIDGE_ISSUER!, name: 'acme' });
 * await auth.login();                    // the browser; `{ code: true }` for a short code
 * const me = await auth.whoami();        // { email, userId, workspace, ... } or null
 * const token = await auth.getAccessToken(); // renewed when it is about to expire
 * await auth.logout();
 * ```
 *
 * - `login()` opens the app's hosted sign-in page through a sign-in request
 *   bound to a loopback listener on `127.0.0.1` (RFC 8252), with PKCE (S256),
 *   `state`, and the issuer checked on the way back (RFC 9207). With
 *   `{ code: true }`, or when no browser can be opened here (over SSH, a
 *   Linux machine without a display), it uses a short code (RFC 8628) when
 *   the app allows one.
 * - Tokens are kept in the system keychain when there is one, else in a file
 *   only the user can read (0600, in a 0700 directory). One session per issuer.
 * - `getAccessToken()` renews with the refresh token within a minute of
 *   expiry, once at a time in this process and across processes.
 *
 * Node only: it listens on a port, runs the keychain tool and writes files.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMetadata, metadataUrl } from '../core/discovery.js';
import { BridgeError } from '../core/errors.js';
import { platformFetch, type Fetch } from '../core/http.js';
import { secureUrl } from '../core/urls.js';
import { createPkce, randomToken, readJwtPayload } from '../core/util.js';
import { canOpenBrowser, openInBrowser } from './browser.js';
import { withFileLock } from './files.js';
import { startLoopback, type Loopback } from './loopback.js';
import { chooseSessionStore, type CliSessionStore, type StoredCliSession } from './store.js';

/** Renew this long before the access token expires, so a call never carries one that runs out on the way. */
const RENEW_BEFORE_MS = 60_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface BridgeCliOptions {
  /** The app's issuer, as for the browser SDK. */
  readonly issuer: string;
  /** The CLI's name: shown to the person, and the keychain entry's name. Letters, digits, `-`, `_`, `.`. */
  readonly name: string;
  /** Where the session file and the renewal lock live. @default `$XDG_CONFIG_HOME/<name>` or `~/.config/<name>` */
  readonly configDir?: string;
  /**
   * Where tokens are kept: `auto` (the keychain when there is one, else the
   * file), `keychain`, `file`, or a store of your own. @default `BRIDGE_TOKEN_STORE`, else `auto`
   */
  readonly store?: 'auto' | 'keychain' | 'file' | CliSessionStore;
  /** What the person is told (the address to open, the short code). @default standard error */
  readonly print?: (message: string) => void;
  /** Opens an address in the browser; resolves whether it opened. @default the system opener */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  /** Whether a browser can be opened here. @default no over SSH, and on Linux only with a display */
  readonly canOpenBrowser?: () => boolean;
  /** How long to wait for the browser to come back. @default 5 minutes */
  readonly timeoutMs?: number;
  readonly fetch?: Fetch;
  readonly env?: NodeJS.ProcessEnv;
  /** For tests. */
  readonly now?: () => number;
  /** For tests: how polling waits. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** For tests: called once the loopback listens, with the sign-in page's address. */
  readonly onListening?: (info: { readonly redirectUri: string; readonly url: string }) => void;
}

export interface LoginOptions {
  /** Sign in with a short code typed on another device, instead of the browser. */
  readonly code?: boolean;
}

/** Who is signed in, from the stored tokens. */
export interface WhoAmI {
  readonly issuer: string;
  readonly appId: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly workspace: { readonly id: string; readonly name: string | null } | null;
  /** The person's privileges in the app, as the access token lists them. */
  readonly privileges: readonly string[];
  /** Whether this session may delete (it is not limited, or deleting was allowed when it was approved). */
  readonly mayDelete: boolean;
  /** When the access token expires, in ms since the epoch. It is renewed on its own. */
  readonly accessTokenExpiresAt: number;
  readonly signedInAt: number;
  /** Where the tokens are kept. */
  readonly storage: string;
}

export interface BridgeCli {
  /** Signs in and keeps the session. Resolves with who signed in. */
  login(options?: LoginOptions): Promise<WhoAmI>;
  /** Ends the session at Bridge (revokes the refresh token) and forgets it here, even when Bridge cannot be reached. */
  logout(): Promise<{ readonly signedOut: boolean; readonly revoked: boolean; readonly reason?: string }>;
  /** Who is signed in, or null. Reads the stored tokens; no network call. */
  whoami(): Promise<WhoAmI | null>;
  /** An access token good for at least a minute, renewed first when needed. Throws `signed-out` when not signed in or ended. */
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
  /** `fetch` with the person's token; a 401 renews once and tries again. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Where tokens are kept, in words. */
  storage(): string;
}

interface Endpoints {
  readonly issuer: string;
  readonly appId: string;
  readonly token: string;
  readonly revoke: string | null;
  readonly signInRequests: string | null;
  readonly signInPage: string | null;
  readonly deviceAuthorization: string | null;
}

interface TokenAnswer {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly workspace?: unknown;
}

interface OAuthAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function signInAgain(name: string): string {
  return `Run \`${name} login\` to sign in.`;
}

/** The scopes say whether deleting is allowed: not limited (`management`), or limited with `delete`. */
function mayDelete(scope: unknown): boolean {
  const scopes = typeof scope === 'string' ? scope.split(' ').filter((s) => s !== '') : [];
  return !scopes.includes('management') || scopes.includes('delete');
}

function workspaceOf(answer: unknown, claims: Record<string, unknown> | null): StoredCliSession['workspace'] {
  if (answer !== null && typeof answer === 'object') {
    const record = answer as Record<string, unknown>;
    const id = text(record['id']);
    if (id !== null) return { id, name: text(record['name']) };
  }
  const id = text(answer) ?? text(claims?.['tid']);
  return id === null ? null : { id, name: null };
}

/** The device endpoint, from version 2's list or the standard field. */
function deviceEndpoint(doc: Record<string, unknown>): string | null {
  const versions = doc['bridge_endpoints'];
  const v2 = versions !== null && typeof versions === 'object' ? (versions as Record<string, unknown>)['2'] : undefined;
  const listed = v2 !== null && typeof v2 === 'object' ? (v2 as Record<string, unknown>)['device_authorization'] : undefined;
  return secureUrl(listed) ?? secureUrl(doc['device_authorization_endpoint']);
}

export function createBridgeCli(options: BridgeCliOptions): BridgeCli {
  if (!options || typeof options.issuer !== 'string' || secureUrl(options.issuer) === null) {
    throw new BridgeError('misconfigured', `createBridgeCli: the issuer must be an https address (http only on localhost); got "${String(options?.issuer)}".`);
  }
  if (typeof options.name !== 'string' || !NAME.test(options.name)) {
    throw new BridgeError('misconfigured', 'createBridgeCli: `name` is the CLI\'s name: letters, digits, ".", "-" and "_".');
  }
  const name = options.name;
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? platformFetch();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const print = options.print ?? ((message: string) => process.stderr.write(`${message}\n`));
  const configDir = options.configDir ?? join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), name);
  const store: CliSessionStore =
    typeof options.store === 'object'
      ? options.store
      : chooseSessionStore({
          service: name,
          dir: configDir,
          kind: options.store ?? ((env['BRIDGE_TOKEN_STORE'] ?? 'auto').toLowerCase() as 'auto' | 'keychain' | 'file'),
          env,
          warn: print,
        });

  let endpoints: Endpoints | null = null;
  let renewing: Promise<StoredCliSession> | null = null;

  /** The issuer's metadata, read once per process. */
  async function discover(): Promise<Endpoints> {
    if (endpoints !== null) return endpoints;
    let response: Response;
    try {
      response = await fetchFn(metadataUrl(options.issuer), { headers: { Accept: 'application/json' }, redirect: 'manual' });
    } catch (cause) {
      throw new BridgeError('network', `Could not reach ${options.issuer}.`, { cause });
    }
    if (!response.ok) throw new BridgeError('misconfigured', `The issuer's metadata could not be read (${String(response.status)}).`, { status: response.status });
    const doc = (await response.json()) as Record<string, unknown>;
    const metadata = readMetadata(options.issuer, doc);
    const token = metadata.endpoints.token;
    if (token === undefined) throw new BridgeError('misconfigured', "The issuer's metadata lists no token endpoint.");
    endpoints = {
      issuer: metadata.issuer,
      appId: metadata.appId,
      token,
      revoke: metadata.endpoints.revoke ?? null,
      signInRequests: metadata.endpoints.sign_in_requests ?? null,
      signInPage: metadata.signInPage,
      deviceAuthorization: deviceEndpoint(doc),
    };
    return endpoints;
  }

  /** A JSON POST to an OAuth endpoint. Answers come back as they are; only a network failure throws. */
  async function post(url: string, body: Record<string, unknown>): Promise<OAuthAnswer> {
    let response: Response;
    try {
      response = await fetchFn(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
    } catch (cause) {
      throw new BridgeError('network', `Could not reach Bridge (${new URL(url).pathname}).`, { cause });
    }
    const raw = await response.text();
    let parsed: unknown = {};
    try {
      parsed = raw === '' ? {} : JSON.parse(raw);
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} };
  }

  function refusedBy(answer: OAuthAnswer, what: string): BridgeError {
    const code = text(answer.body['error']) ?? `http_${String(answer.status)}`;
    const description = text(answer.body['error_description']);
    return new BridgeError(answer.status >= 500 ? 'unavailable' : 'invalid', `${what} was refused${description === null ? ` (${code})` : `: ${description}`}`, { status: answer.status, code });
  }

  function tokenAnswer(answer: OAuthAnswer): TokenAnswer {
    if (typeof answer.body['access_token'] !== 'string' || typeof answer.body['expires_in'] !== 'number') {
      throw new BridgeError('misconfigured', 'The token endpoint answered without an access token.');
    }
    return answer.body as unknown as TokenAnswer;
  }

  function sessionFrom(d: Endpoints, answer: TokenAnswer, previous: StoredCliSession | null): StoredCliSession {
    const claims = readJwtPayload(answer.access_token);
    const id = readJwtPayload(answer.id_token);
    const person = {
      id: text(id?.['sub']) ?? text(claims?.['sub']),
      email: text(id?.['email']) ?? text(claims?.['email']) ?? previous?.person.email ?? null,
      name: text(id?.['name']) ?? previous?.person.name ?? null,
    };
    return {
      issuer: d.issuer,
      appId: d.appId,
      accessToken: answer.access_token,
      accessTokenExpiresAt: now() + answer.expires_in * 1000,
      // Rotation: the new refresh token replaces the old one, which is now spent.
      refreshToken: answer.refresh_token ?? previous?.refreshToken ?? null,
      workspace: workspaceOf(answer.workspace, claims) ?? previous?.workspace ?? null,
      person,
      signedInAt: previous?.signedInAt ?? now(),
    };
  }

  function whoamiOf(session: StoredCliSession): WhoAmI {
    const claims = readJwtPayload(session.accessToken) ?? {};
    const privileges = Array.isArray(claims['privileges']) ? claims['privileges'].filter((p): p is string => typeof p === 'string') : [];
    return Object.freeze({
      issuer: session.issuer,
      appId: session.appId,
      userId: session.person.id,
      email: session.person.email,
      name: session.person.name,
      workspace: session.workspace,
      privileges: Object.freeze(privileges),
      mayDelete: mayDelete(claims['scope']),
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      signedInAt: session.signedInAt,
      storage: store.describe(),
    });
  }

  async function keep(d: Endpoints, answer: TokenAnswer): Promise<WhoAmI> {
    const session = sessionFrom(d, answer, null);
    await store.write(session);
    return whoamiOf(session);
  }

  async function loginWithBrowser(d: Endpoints): Promise<WhoAmI> {
    if (d.signInRequests === null || d.signInPage === null) {
      throw new BridgeError('not-offered', 'This app does not offer browser sign-in for its command-line tool (its issuer lists no sign-in page).');
    }
    const pkce = await createPkce();
    const state = randomToken(32);
    const loopback: Loopback = await startLoopback({ state, issuer: d.issuer, name, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    try {
      const started = await post(d.signInRequests, {
        redirect_uri: loopback.redirectUri,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        client_id: d.appId,
      });
      const request = text(started.body['request']);
      if (started.status >= 400 || request === null) throw refusedBy(started, 'Starting the sign-in');
      const page = new URL(d.signInPage);
      page.search = new URLSearchParams({ request }).toString();
      const url = page.toString();
      options.onListening?.({ redirectUri: loopback.redirectUri, url });
      const opened = await (options.openBrowser ?? openInBrowser)(url);
      print(
        opened
          ? `Opened your browser to sign in to ${name}. If it did not open, go to:\n  ${url}`
          : `Open this address in your browser to sign in to ${name}:\n  ${url}`,
      );
      const { code } = await loopback.result;
      const traded = await post(d.token, { grant_type: 'authorization_code', code, code_verifier: pkce.verifier, redirect_uri: loopback.redirectUri, client_id: d.appId });
      if (traded.status >= 400) throw refusedBy(traded, 'Trading the sign-in code');
      return await keep(d, tokenAnswer(traded));
    } finally {
      loopback.close();
    }
  }

  async function loginWithCode(d: Endpoints): Promise<WhoAmI> {
    if (d.deviceAuthorization === null) {
      throw new BridgeError('not-offered', 'This app does not allow sign-in with a short code. Sign in through the browser.', { code: 'unauthorized_client' });
    }
    const asked = await post(d.deviceAuthorization, { client_id: d.appId });
    if (asked.status >= 400) {
      if (asked.body['error'] === 'unauthorized_client') {
        throw new BridgeError('not-offered', text(asked.body['error_description']) ?? 'This app does not allow sign-in with a short code. Sign in through the browser.', { status: asked.status, code: 'unauthorized_client' });
      }
      throw refusedBy(asked, 'Asking for a short code');
    }
    const deviceCode = text(asked.body['device_code']);
    const userCode = text(asked.body['user_code']);
    const verificationUri = text(asked.body['verification_uri']);
    if (deviceCode === null || userCode === null || verificationUri === null) throw new BridgeError('misconfigured', 'Bridge answered without a short code.');
    const complete = text(asked.body['verification_uri_complete']);
    const expiresIn = typeof asked.body['expires_in'] === 'number' ? asked.body['expires_in'] : 600;
    let intervalMs = (typeof asked.body['interval'] === 'number' ? asked.body['interval'] : 5) * 1000;
    print(`To sign in to ${name}, open ${verificationUri} on any device and enter the code:\n\n  ${userCode}\n${complete === null ? '' : `\nOr open: ${complete}\n`}\nWaiting for you to approve it...`);
    const deadline = now() + expiresIn * 1000;
    for (;;) {
      await sleep(intervalMs);
      if (now() > deadline) throw new BridgeError('flow-expired', `The code expired before it was approved. ${signInAgain(name)}`, { code: 'expired_token' });
      const polled = await post(d.token, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: d.appId });
      if (polled.status < 400) return keep(d, tokenAnswer(polled));
      switch (polled.body['error']) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          // RFC 8628, 3.5: five seconds more, from now on.
          intervalMs += 5000;
          continue;
        case 'access_denied':
          throw new BridgeError('cancelled', 'Sign-in was refused when the code was entered.', { status: polled.status, code: 'access_denied' });
        case 'expired_token':
          throw new BridgeError('flow-expired', `The code expired before it was approved. ${signInAgain(name)}`, { status: polled.status, code: 'expired_token' });
        case 'invalid_grant':
          throw new BridgeError('flow-expired', `The code was already used. ${signInAgain(name)}`, { status: polled.status, code: 'invalid_grant' });
        default:
          throw refusedBy(polled, 'Signing in with the code');
      }
    }
  }

  async function current(d: Endpoints): Promise<StoredCliSession> {
    const session = await store.read(d.issuer);
    if (session === null) throw new BridgeError('signed-out', `Not signed in. ${signInAgain(name)}`, { code: 'not_signed_in' });
    return session;
  }

  /** Renews under the lock, with the store read again inside it: another command may have renewed already. */
  async function renew(d: Endpoints, stale: string, force: boolean): Promise<StoredCliSession> {
    return withFileLock(configDir, 'renew', async () => {
      const session = await current(d);
      if (session.accessToken !== stale && session.accessTokenExpiresAt - now() > RENEW_BEFORE_MS) return session;
      if (!force && session.accessTokenExpiresAt - now() > RENEW_BEFORE_MS) return session;
      if (session.refreshToken === null) {
        await store.remove(d.issuer);
        throw new BridgeError('signed-out', `The session cannot be renewed. ${signInAgain(name)}`, { code: 'session_ended' });
      }
      const answer = await post(d.token, { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: d.appId });
      if (answer.status >= 400) {
        // Refused for good: signed out elsewhere, the connection ended, the token reused.
        if (answer.status === 400 || answer.status === 401) {
          await store.remove(d.issuer);
          throw new BridgeError('signed-out', `The session ended. ${signInAgain(name)}`, { status: answer.status, code: 'session_ended' });
        }
        throw refusedBy(answer, 'Renewing the session');
      }
      const renewed = sessionFrom(d, tokenAnswer(answer), session);
      await store.write(renewed);
      return renewed;
    });
  }

  async function getAccessToken(tokenOptions: { readonly force?: boolean } = {}): Promise<string> {
    const d = await discover();
    const session = await current(d);
    if (!tokenOptions.force && session.accessTokenExpiresAt - now() > RENEW_BEFORE_MS) return session.accessToken;
    // One renewal at a time in this process; the lock covers other processes.
    renewing ??= renew(d, session.accessToken, tokenOptions.force === true).finally(() => {
      renewing = null;
    });
    return (await renewing).accessToken;
  }

  return {
    async login(loginOptions: LoginOptions = {}) {
      const d = await discover();
      const browser = loginOptions.code !== true && (options.canOpenBrowser ?? (() => canOpenBrowser(env)))();
      if (!browser && d.deviceAuthorization !== null) return loginWithCode(d);
      if (loginOptions.code === true) return loginWithCode(d);
      // No browser here and no short codes: the address is printed to open by hand on this machine.
      return loginWithBrowser(d);
    },
    async logout() {
      const d = await discover();
      const session = await store.read(d.issuer);
      if (session === null) return { signedOut: false, revoked: false, reason: 'not signed in' };
      let revoked = false;
      let reason: string | undefined;
      if (session.refreshToken !== null && d.revoke !== null) {
        try {
          const answer = await post(d.revoke, { token: session.refreshToken, token_type_hint: 'refresh_token', client_id: d.appId });
          revoked = answer.status < 400;
          if (!revoked) reason = refusedBy(answer, 'Signing out').message;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      } else {
        reason = 'there was no refresh token to end the session with';
      }
      await store.remove(d.issuer);
      return reason === undefined ? { signedOut: true, revoked } : { signedOut: true, revoked, reason };
    },
    async whoami() {
      const session = await store.read((await discover()).issuer);
      return session === null ? null : whoamiOf(session);
    },
    getAccessToken,
    async fetch(input, init = {}) {
      const send = async (token: string) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetchFn(input, { ...init, headers });
      };
      const first = await send(await getAccessToken());
      if (first.status !== 401) return first;
      return send(await getAccessToken({ force: true }));
    },
    storage: () => store.describe(),
  };
}

export { canOpenBrowser, openInBrowser, browserCommand } from './browser.js';
export { checkCallback, readCallback } from './loopback.js';
export { chooseSessionStore, FileSessionStore, KeychainWithFileStore, MacKeychainStore, SecretToolStore } from './store.js';
export type { ChooseStoreOptions, CliSessionStore, Runner, RunResult, StoredCliSession } from './store.js';
export { BridgeError, isBridgeError } from '../core/errors.js';
