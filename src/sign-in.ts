import type { Endpoints } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { readJson, storageKey, type BridgeStorage } from './core/storage.js';
import { createPkce, isS256Challenge } from './core/util.js';
import { createPasskeys, type WebAuthnCeremonies } from './passkeys.js';
import type { Session } from './session.js';
import type { SignInPlace } from './sign-in-place.js';

/**
 * Sign-in, sign-up and password recovery, in the Child App's own pages.
 *
 * Every sign-in is a short conversation with Bridge: the SDK sends what the
 * person typed, and Bridge answers either "done" (an authorization code) or
 * the next thing it needs, such as which workspace. A code is bound to this
 * device with PKCE and traded for tokens at once.
 *
 * Today's steps are email and password, an email link that signs in (a magic
 * link), a passkey, a social provider (Google, LinkedIn, Facebook, GitHub,
 * Microsoft), the workspace choice and a text-message code (the second step,
 * for a workspace that requires it). Other steps (email codes, company login)
 * arrive as new
 * `next` values; this version refuses one it does not know with
 * `unsupported-step` rather than guessing.
 */

export interface WorkspaceChoice {
  readonly id: string;
  readonly name: string | null;
  readonly logo: string | null;
  /** Set when entering this workspace needs a step this SDK does not offer yet, such as `second_step`. */
  readonly needs?: string;
}

export type SignInStep =
  | {
      /**
       * A social sign-up with an address the provider did not confirm (Facebook): Bridge emailed `email` a link, as a password sign-up
       * does, and the person finishes by opening it in this browser (`signUp.finish`, or the app's verify-email page).
       */
      readonly done: false;
      readonly next: 'verify_email';
      readonly email: string;
    }
  | {
      readonly done: true;
      /**
       * Set when the sign-in was for another app's sign-in request (see
       * `request`): the address to send the browser to, the app's registered
       * return with `code`, `state` and `iss`. No session was made here.
       */
      readonly handoff?: string;
      /**
       * Set with `handoff` when the return goes to the person's own machine (localhost) on an app in production: the
       * page shows a Continue button and goes back only when the person presses it, never by itself.
       */
      readonly confirmReturn?: true;
      /**
       * Set when the link was one to confirm it is you (`recheck.email`): the
       * session already open here was renewed, and no new one was made.
       */
      readonly rechecked?: true;
      /**
       * Set when this sign-in also linked a provider the person tried first on this device: Bridge
       * found an account for the address that provider gave, and linked it once the person signed in the way they
       * already do. Say "<name> is now connected to your account".
       */
      readonly linked?: { readonly provider: string; readonly name: string };
      /**
       * Set once, when the person has just set up the text-message second step:
       * the backup code that resets it if they lose their phone. Show it once
       * and ask them to keep it; Bridge keeps only its hash.
       */
      readonly backupCode?: string;
    }
  | {
      readonly done: false;
      readonly next: 'workspace';
      readonly workspaces: readonly WorkspaceChoice[];
      /** Goes on with the chosen workspace. Works once. */
      choose(workspaceId: string): Promise<SignInStep>;
    }
  | {
      /** The workspace requires a second step: a code was sent by text message to `phone`. */
      readonly done: false;
      readonly next: 'second_step';
      /** The number the code went to, partly hidden, such as `+46 •••• 67`. */
      readonly phone: string;
      /** False when the message could not be sent: offer `resend`. */
      readonly sent: boolean;
      /** Goes on with the code from the message. A wrong code fails with `invalid` (`wrong_code`); five tries spend it. */
      verify(code: string): Promise<SignInStep>;
      /** Sends a new code to the same number; the one before stops working. */
      resend(): Promise<SignInStep>;
      /** Lost the phone: the backup code given at setup removes the number, and the next step sets up a new one. */
      reset(backupCode: string): Promise<SignInStep>;
    }
  | {
      /** The workspace requires a second step, and the person has no phone number set up yet. */
      readonly done: false;
      readonly next: 'second_step_setup';
      /** Sends a code to this number (with its country code, such as `+46 70 123 45 67`); the next step verifies it. */
      setUp(phone: string): Promise<SignInStep>;
    };

/** A hand-off step: like sign-in, but it ends with the code instead of trading it. */
export type HandoffStep =
  | { readonly done: true; readonly code: string }
  | {
      readonly done: false;
      readonly next: 'workspace';
      readonly workspaces: readonly WorkspaceChoice[];
      choose(workspaceId: string): Promise<HandoffStep>;
    };

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  /** Sign in straight to this workspace. */
  readonly workspace?: string;
}

