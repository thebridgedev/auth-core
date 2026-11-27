import type { Endpoints } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { storageKey, type BridgeStorage } from './core/storage.js';
import { createPkce } from './core/util.js';
import type { Session } from './session.js';

/**
 * Passkeys: signing in with Face ID, Touch ID, Windows Hello, a phone or a
 * security key, on an app that offers them.
 *
 * Bridge makes every ceremony's challenge, checks the answer and keeps only
 * the passkey's public key. Each challenge works once, for a few minutes,
 * and only for the page's own origin, which the app must list among its
 * browser addresses. The person is always verified (fingerprint, face or
 * PIN), and every passkey can sign in without typing an address.
 */

/** The browser's side of a ceremony: options in, the authenticator's answer out, both as JSON. */
export interface WebAuthnCeremonies {
  /** Whether this browser can use passkeys at all. */
  supported(): boolean;
  /** Whether this browser offers passkeys in an input's autofill list (`autocomplete="username webauthn"`). */
  autofillSupported(): Promise<boolean>;
  create(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  get(options: Record<string, unknown>, autofill: boolean): Promise<Record<string, unknown>>;
  /** Stops a ceremony that is waiting, such as autofill when the page moves on. */
  cancel(): void;
  /**
   * The WebAuthn Signal API, where the browser has it: tells the browser and the person's password manager
   * that a passkey is gone, or which ones are still the person's, so they stop offering the others. Left out, or a
   * browser without it: nothing happens. Never fails.
   */
  readonly signal?: {
    unknownCredential(rpId: string, credentialId: string): Promise<void>;
    allAcceptedCredentials(rpId: string, userId: string, credentialIds: readonly string[]): Promise<void>;
    /** The person's name and display name changed: the password manager shows the new ones. */
    currentUserDetails?(rpId: string, userId: string, name: string, displayName: string): Promise<void>;
  };
}

/** One of the signed-in person's passkeys. */
export interface PasskeyInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
  /** `multiDevice` when it syncs to the person's other devices (a password manager, iCloud Keychain…). */
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  /** The authenticator's model, all zeros when it gives none. */
  readonly aaguid: string;
  /** Who keeps the passkey, from its model: "iCloud Keychain", "Google Password Manager", or "Passkey" when unknown, with its icon (a data address) when known. */
  readonly authenticator?: { readonly name: string; readonly icon: string | null };
  /** The passkey's credential id, its domain (RP ID) and the person's user handle: what the Signal API is told. */
  readonly credentialId?: string;
  readonly rpId?: string;
  readonly userHandle?: string;
  /**
   * False for a passkey made for another domain than the app's own (on Bridge's pages, before passkeys followed the
   * app's main address): it cannot sign in any more. Tell the person, let them sign in another way, and offer a new one.
   */
  readonly usable: boolean;
}

export interface PasskeySignInInput {
  /** Only a passkey of this address signs in. Leave out to let the person pick any of theirs. */
  readonly email?: string;
  /** Sign in straight to this workspace. */
  readonly workspace?: string;
  /**
   * Wait for the person to pick a passkey from an input's autofill list
   * instead of opening the dialog. The page needs an input with
   * `autocomplete="username webauthn"`. Starting another ceremony, or
   * `cancel()`, stops the wait.
   */
  readonly autofill?: boolean;
}

/** How long a passkey setup link works, and so how long its verifier is kept. */
const SETUP_KEEP_MS = 24 * 60 * 60 * 1000;

interface StoredVerifier {
  readonly verifier: string;
  readonly expiresAt: number;
}

interface CodeAnswer {
  readonly code?: unknown;
  readonly next?: unknown;
  readonly flow?: unknown;
  readonly workspaces?: unknown;
}

/** The browser's errors, as BridgeErrors: a dialog closed or timed out is `cancelled`; a device that has one already is `conflict`. */
export function ceremonyError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') return new BridgeError('cancelled', 'No passkey was used.', { cause: error });
  if (code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT') return new BridgeError('invalid', 'This key needs a PIN or fingerprint to be used here.', { code: 'passkey_needs_verification', cause: error });
  if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return new BridgeError('conflict', 'This device has a passkey for the app already.', { code: 'passkey_exists', cause: error });
  if (name === 'SecurityError') return new BridgeError('origin-not-allowed', 'This page cannot use passkeys for the app: its address does not match.', { cause: error });
  return new BridgeError('not-supported', 'This browser could not use a passkey.', { cause: error });
}

