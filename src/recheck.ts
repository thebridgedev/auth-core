/**
 * Confirming it is you. Some of Bridge's actions want a recent
 * sign-in: called later, they answer `reauthenticate` (401
 * `identity-recheck`). Instead of signing the person out, a page asks them to
 * confirm it is them, by a way the app offers (their password, one of their
 * passkeys, or a link to their address), in the session they are in. Bridge
 * renews that session's sign-in time, the session's next token carries it, and
 * the page tries the action again.
 *
 * Nothing here keeps a "recently checked" flag: the only proof is the token's
 * `auth_time`, which Bridge sets and checks.
 */
import { BridgeError, isBridgeError } from './core/errors.js';
import type { Endpoints } from './core/discovery.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { storageKey, type BridgeStorage } from './core/storage.js';
import { createPkce, readJwtPayload } from './core/util.js';
import { ceremonyError, type WebAuthnCeremonies } from './passkeys.js';
import type { Session } from './session.js';

/** A way to confirm it is you, as the app's sign-in settings name it. */
export type RecheckMethod = 'password' | 'passkeys' | 'magicLink';

const METHODS: readonly RecheckMethod[] = ['password', 'passkeys', 'magicLink'];
/** As long as a sign-in link works: its verifier waits where the link's tab finds it, the sign-in link's own place. */
const LINK_KEEP_MS = 15 * 60 * 1000;

export interface RecheckDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly signUpStorage: BridgeStorage;
  readonly session: Session;
  readonly ceremonies: WebAuthnCeremonies;
  readonly linkAddress?: string;
}

/** Whether `error` is Bridge asking for a recent sign-in: the one refusal `confirm` answers. */
export function needsRecheck(error: unknown): boolean {
  return isBridgeError(error, 'reauthenticate');
}

export function createRecheck(deps: RecheckDeps) {
  const linkKey = storageKey(deps.issuer, 'magic-link');
  const signedIn = async <T>(route: (typeof ROUTES)[keyof typeof ROUTES], body: Readonly<Record<string, unknown>>): Promise<T> =>
    (await call<T>(deps.fetch, deps.endpoints().url(route), { method: 'POST', token: await deps.session.accessToken(), body })).body;
  /** Confirmed: the session's next token carries the new sign-in time. */
  const renewed = () => deps.session.refresh({ force: true });
  /** The current token's sign-in time, in seconds; null when there is none. */
  const signedInAt = (): number | null => {
    const at = readJwtPayload(deps.session.currentAccessToken())?.['auth_time'];
    return typeof at === 'number' ? at : null;
  };

  return {
    /** The ways the app offers to confirm it is you, in the order its sign-in page lists them. */
    async methods(): Promise<RecheckMethod[]> {
      const offered = (await call<{ methods?: unknown }>(deps.fetch, deps.endpoints().url(ROUTES.signInOptions), { method: 'GET' })).body?.methods;
      const on = Array.isArray(offered) ? offered : [];
      return METHODS.filter((method) => on.includes(method));
    },

    /** When the person last signed in or confirmed it is them, in milliseconds; null when signed out. */
    signedInAt(): number | null {
      const at = signedInAt();
      return at === null ? null : at * 1000;
    },

    /** With the person's password. A wrong one is `wrong-credentials`, and counts as a sign-in's does. */
    async password(password: string): Promise<void> {
      await signedIn(ROUTES.recheck, { password });
      await renewed();
    },

    /** With one of the person's own passkeys: the browser offers only theirs. */
    async passkey(): Promise<void> {
      if (!(await deps.ceremonies.supported())) throw new BridgeError('not-supported', 'This browser cannot use passkeys.');
      const options = (await signedIn<{ options?: unknown }>(ROUTES.recheckPasskeyOptions, {}))?.options;
      if (options === null || typeof options !== 'object') throw new BridgeError('unavailable', 'Bridge did not send the passkey options.');
      let response: Record<string, unknown>;
      try {
        response = await deps.ceremonies.get(options as Record<string, unknown>, false);
      } catch (error) {
        throw ceremonyError(error);
      }
      await signedIn(ROUTES.recheck, { passkey: response });
      await renewed();
    },

    /**
     * Sends a link to the person's own address. It opens on this device's
     * sign-in link page (`signIn.magicLink.finish`), which confirms the
     * session instead of signing in; `emailOpened` resolves then, in this tab.
     */
    async email(): Promise<{ readonly next: 'verify_email' }> {
      const pkce = await createPkce();
      await deps.signUpStorage.set(linkKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + LINK_KEEP_MS }));
      try {
        await signedIn(ROUTES.recheckEmail, { code_challenge: pkce.challenge, code_challenge_method: 'S256', ...(deps.linkAddress === undefined ? {} : { link_address: deps.linkAddress }) });
      } catch (error) {
        await deps.signUpStorage.remove(linkKey);
        throw error;
      }
      return { next: 'verify_email' };
    },

    /**
     * Resolves once the session's sign-in time is later than `since` (ms;
     * the current one when absent): the link's tab renews the session, and its
     * new tokens reach every tab. Checks again every `everyMs` too, for a tab
     * that missed them. Rejects with `cancelled` when `signal` aborts.
     */
    emailOpened(options: { readonly since?: number; readonly signal?: AbortSignal; readonly everyMs?: number } = {}): Promise<void> {
      const since = options.since ?? (signedInAt() ?? 0) * 1000;
      const fresh = () => (signedInAt() ?? 0) * 1000 > since;
      return new Promise<void>((resolve, reject) => {
        if (fresh()) return resolve();
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = deps.session.events.on('token-refreshed', () => fresh() && finish());
        const finish = (error?: unknown) => {
          stop();
          if (timer !== null) clearInterval(timer);
          options.signal?.removeEventListener('abort', aborted);
          if (error === undefined) resolve();
          else reject(error);
        };
        const aborted = () => finish(new BridgeError('cancelled', 'Confirming it is you was cancelled.'));
        if (options.signal?.aborted === true) return aborted();
        options.signal?.addEventListener('abort', aborted);
        timer = setInterval(() => {
          void renewed().then(
            () => fresh() && finish(),
            () => undefined,
          );
        }, options.everyMs ?? 5000);
      });
    },

    /**
     * Runs `action`; when Bridge answers that it needs a recent sign-in,
     * waits for `confirm` (the page's own way of asking the person, which
     * resolves once they confirmed and rejects if they cancel) and runs
     * `action` once more. Any other error, and a second refusal, is thrown.
     */
    async guard<T>(action: () => Promise<T>, confirm: () => Promise<void>): Promise<T> {
      try {
        return await action();
      } catch (error) {
        if (!needsRecheck(error)) throw error;
        await confirm();
        return action();
      }
    },
  };
}

export type Recheck = ReturnType<typeof createRecheck>;