export interface SignUpInput {
  readonly email: string;
  /** Leave out when the app offers no passwords (only sign-in links): the person signs in by link. */
  readonly password?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** `true` for a new workspace with no name yet, or its name. Leave out for none. */
  readonly workspace?: boolean | string;
  /**
   * Where the visit came from, for your sign-up reports: the earliest visit's campaign tags (`utm_source`, `ref`, …),
   * the latest touch when it differs, and the visitor's marketing consent. Kept with the sign-up and attached to the
   * new account once the address is proved. Leave out for none.
   */
  readonly attribution?: SignUpAttribution;
  /**
   * The plan the new workspace starts on, by its key, as a plan-specific sign-up link names it. Bridge applies it
   * when the app offers that plan, and otherwise ignores it: the app's plan at sign-up applies. Leave out for none.
   */
  readonly plan?: string;
  /**
   * With `plan`, which of the plan's prices the workspace starts on: its currency (`EUR`) and its interval (`month`).
   * Sent only with a plan and both of them; Bridge uses the plan's price that matches, if it has one.
   */
  readonly currency?: string;
  readonly interval?: 'day' | 'week' | 'month' | 'year';
}

/** A sign-up's attribution: campaign tags as plain strings, and whether the visitor consented to marketing. */
export interface SignUpAttribution {
  readonly first: Readonly<Record<string, string>>;
  readonly last?: Readonly<Record<string, string>>;
  readonly marketingConsent: boolean;
}

/** What an invite's link shows before anyone signs in. */
export type InvitePreview =
  | {
      /** The invite works: show the workspace, then sign up or sign in and accept. */
      readonly state: 'open';
      /** The inviting workspace's name and logo, as its members set them. */
      readonly workspace: { readonly name: string | null; readonly logo: string | null };
      /**
       * Whether the invited address already signs in to this app: then the
       * person signs in and accepts (`invites.accept`), otherwise signs up
       * from the invite (`invites.signUp`).
       */
      readonly account: boolean;
    }
  | {
      /** The invite no longer works: revoked, used already, or out of date (also a link that names no invite). */
      readonly state: 'revoked' | 'used' | 'expired';
    };

/** A sign-up from an invite. The invite's link proves the address, so no second email is sent. */
export interface InviteSignUpInput {
  /** The token from the invite's link. */
  readonly token: string;
  /** Leave out when the app offers no passwords (only sign-in links). */
  readonly password?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** The address the invite was sent to. Optional: when given, it must be that address. */
  readonly email?: string;
}

/** An accepted invite: the workspace the person joined, and their membership there. */
export interface AcceptedInvite {
  readonly workspace: { readonly id: string; readonly name: string | null };
  readonly member: { readonly id: string; readonly role: string | null };
}

export interface HandoffInput {
  readonly email: string;
  readonly password: string;
  /** The PKCE challenge (S256) of the program the code is for. Its verifier never comes here. */
  readonly codeChallenge: string;
  readonly workspace?: string;
}

/** What the app's sign-in page can show before anyone signs in. */
export interface SignInOptions {
  /** The app, and what its profile in Bridge gives for the page's header. */
  readonly app: {
    readonly id: string;
    readonly name?: string | null;
    readonly logo?: string | null;
    readonly website?: string | null;
    readonly privacyPolicy?: string | null;
    readonly termsOfService?: string | null;
  };
  /** Whether people may sign up. */
  readonly signUp: boolean;
  /** The sign-in methods on offer, such as `password` and `magicLink`. */
  readonly methods: readonly string[];
  /** The password's rules, to show before anyone types. Absent when the app does not offer passwords. */
  readonly password?: PasswordRules;
  /** The social providers the app offers a button for, such as `google` and `github`. */
  readonly social?: readonly SocialProvider[];
  /**
   * Where the app's users sign in: the app's "Users sign in" setting, its main address and sign-in path, and
   * where signed-out users go and land after signing out. Absent for an app from before the setting. Read it with
   * `signInPlaceOf`, `signsInOnHostedPage`, `signedOutTarget` and `hostedPageRedirect`.
   */
  readonly signIn?: Omit<SignInPlace, 'returnPath'> & { readonly returnPath?: string };
}

/** The social sign-in providers Bridge offers; Apple is Sign in with Apple on the web. */
export type SocialProvider = 'google' | 'linkedin' | 'facebook' | 'github' | 'azure' | 'apple';

/** Where a social sign-in starts, and what a sign-up through it asks for. */
export interface SocialStartInput {
  /** `sign-up` makes an account for an address that has none (when the app takes sign-ups); `sign-in` (the default) does not. */
  readonly intent?: 'sign-in' | 'sign-up';
  /** The page the provider's answer comes back to, on one of the app's browser origins. Default: this page. */
  readonly returnPage?: string;
  /** For a sign-up: as `SignUpInput`. */
  readonly workspace?: boolean | string;
  readonly attribution?: SignUpAttribution;
  readonly plan?: string;
  readonly currency?: string;
  readonly interval?: 'day' | 'week' | 'month' | 'year';
}