/** The ceremonies of `@simplewebauthn/browser`, loaded only when a passkey is used. */
export function browserCeremonies(): WebAuthnCeremonies {
  const library = () => import('@simplewebauthn/browser');
  return {
    supported: () => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function',
    async autofillSupported() {
      if (typeof window === 'undefined' || typeof window.PublicKeyCredential !== 'function') return false;
      return (await library()).browserSupportsWebAuthnAutofill();
    },
    async create(options) {
      const { startRegistration } = await library();
      return (await startRegistration({ optionsJSON: options as never })) as unknown as Record<string, unknown>;
    },
    async get(options, autofill) {
      const { startAuthentication } = await library();
      return (await startAuthentication({ optionsJSON: options as never, useBrowserAutofill: autofill })) as unknown as Record<string, unknown>;
    },
    cancel() {
      void library().then(({ WebAuthnAbortService }) => WebAuthnAbortService.cancelCeremony());
    },
    signal: {
      async unknownCredential(rpId, credentialId) {
        const api = signalApi();
        if (api?.signalUnknownCredential !== undefined) await api.signalUnknownCredential({ rpId, credentialId }).catch(() => undefined);
      },
      async allAcceptedCredentials(rpId, userId, credentialIds) {
        const api = signalApi();
        if (api?.signalAllAcceptedCredentials !== undefined) await api.signalAllAcceptedCredentials({ rpId, userId, allAcceptedCredentialIds: [...credentialIds] }).catch(() => undefined);
      },
      async currentUserDetails(rpId, userId, name, displayName) {
        const api = signalApi();
        if (api?.signalCurrentUserDetails !== undefined) await api.signalCurrentUserDetails({ rpId, userId, name, displayName }).catch(() => undefined);
      },
    },
  };
}

/** The browser's Signal API methods, where it has them (Chrome 132+, Safari 26+): feature-detected, never assumed. */
interface SignalApi {
  signalUnknownCredential?(input: { rpId: string; credentialId: string }): Promise<void>;
  signalAllAcceptedCredentials?(input: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }): Promise<void>;
  signalCurrentUserDetails?(input: { rpId: string; userId: string; name: string; displayName: string }): Promise<void>;
}
function signalApi(): SignalApi | null {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential !== 'function') return null;
  return window.PublicKeyCredential as unknown as SignalApi;
}

/** Tells the browser which of the person's passkeys are still theirs, per domain. Never fails. */
export async function signalAccepted(ceremonies: WebAuthnCeremonies, passkeys: readonly PasskeyInfo[]): Promise<void> {
  if (ceremonies.signal === undefined) return;
  const groups = new Map<string, { userId: string; ids: string[] }>();
  for (const each of passkeys) {
    if (each.rpId === undefined || each.userHandle === undefined || each.credentialId === undefined) continue;
    const key = `${each.rpId} ${each.userHandle}`;
    const group = groups.get(key) ?? { userId: each.userHandle, ids: [] };
    group.ids.push(each.credentialId);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    try {
      await ceremonies.signal.allAcceptedCredentials(key.split(' ')[0] ?? '', group.userId, group.ids);
    } catch {
      // The Signal API is a courtesy to the browser: it never stops the page.
    }
  }
}

export interface PasskeyDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly signUpStorage: BridgeStorage;
  readonly session: Session;
  readonly ceremonies: WebAuthnCeremonies;
  readonly post: (route: (typeof ROUTES)[keyof typeof ROUTES], body: Readonly<Record<string, unknown>>) => Promise<CodeAnswer | undefined>;
  readonly waitingVerifier: (key: string) => Promise<string | null>;
  readonly signInSteps: <T>(answer: CodeAnswer | undefined, verifier: string) => Promise<T> | T;
  /** What binds a sign-in's code: this device's challenge, or the sign-in request the page signs in for. */
  readonly proofOf: (pkce: { readonly challenge: string }) => Readonly<Record<string, string>>;
  /** A provider link waiting on this device, sent with the sign-in step on a request (see sign-in.ts). */
  readonly linkFields?: () => Promise<Readonly<Record<string, string>>>;
}