/** A social provider's answer, as it lands on the page: `#bridge=social&state=…&code=…`, or `&error=…`. */
export type SocialReturn = { readonly state: string; readonly code: string } | { readonly error: 'access_denied' | 'provider_error'; readonly reason?: string };

/** An app's password rules, as Bridge checks every new password against them. */
export interface PasswordRules {
  readonly minLength: number;
  readonly maxLength?: number;
  readonly requireUpper?: boolean;
  readonly requireLower?: boolean;
  readonly requireDigit?: boolean;
  readonly requireSymbol?: boolean;
  /** A password may not contain the person's email address, or the part before its `@`. */
  readonly blockEmail?: boolean;
  /** A password may not be a common one: Bridge checks it against its list, refreshed every release. */
  readonly blockCommon?: boolean;
  /** A password may not contain the app's name: Bridge checks it. */
  readonly blockAppName?: boolean;
}

/** An email link Bridge sent, as it lands on the app's page: `#bridge=<kind>&token=<token>`. */
export interface EmailLink {
  readonly kind: 'verify-email' | 'reset-password' | 'invite' | 'magic-link' | 'passkey-setup';
  readonly token: string;
}

interface CodeAnswer {
  readonly code?: unknown;
  /** A link to confirm it is you, opened: no code, the open session renewed. */
  readonly rechecked?: unknown;
  /** With `state`, on a code made for a sign-in request: where the code goes. */
  readonly redirect_uri?: unknown;
  readonly state?: unknown;
  /** With `redirect_uri`: the person confirms with a click before the browser goes back. */
  readonly confirm_return?: unknown;
  readonly next?: unknown;
  /** With `next: 'verify_email'` after a social finish: the address Bridge emailed. */
  readonly email?: unknown;
  readonly flow?: unknown;
  readonly workspaces?: unknown;
  /** The second step: the number the code went to, whether it was sent, and the backup code after setup. */
  readonly phone?: unknown;
  readonly sent?: unknown;
  readonly backup_code?: unknown;
}

interface StoredSignUp {
  readonly verifier: string;
  readonly expiresAt: number;
}

/** How long a sign-up's email link works, and so how long its verifier is kept. */
const SIGN_UP_KEEP_MS = 15 * 60 * 1000;
/** How long a sign-in link works, and so how long its verifier is kept. */
const MAGIC_LINK_KEEP_MS = 15 * 60 * 1000;
/** How long a social sign-in may take at the provider, and so how long its verifier is kept. */
const SOCIAL_KEEP_MS = 10 * 60 * 1000;

/** A provider waiting to be linked once the person signs in the way they already do: Bridge's handle and the verifier it is bound to. */
interface PendingLink {
  readonly link: string;
  readonly verifier: string;
  readonly expiresAt: number;
}

function choicesOf(value: unknown): WorkspaceChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown) => {
    const choice = each as Record<string, unknown> | null;
    if (typeof choice?.['id'] !== 'string') return [];
    return [
      {
        id: choice['id'],
        name: typeof choice['name'] === 'string' ? choice['name'] : null,
        logo: typeof choice['logo'] === 'string' ? choice['logo'] : null,
        ...(typeof choice['needs'] === 'string' ? { needs: choice['needs'] } : {}),
      },
    ];
  });
}

/** The app's return with the code, its `state` and the issuer that answered (RFC 6749, 4.1.2; RFC 9207). */
function requestReturnUrl(redirectUri: string, code: string, state: string, issuer: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

function unknownStep(next: unknown): BridgeError {
  const step = typeof next === 'string' ? next : 'unknown';
  return new BridgeError('unsupported-step', `Bridge asked for a sign-in step this SDK version does not offer: "${step}".`, { step });
}

export interface SignInDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  /** Where a sign-up's or a sign-in link's verifier waits for its email link: storage every tab of the origin shares. */
  readonly signUpStorage: BridgeStorage;
  readonly session: Session;
  /** The browser's side of a passkey ceremony. */
  readonly ceremonies: WebAuthnCeremonies;
  /** Which of the app's email-links addresses an email's link goes to; the app's first when absent. */
  readonly linkAddress?: string;
}

export function createSignIn(deps: SignInDeps) {
  const post = async (route: (typeof ROUTES)[keyof typeof ROUTES], body: Readonly<Record<string, unknown>>, token?: string) =>
    (await call<CodeAnswer>(deps.fetch, deps.endpoints().url(route), { method: 'POST', body, ...(token === undefined ? {} : { token }) })).body;
  const signUpKey = storageKey(deps.issuer, 'sign-up');
  const magicLinkKey = storageKey(deps.issuer, 'magic-link');
  const socialKey = storageKey(deps.issuer, 'social');
  /** A provider waiting to be linked: every tab of the origin reads it, as the sign-up link it came with opens in a new tab. */
  const linkKey = storageKey(deps.issuer, 'social-link');

  /**
   * After a sign-in: links the provider the person tried first on this device, when one waits. Never fails the
   * sign-in: a handle that no longer works, or an issuer that does not offer linking yet, links nothing.
   */
  async function linkWaiting(): Promise<{ readonly provider: string; readonly name: string } | null> {
    const waiting = await readJson<PendingLink>(deps.signUpStorage, linkKey);
    if (waiting === null) return null;
    await deps.signUpStorage.remove(linkKey);
    if (!(waiting.expiresAt > Date.now()) || typeof waiting.link !== 'string' || typeof waiting.verifier !== 'string') return null;
    try {
      if (!deps.endpoints().offers(ROUTES.socialLink)) return null;
      const answer = (await post(ROUTES.socialLink, { link: waiting.link, code_verifier: waiting.verifier }, await deps.session.accessToken())) as Record<string, unknown> | undefined;
      return typeof answer?.['linked'] === 'string' ? { provider: answer['linked'], name: typeof answer['name'] === 'string' ? answer['name'] : answer['linked'] } : null;
    } catch {
      return null;
    }
  }
  /** Where hosted mode keeps the app's own verifier for its sign-in request (see `hosted.ts`). */
  const hostedKey = storageKey(deps.issuer, 'hosted');
  /** The sign-in request this page signs in for, if any (see `request.use`). */
  let request: string | null = null;
  /** What binds a step's code: this device's challenge, or the request, whose challenge is the other app's. */
  const proofOf = (pkce: { readonly challenge: string }): Record<string, string> => (request === null ? { code_challenge: pkce.challenge, code_challenge_method: 'S256' } : { request });
  /** Where an email's link goes: on a request, where the request says; otherwise this page's address, if set. */
  const linkOf = (): Record<string, string> => (request === null && deps.linkAddress !== undefined ? { link_address: deps.linkAddress } : {});

  /**
   * A verifier waiting for its email link, read once: past its link's
   * lifetime it is no use to anyone and is removed; null when there is none.
   */
  async function waitingVerifier(key: string): Promise<string | null> {
    const stored = await readJson<StoredSignUp>(deps.signUpStorage, key);
    const verifier = stored !== null && stored.expiresAt > Date.now() && typeof stored.verifier === 'string' ? stored.verifier : null;
    if (stored !== null && verifier === null) await deps.signUpStorage.remove(key);
    return verifier;
  }

  /**
   * One answer of the challenge endpoint: the code, or the next step. `onCode`
   * says what happens to a code: traded here, or handed off.
   */
  function stepOf<T>(answer: CodeAnswer | undefined, onCode: (code: string) => Promise<T>, onWorkspace: (flow: string, workspaces: WorkspaceChoice[]) => T): Promise<T> | T {
    if (typeof answer?.code === 'string') return onCode(answer.code);
    if (answer?.next === 'workspace' && typeof answer.flow === 'string') return onWorkspace(answer.flow, choicesOf(answer.workspaces));
    throw unknownStep(answer?.next);
  }

  /** The text-message second step, as Bridge asks for it: the code, or a number to set up first. Its answers go on as `onward`. */
  function secondStepOf(answer: CodeAnswer, onward: (next: CodeAnswer | undefined) => Promise<SignInStep> | SignInStep): SignInStep {
    const flow = String(answer.flow);
    if (answer.next === 'second_step_setup') return { done: false, next: 'second_step_setup', setUp: async (phone) => onward(await post(ROUTES.secondStepSetup, { flow, phone })) };
    return {
      done: false,
      next: 'second_step',
      phone: typeof answer.phone === 'string' ? answer.phone : '',
      sent: answer.sent !== false,
      verify: async (code) => onward(await post(ROUTES.secondStep, { flow, code })),
      resend: async () => onward(await post(ROUTES.secondStepResend, { flow })),
      reset: async (backupCode) => onward(await post(ROUTES.secondStepReset, { flow, backup_code: backupCode })),
    };
  }

  function signInSteps(answer: CodeAnswer | undefined, verifier: string): Promise<SignInStep> | SignInStep {
    if ((answer?.next === 'second_step' || answer?.next === 'second_step_setup') && typeof answer.flow === 'string') return secondStepOf(answer, (next) => signInSteps(next, verifier));
    const backupCode = typeof answer?.backup_code === 'string' ? { backupCode: answer.backup_code } : {};
    return stepOf<SignInStep>(
      answer,
      async (code) => {
        // A code made for a sign-in request is the other app's: it goes to the app's return, and is never traded here.
        if (typeof answer?.redirect_uri === 'string' && typeof answer.state === 'string') return { done: true, handoff: requestReturnUrl(answer.redirect_uri, code, answer.state, deps.issuer), ...(answer.confirm_return === true ? { confirmReturn: true as const } : {}), ...backupCode };
        await deps.session.exchangeCode(code, verifier);
        const linked = await linkWaiting();
        return { done: true, ...backupCode, ...(linked === null ? {} : { linked }) };
      },
      (flow, workspaces) => ({
        done: false,
        next: 'workspace',
        workspaces,
        choose: async (workspace) => signInSteps(await post(ROUTES.signIn, { flow, workspace }), verifier),
      }),
    );
  }

  function handoffSteps(answer: CodeAnswer | undefined): Promise<HandoffStep> | HandoffStep {
    return stepOf<HandoffStep>(
      answer,
      (code) => Promise.resolve({ done: true, code }),
      (flow, workspaces) => ({
        done: false,
        next: 'workspace',
        workspaces,
        choose: async (workspace) => handoffSteps(await post(ROUTES.signIn, { flow, workspace })),
      }),
    );
  }

  return {
    signIn: {
      /** Signs in with email and password. Resolves when signed in, or with the next step. */
      async start(input: SignInInput): Promise<SignInStep> {
        const pkce = await createPkce();
        const answer = await post(ROUTES.signIn, {
          email: input.email,
          password: input.password,
          ...proofOf(pkce),
          ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        });
        return signInSteps(answer, pkce.verifier);
      },

      /**
       * Signs in for another program on this device, such as a command-line
       * tool: with its PKCE challenge, ending with the code instead of
       * tokens. The program trades the code with its own verifier, so no
       * token ever reaches this page.
       */
      async handoff(input: HandoffInput): Promise<HandoffStep> {
        if (!isS256Challenge(input.codeChallenge)) throw new BridgeError('invalid', 'The code challenge must be an S256 challenge: 43 base64url characters.');
        const answer = await post(ROUTES.signIn, {
          email: input.email,
          password: input.password,
          code_challenge: input.codeChallenge,
          code_challenge_method: 'S256',
          ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        });
        return handoffSteps(answer);
      },

      /** What the sign-in page can show: the app's name and logo, and whether sign-up is open. */
      async options(): Promise<SignInOptions> {
        return (await call<SignInOptions>(deps.fetch, deps.endpoints().url(ROUTES.signInOptions), { method: 'GET' })).body;
      },
    },

    signUp: {
      /**
       * Starts a sign-up. Nothing is made until the address is proved: Bridge
       * sends an email link, and the answer is the same whether or not the
       * address already has an account.
       */
      async start(input: SignUpInput): Promise<{ readonly next: 'verify_email' }> {
        const pkce = await createPkce();
        // The link opens in a new tab: keep the verifier where that tab can read it. The latest sign-up wins.
        await deps.signUpStorage.set(signUpKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + SIGN_UP_KEEP_MS } satisfies StoredSignUp));
        // On a sign-in request, this device's challenge still binds the link to it: only the code is the other app's.
        await post(ROUTES.signUp, {
          email: input.email,
          ...(input.password === undefined ? {} : { password: input.password }),
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
          ...(request === null ? {} : { request }),
          ...linkOf(),
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
          ...(input.workspace === undefined || input.workspace === false ? {} : { workspace: input.workspace }),
          ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
          ...(input.plan === undefined || input.plan === '' ? {} : { plan: input.plan }),
          ...(input.plan === undefined || input.plan === '' || !input.currency || !input.interval ? {} : { currency: input.currency, interval: input.interval }),
        });
        return { next: 'verify_email' };
      },

      /**
       * Finishes a sign-up from its email link, on the device that started
       * it. Opened anywhere else, it fails with `wrong-device`, and the link
       * still works on the right device. A sign-up started with no password
       * on an app that takes passwords fails with the code
       * `password_required` until it is finished with one: ask the person to
       * choose it, then call this again with it. The link stays usable.
       */
      async finish(token: string, password?: string): Promise<SignInStep> {
        const verifier = await waitingVerifier(signUpKey);
        const answer = await post(ROUTES.signUpVerify, { token, ...(verifier === null ? {} : { code_verifier: verifier }), ...(password === undefined ? {} : { password }) });
        if (verifier === null) throw new BridgeError('wrong-device', 'This link finishes the sign-up only in the browser where it was started. Open it there, or sign up again here.', { code: 'wrong_device' });
        // Bridge took the verifier: it is spent, and the rest needs it only in memory.
        await deps.signUpStorage.remove(signUpKey);
        return signInSteps(answer, verifier);
      },
    },

    magicLink: {
      /**
       * Sends a link that signs in to the address, when it has an account
       * and the app offers sign-in links. The answer is the same either way.
       * The link works once, for a short time, and only on this device: the
       * verifier waits in `signUpStorage` until the link opens, at most as
       * long as the link works. A newer link replaces an older one. On a
       * sign-in request the link is bound to this device the same way, and
       * its code is the other app's.
       */
      async start(email: string): Promise<{ readonly next: 'verify_email' }> {
        const pkce = await createPkce();
        await deps.signUpStorage.set(magicLinkKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + MAGIC_LINK_KEEP_MS } satisfies StoredSignUp));
        try {
          // On a sign-in request, this device's challenge still binds the link to it: only the code is the other app's.
          await post(ROUTES.magicLink, { email, code_challenge: pkce.challenge, code_challenge_method: 'S256', ...(request === null ? linkOf() : { request }) });
        } catch (error) {
          // Nothing was sent: no verifier waits for a link that will not come.
          await deps.signUpStorage.remove(magicLinkKey);
          throw error;
        }
        return { next: 'verify_email' };
      },

      /**
       * Signs in from a sign-in link, on the device that asked for it. Opened
       * anywhere else, it fails with `wrong-device`, and the link still works
       * on the right device. A link used once, or too old, fails with
       * `link-invalid`.
       */
      async finish(token: string): Promise<SignInStep> {
        const own = await waitingVerifier(magicLinkKey);
        // A link sent for this app's hosted sign-in, landed on the app's own page: the app's verifier for its request opens it.
        const verifier = own ?? (await waitingVerifier(hostedKey));
        const answer = await post(ROUTES.magicLinkVerify, { token, ...(verifier === null ? {} : { code_verifier: verifier }) });
        if (verifier === null) throw new BridgeError('wrong-device', 'Open the link on the device you asked for it on.', { code: 'wrong_device' });
        // Bridge took the verifier: it is spent. The app's own verifier stays, for its return to trade the code with.
        if (own !== null) await deps.signUpStorage.remove(magicLinkKey);
        // A link to confirm it is you: the session open here was renewed. Its next tokens reach every tab.
        if (answer?.rechecked === true) {
          await deps.session.refresh({ force: true });
          return { done: true, rechecked: true };
        }
        // A link sent for a sign-in request answers with the other app's code, which goes to its return.
        if (typeof answer?.redirect_uri === 'string') return signInSteps(answer, '');
        return signInSteps(answer, verifier);
      },
    },

    social: {
      /**
       * Starts signing in, or up, with a social provider the app offers
       * (`options().social`): answers the provider's address, for the page to
       * send the browser to. The provider's answer comes back to `returnPage`
       * (this page by default) as `#bridge=social&…`: finish it there with
       * `takeSocialReturn` and `finish`, in this browser. On a sign-in
       * request, the sign-in ends with the other app's code, as every step.
       */
      async start(provider: SocialProvider, input: SocialStartInput = {}): Promise<string> {
        const pkce = await createPkce();
        const page = input.returnPage ?? (typeof window === 'undefined' ? undefined : `${window.location.origin}${window.location.pathname}${window.location.search}`);
        if (page === undefined) throw new BridgeError('invalid', 'Name the page the provider comes back to: returnPage.');
        await deps.signUpStorage.set(socialKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + SOCIAL_KEEP_MS, provider } satisfies StoredSignUp & { provider: SocialProvider }));
        const signingUp = input.intent === 'sign-up';
        const answer = (await post(ROUTES.socialStart, {
          provider,
          intent: signingUp ? 'sign-up' : 'sign-in',
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
          return_page: page,
          ...(request === null ? {} : { request }),
          ...(signingUp && input.workspace !== undefined && input.workspace !== false ? { workspace: input.workspace } : {}),
          ...(signingUp && input.attribution !== undefined ? { attribution: input.attribution } : {}),
          ...(signingUp && input.plan !== undefined && input.plan !== '' ? { plan: input.plan } : {}),
          ...(signingUp && input.plan !== undefined && input.plan !== '' && input.currency && input.interval ? { currency: input.currency, interval: input.interval } : {}),
        })) as Record<string, unknown> | undefined;
        const url = answer?.['url'];
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new BridgeError('unavailable', 'Bridge did not give the provider\'s address.');
        return url;
      },

      /**
       * Finishes a social sign-in from the provider's answer (`takeSocialReturn`),
       * in the browser that started it: elsewhere it fails with `wrong-device`.
       * An address the provider does not vouch for fails with `invalid`
       * (`email_not_verified`); signing in with an address that has no account,
       * with `invalid` (`no_account`): sign up instead. Facebook gives an
       * address without saying it confirmed it: a sign-up through it answers
       * the step `verify_email` (Bridge emailed its own link; an address that
       * already has an account gets the same answer and is never linked).
       */
      async finish(answer: SocialReturn): Promise<SignInStep> {
        if ('error' in answer) throw new BridgeError(answer.error === 'access_denied' ? 'cancelled' : 'unavailable', answer.error === 'access_denied' ? 'The sign-in was cancelled at the provider.' : 'The provider did not confirm the sign-in. Try again.', { code: answer.error, ...(answer.error === 'provider_error' && answer.reason !== undefined ? { reason: answer.reason } : {}) });
        const started = await readJson<{ provider?: unknown }>(deps.signUpStorage, socialKey);
        const verifier = await waitingVerifier(socialKey);
        let reply;
        try {
          reply = await post(ROUTES.socialFinish, { state: answer.state, code: answer.code, ...(verifier === null ? {} : { code_verifier: verifier }) });
        } catch (error) {
          // No account for the address: the error's `reason` names the provider used, so the page can offer
          // "Create an account with <provider>" in one click (`start(provider, { intent: 'sign-up' })`).
          if (error instanceof BridgeError && error.code === 'no_account' && typeof started?.provider === 'string') throw new BridgeError(error.kind, error.message, { status: error.status, code: error.code, reason: started.provider, cause: error });
          throw error;
        }
        if (verifier === null) throw new BridgeError('wrong-device', 'Finish signing in in the browser you started in.', { code: 'wrong_device' });
        await deps.signUpStorage.remove(socialKey);
        // An address the provider did not confirm (Facebook): Bridge emailed its own link, as a password sign-up does. The link opens in a
        // new tab and finishes the sign-up only with this device's verifier, so it waits where a sign-up's does.
        if (reply?.next === 'verify_email') {
          await deps.signUpStorage.set(signUpKey, JSON.stringify({ verifier, expiresAt: Date.now() + SIGN_UP_KEEP_MS } satisfies StoredSignUp));
          // Link required: when the address has an account, the person signs in the way they already do, on this
          // device, and the provider is linked then. Bridge gives the handle either way, so nothing says whether it has one.
          const link = (reply as Record<string, unknown>)['link'];
          if (typeof link === 'string' && link !== '') await deps.signUpStorage.set(linkKey, JSON.stringify({ link, verifier, expiresAt: Date.now() + SOCIAL_KEEP_MS } satisfies PendingLink));
          return { done: false, next: 'verify_email', email: typeof reply.email === 'string' ? reply.email : '' };
        }
        // On a sign-in request the code is the other app's, and goes to its return.
        if (typeof reply?.redirect_uri === 'string') return signInSteps(reply, '');
        return signInSteps(reply, verifier);
      },
    },

    passkeys: createPasskeys<SignInStep>({ ...deps, post, waitingVerifier, proofOf, signInSteps: (answer, verifier) => signInSteps(answer, verifier) as never }),

    request: {
      /**
       * Signs in for another app's sign-in request, as Bridge's hosted page
       * does: the app started the request with its own PKCE challenge, its
       * registered return and its `state`, and sent the browser here with
       * the request's id. From now on every sign-in step sends the request
       * instead of this device's challenge, and a finished one ends with
       * `handoff`, the address to send the browser to, instead of a session.
       * This page never holds the app's verifier, so only the app can trade
       * the code. A sign-in link sent on a request opens in any tab of this
       * browser, and nowhere else.
       */
      async use(id: string): Promise<void> {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new BridgeError('invalid', 'A sign-in request id is 16 to 100 base64url characters.');
        request = id;
      },
      /** The request this page signs in for, or null. */
      async current(): Promise<string | null> {
        return request;
      },
    },

    password: {
      /** Sends a reset link when the address has an account. The answer is the same either way. */
      async forgot(email: string): Promise<void> {
        await post(ROUTES.passwordForgot, { email, ...linkOf() });
      },
      /** Sets a new password from a reset link. Signs nobody in, and ends every session of the account. */
      async set(token: string, password: string): Promise<void> {
        await post(ROUTES.passwordSet, { token, password });
      },
    },

    invites: {
      /**
       * What an invite's link shows before anyone signs in: whether it still
       * works, the inviting workspace, and whether the invited address
       * already has an account. It never says the address, the role or who
       * invited. The token goes in the request body, never in an address.
       */
      async preview(token: string): Promise<InvitePreview> {
        const answer = (await call<Record<string, unknown>>(deps.fetch, deps.endpoints().url(ROUTES.invitePreview), { method: 'POST', body: { token } })).body;
        const state = answer?.['state'];
        if (state === 'open') {
          const workspace = (answer?.['workspace'] ?? {}) as Record<string, unknown>;
          return {
            state,
            workspace: {
              name: typeof workspace['name'] === 'string' ? workspace['name'] : null,
              logo: typeof workspace['logo'] === 'string' ? workspace['logo'] : null,
            },
            account: answer?.['account'] === true,
          };
        }
        if (state === 'revoked' || state === 'used') return { state };
        return { state: 'expired' };
      },

      /**
       * Signs up from an invite and signs the new person in, in the inviting
       * workspace with the invited role. The link proves the address, so no
       * email is sent and nothing is kept for a later tab: the code comes back
       * at once and is traded here. An address that already has an account
       * gets `conflict` (`account_exists`): sign in, then `accept`.
       */
      async signUp(input: InviteSignUpInput): Promise<SignInStep> {
        const pkce = await createPkce();
        const answer = await post(ROUTES.signUp, {
          invite: input.token,
          ...(input.password === undefined ? {} : { password: input.password }),
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        });
        return signInSteps(answer, pkce.verifier);
      },

      /**
       * Accepts an invite as the signed-in person, then moves the session
       * into the workspace they joined. Only the person the invite was sent
       * to can accept it: anyone else gets `forbidden`
       * (`invite_for_another_address`), and a member already gets `conflict`
       * (`already_member`).
       */
      async accept(token: string): Promise<AcceptedInvite> {
        // An issuer that does not offer invites says so before anyone is asked to sign in.
        deps.endpoints().url(ROUTES.inviteAccept);
        const answer = (await post(ROUTES.inviteAccept, { token }, await deps.session.accessToken())) as Record<string, unknown> | undefined;
        const workspace = (answer?.['workspace'] ?? {}) as Record<string, unknown>;
        const member = (answer?.['member'] ?? {}) as Record<string, unknown>;
        if (typeof workspace['id'] !== 'string' || workspace['id'] === '') {
          throw new BridgeError('unavailable', 'Bridge accepted the invite but did not name the workspace.');
        }
        const accepted: AcceptedInvite = {
          workspace: { id: workspace['id'], name: typeof workspace['name'] === 'string' ? workspace['name'] : null },
          member: { id: typeof member['id'] === 'string' ? member['id'] : '', role: typeof member['role'] === 'string' ? member['role'] : null },
        };
        await deps.session.refresh({ workspace: accepted.workspace.id });
        return accepted;
      },
    },
  };
}