export function createPasskeys<Step>(deps: PasskeyDeps) {
  const setupKey = storageKey(deps.issuer, 'passkey-setup');
  const optionsOf = (answer: unknown): Record<string, unknown> => {
    const options = (answer as { options?: unknown } | undefined)?.options;
    if (options === null || typeof options !== 'object') throw new BridgeError('unavailable', 'Bridge did not send the passkey options.');
    return options as Record<string, unknown>;
  };
  const ceremony = async <T>(run: () => Promise<T>): Promise<T> => {
    if (!deps.ceremonies.supported()) throw new BridgeError('not-supported', 'This browser cannot use passkeys.');
    try {
      return await run();
    } catch (error) {
      throw ceremonyError(error);
    }
  };
  const signedIn = async <T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', route: (typeof ROUTES)[keyof typeof ROUTES], body?: Readonly<Record<string, unknown>>, params?: Readonly<Record<string, string>>) =>
    (await call<T>(deps.fetch, deps.endpoints().url(route, params), { method, token: await deps.session.accessToken(), ...(body === undefined ? {} : { body }) })).body;

  return {
    /** Whether this browser can use passkeys. */
    supported: async (): Promise<boolean> => deps.ceremonies.supported(),
    /** Whether this browser offers passkeys in an input's autofill list. */
    autofillSupported: (): Promise<boolean> => deps.ceremonies.autofillSupported(),
    /** Stops a passkey ceremony that is waiting, such as an autofill wait when the page moves on. */
    cancel: async (): Promise<void> => deps.ceremonies.cancel(),

    /**
     * Signs in with a passkey. Resolves when signed in, or with the next
     * step (which workspace). A passkey Bridge does not know fails with
     * `wrong-credentials` and code `unknown_passkey`; one it could not
     * verify with `wrong-credentials` and code `passkey_refused`; a closed
     * dialog with `cancelled`.
     */
    async signIn(input: PasskeySignInInput = {}): Promise<Step> {
      const pkce = await createPkce();
      const options = optionsOf(await deps.post(ROUTES.passkeySignInOptions, { ...deps.proofOf(pkce), ...(input.email === undefined ? {} : { email: input.email }) }));
      const response = await ceremony(() => deps.ceremonies.get(options, input.autofill === true)).catch((error: unknown) => {
        // An autofill wait is passive: the person has asked for nothing. A browser that cannot run it (headless Chromium, a
        // browser without a passkey provider) is the same as a list that was never opened: `cancelled`, so a page stays quiet.
        if (input.autofill === true && error instanceof BridgeError && error.kind === 'not-supported') throw new BridgeError('cancelled', 'This browser cannot offer passkeys in the autofill list.', { cause: error });
        throw error;
      });
      let answer;
      try {
        answer = await deps.post(ROUTES.passkeySignIn, { response, ...(input.workspace === undefined ? {} : { workspace: input.workspace }), ...((await deps.linkFields?.()) ?? {}) });
      } catch (error) {
        // A passkey Bridge has no record of (removed, or the app's data gone): the browser is told to stop offering it.
        const rpId = typeof options['rpId'] === 'string' ? options['rpId'] : null;
        const credentialId = typeof response['id'] === 'string' ? response['id'] : null;
        if (error instanceof BridgeError && error.code === 'unknown_passkey' && rpId !== null && credentialId !== null) await deps.ceremonies.signal?.unknownCredential(rpId, credentialId).catch(() => undefined);
        throw error;
      }
      return deps.signInSteps<Step>(answer, pkce.verifier);
    },

    /** The signed-in person's passkeys, newest first. A passkey made for another domain says `usable: false`. */
    async list(): Promise<PasskeyInfo[]> {
      const listed = (await signedIn<(Omit<PasskeyInfo, 'usable'> & { usable?: boolean })[]>('GET', ROUTES.passkeys)).map((each) => ({ ...each, usable: each.usable !== false }));
      // The browser and the person's password manager stop offering passkeys that are no longer theirs.
      await signalAccepted(deps.ceremonies, listed);
      return listed;
    },

    /**
     * After the person changed their name: tells the browser and their password manager (the Signal API, where the
     * browser has it) the name (their email) and display name (their full name) to show with each of their passkeys,
     * per domain. Never fails: a browser without it, or no passkeys, does nothing.
     */
    async signalCurrentUser(name: string, displayName: string): Promise<void> {
      const signal = deps.ceremonies.signal;
      if (signal?.currentUserDetails === undefined) return;
      try {
        const seen = new Set<string>();
        for (const each of (await signedIn<PasskeyInfo[]>('GET', ROUTES.passkeys)) ?? []) {
          if (each.rpId === undefined || each.userHandle === undefined || seen.has(`${each.rpId} ${each.userHandle}`)) continue;
          seen.add(`${each.rpId} ${each.userHandle}`);
          await signal.currentUserDetails(each.rpId, each.userHandle, name, displayName);
        }
      } catch {
        // The Signal API is a courtesy to the browser: it never stops the page.
      }
    },

    /**
     * Renames one of the signed-in person's passkeys: 1 to 64 characters. Needs a recent sign-in, as adding one does:
     * otherwise it fails with `reauthenticate`.
     */
    async rename(passkeyId: string, name: string): Promise<PasskeyInfo> {
      const renamed = await signedIn<Omit<PasskeyInfo, 'usable'> & { usable?: boolean }>('PATCH', ROUTES.passkeyRename, { name }, { passkeyId });
      return { ...renamed, usable: renamed.usable !== false };
    },

    /**
     * Adds a passkey for the signed-in person, from this device. Needs a
     * recent sign-in: otherwise it fails with `reauthenticate`. A device
     * that has one already fails with `conflict`.
     */
    async add(name?: string): Promise<PasskeyInfo> {
      const options = optionsOf(await signedIn('POST', ROUTES.passkeyOptions, {}));
      const response = await ceremony(() => deps.ceremonies.create(options));
      return signedIn<PasskeyInfo>('POST', ROUTES.passkeyAdd, { response, ...(name === undefined || name === '' ? {} : { name }) });
    },

    /**
     * Removes one of the signed-in person's passkeys. Needs a recent
     * sign-in. The last way to sign in stays: removing it fails with
     * `conflict` (`last_sign_in_method`).
     */
    async remove(passkeyId: string): Promise<void> {
      await signedIn<void>('DELETE', ROUTES.passkeyRemove, undefined, { passkeyId });
      // The browser stops offering the removed one: it is told which are left. Never fails the removal.
      try {
        await signalAccepted(deps.ceremonies, (await signedIn<PasskeyInfo[]>('GET', ROUTES.passkeys)) ?? []);
      } catch {
        // Nothing to tell.
      }
    },

    setupLink: {
      /**
       * Emails a link to set up a passkey, when the address has an account.
       * The answer is the same either way. The link works once, only on
       * this device: the verifier waits in `signUpStorage` as long as the
       * link works, and nothing else is kept there.
       */
      async request(email: string): Promise<{ readonly next: 'verify_email' }> {
        const pkce = await createPkce();
        await deps.signUpStorage.set(setupKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + SETUP_KEEP_MS } satisfies StoredVerifier));
        try {
          await deps.post(ROUTES.passkeySetupLink, { email, code_challenge: pkce.challenge, code_challenge_method: 'S256' });
        } catch (error) {
          await deps.signUpStorage.remove(setupKey);
          throw error;
        }
        return { next: 'verify_email' };
      },

      /**
       * Makes a passkey from the link, on the device that asked for it, and
       * signs the person in. Opened anywhere else it fails with
       * `wrong-device`, and the link still works on the right device.
       */
      async finish(token: string, name?: string): Promise<Step> {
        const verifier = await deps.waitingVerifier(setupKey);
        const options = optionsOf(await deps.post(ROUTES.passkeySetupOptions, { token, ...(verifier === null ? {} : { code_verifier: verifier }) }));
        if (verifier === null) throw new BridgeError('wrong-device', 'Open the link on the device you asked for it on.', { code: 'wrong_device' });
        const response = await ceremony(() => deps.ceremonies.create(options));
        const answer = await deps.post(ROUTES.passkeySetup, { token, code_verifier: verifier, response, ...(name === undefined || name === '' ? {} : { name }) });
        await deps.signUpStorage.remove(setupKey);
        return deps.signInSteps<Step>(answer, verifier);
      },
    },
  };
}