/**
 * Reads an email link from the page's address: Bridge puts the token in the
 * fragment (`#bridge=verify-email&token=…`), which never reaches a server
 * log or a Referer header. Returns null when the address carries none.
 */
export function readEmailLink(hashOrUrl: string): EmailLink | null {
  const hash = hashOrUrl.includes('#') ? hashOrUrl.slice(hashOrUrl.indexOf('#') + 1) : hashOrUrl;
  const params = new URLSearchParams(hash);
  const kind = params.get('bridge');
  const token = params.get('token');
  if (token === null || token === '') return null;
  if (kind !== 'verify-email' && kind !== 'reset-password' && kind !== 'invite' && kind !== 'magic-link' && kind !== 'passkey-setup') return null;
  return { kind, token };
}

/**
 * Reads a social provider's answer from the page's address
 * (`#bridge=social&state=…&code=…`, or `&error=…`). Null when there is none.
 */
export function readSocialReturn(hashOrUrl: string): SocialReturn | null {
  const hash = hashOrUrl.includes('#') ? hashOrUrl.slice(hashOrUrl.indexOf('#') + 1) : hashOrUrl;
  const params = new URLSearchParams(hash);
  if (params.get('bridge') !== 'social') return null;
  const error = params.get('error');
  if (error !== null) {
    if (error === 'access_denied') return { error };
    // What Microsoft's error meant, when Bridge knows: a short word, never the provider's own text.
    const reason = params.get('reason');
    return reason !== null && /^[a-z_]{1,40}$/.test(reason) ? { error: 'provider_error', reason } : { error: 'provider_error' };
  }
  const state = params.get('state');
  const code = params.get('code');
  return state === null || state === '' || code === null || code === '' ? null : { state, code };
}

/** Takes a social provider's answer from the page's address and clears it, as `takeEmailLink` does. Null when there is none. */
export function takeSocialReturn(win: EmailLinkWindow | undefined = typeof window === 'undefined' ? undefined : window): SocialReturn | null {
  if (win === undefined) return null;
  const answer = readSocialReturn(win.location.hash);
  if (answer === null) return null;
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
  return answer;
}

/** The parts of a window `takeEmailLink` reads and changes. */
export interface EmailLinkWindow {
  readonly location: { readonly hash: string; readonly pathname: string; readonly search: string };
  readonly history: { readonly state: unknown; replaceState(data: unknown, unused: string, url?: string): void };
}

/**
 * Takes the email link from the page's address and clears it, so its token
 * does not stay in the address bar, the history or a bookmark. Only a
 * Bridge link is taken (`#bridge=…&token=…`); any other fragment is left as
 * it is. With `kind`, only a link of that kind. Returns null when the page
 * carries none, or outside a browser.
 */
export function takeEmailLink(kind?: EmailLink['kind'], win: EmailLinkWindow | undefined = typeof window === 'undefined' ? undefined : window): EmailLink | null {
  if (win === undefined) return null;
  const link = readEmailLink(win.location.hash);
  if (link === null || (kind !== undefined && link.kind !== kind)) return null;
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
  return link;
}
