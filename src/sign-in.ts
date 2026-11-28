import type { Endpoints } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { readJson, storageKey, type BridgeStorage } from './core/storage.js';
import { createPkce, isS256Challenge } from './core/util.js';
import { createPasskeys, type PasskeyAfterReset, type WebAuthnCeremonies } from './passkeys.js';
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
 * link) or a code sent by email (on an app set to codes), a passkey, a social
 * provider (Google, LinkedIn, Facebook, GitHub, Microsoft), the workspace
 * choice and the second step (an authenticator app, an email code or a
 * text-message code, or a recovery code). Other steps (company login)
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
  /** The workspace requires its company login: show a lock; `needs` is `required_connection` until this sign-in went through it. */
  readonly companyLogin?: boolean;
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
      /**
       * Set once, when the person has just set up an authenticator app or a phone on the way: their recovery codes, each
       * of which finishes the second step once. Show them once (copy, download, print, "I've saved these"); Bridge keeps
       * only their hashes.
       */
      readonly recoveryCodes?: readonly string[];
      /** Set when a recovery code finished the second step: how many are left. */
      readonly recoveryCodesLeft?: number;
      /** Set when the person asked to remember this device: the days the second step is skipped here. The SDK keeps the device's secret. */
      readonly rememberedForDays?: number;
    }
  | {
      readonly done: false;
      readonly next: 'workspace';
      readonly workspaces: readonly WorkspaceChoice[];
      /** Goes on with the chosen workspace. Works once. */
      choose(workspaceId: string): Promise<SignInStep>;
    }
  | {
      /**
       * The sign-in needs a second step (the app or the workspace requires it, or the person turned it on): a code from
       * the person's authenticator app (`totp`), or one Bridge sent by email (`email`) or by text message (`sms`).
       */
      readonly done: false;
      readonly next: 'second_step';
      /** The way the code is asked for now. An older Bridge, which only texts, gives none: `sms`. */
      readonly method: SecondStepMethod;
      /** Every way this person may use here, the one asked for first: offer the others as "Use another way" (`chooseMethod`). */
      readonly methods: readonly SecondStepMethod[];
      /** For `sms`: the number the code went to, partly hidden, such as `+46 •••• 67`. Empty for the other ways. */
      readonly phone: string;
      /** For `email`: the address the code went to, partly hidden, such as `a…@acme.com`. */
      readonly email?: string;
      /** False when the message could not be sent: offer `resend`. Always true for an authenticator app. */
      readonly sent: boolean;
      /** For a sent code: how long it works, and how long until a new one may be asked for, in seconds. */
      readonly expiresIn?: number;
      readonly resendIn?: number;
      /** How many days "Remember this device" skips the second step on this device; 0 when the app does not offer it. */
      readonly rememberDays: number;
      /** Whether the person has recovery codes (or a backup code): offer `useRecoveryCode`. */
      readonly recovery: boolean;
      /** `texts_unavailable`: the code came by email because texts are not available now. Say so plainly. */
      readonly note?: 'texts_unavailable';
      /**
       * Set while an authenticator app is being set up on the way (`setUpTotp`): the key to type, in groups, and the
       * `otpauth://` address to draw as a QR code. The app's first code then finishes it (`verify`).
       */
      readonly setup?: { readonly secret: string; readonly uri: string };
      /**
       * Goes on with the code. A wrong code fails with `invalid` (`wrong_code`, `triesLeft`); five tries spend it
       * (`code_expired`). With `remember`, this device skips the second step for `rememberDays`.
       */
      verify(code: string, options?: { readonly remember?: boolean }): Promise<SignInStep>;
      /** Goes on with one of the person's recovery codes, which is spent. A wrong one fails with `invalid` (`wrong_recovery_code`). */
      useRecoveryCode(code: string, options?: { readonly remember?: boolean }): Promise<SignInStep>;
      /** "Use another way": asks by another of `methods` (an email code or a text is sent then). */
      chooseMethod(method: SecondStepMethod): Promise<SignInStep>;
      /** Sends a new code the same way; the one before stops working. Within its wait it fails with `rate-limited` (`too_soon`). */
      resend(): Promise<SignInStep>;
      /** Lost the phone: the backup code given at a text-message setup removes the number, and the next step sets up a new one. */
      reset(backupCode: string): Promise<SignInStep>;
    }
  | {
      /** The sign-in needs a second step, and the person has no way set up yet: an authenticator app or a phone, set up now. */
      readonly done: false;
      readonly next: 'second_step_setup';
      /** The ways that may be set up here. An older Bridge, which only texts, gives none: `['sms']`. */
      readonly methods: readonly SecondStepMethod[];
      /** Sends a code to this number (with its country code, such as `+46 70 123 45 67`); the next step verifies it. */
      setUp(phone: string): Promise<SignInStep>;
      /** Starts setting up an authenticator app: the next step carries `setup` (the QR code and the key) and takes its first code. */
      setUpTotp(): Promise<SignInStep>;
    };

/** The ways of the second step: an authenticator app, a code by email, a code by text message. */
export type SecondStepMethod = 'totp' | 'email' | 'sms';

/**
 * A code Bridge emailed, waiting to be typed on this device: the address it went to, partly hidden, how long
 * it works and how long until a new one may be asked for. Bridge answers the same whether or not the address has an
 * account, so the page always shows this.
 */
export interface EmailCodeStep<Done> {
  readonly done: false;
  readonly next: 'verify_code';
  /** The address, partly hidden, such as `a…@acme.com`. */
  readonly email: string;
  /** Seconds the code works (10 minutes). */
  readonly expiresIn: number;
  /** Seconds until `resend` may be used (60). */
  readonly resendIn: number;
  /**
   * Goes on with the six-digit code. Refusals: `invalid` with code `wrong_code` (and `triesLeft`), `code_expired` (too
   * old, or five tries used: ask for a new one), `wrong-device`, or `flow-expired` (start again).
   */
  verify(code: string): Promise<Done>;
  /** Sends a new code; the one before stops working. Within its wait it fails with `rate-limited` (`too_soon`, `retryAfterSeconds`). */
  resend(): Promise<EmailCodeStep<Done>>;
}

/**
 * A sign-up's code. `verify(code)` finishes the sign-up; a sign-up started without a password, on an app that
 * takes passwords, fails with `invalid` (`password_required`) once the code is right: the address is proved, so ask
 * for the password (the app's rules: `options().password`) and finish with `choosePassword`.
 */
export interface SignUpCodeStep extends EmailCodeStep<SignInStep> {
  verify(code: string, password?: string): Promise<SignInStep>;
  /** After `password_required`: finishes the sign-up with the password, without the code. */
  choosePassword(password: string): Promise<SignInStep>;
  resend(): Promise<SignUpCodeStep>;
}

/** Forgot password's code was right: the token to set a new password with (`password.set`), for 10 minutes. It signs nobody in. */
export interface PasswordResetToken {
  readonly next: 'reset_password';
  readonly token: string;
  readonly expiresIn: number;
}

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
  /** Whether the app has a company login on: show "Sign in with SSO". Never which company, never for whom. */
  readonly companyLogin?: boolean;
  /** When the app offers a passkey: after a sign-in another way, and made by the browser on its own. Absent: passkeys off. */
  readonly passkeyOffer?: { readonly afterSignIn: boolean; readonly automatic: boolean };
  /**
   * Where the app's users sign in: the app's "Users sign in" setting, its main address and sign-in path, and
   * where signed-out users go and land after signing out. Absent for an app from before the setting. Read it with
   * `signInPlaceOf`, `signsInOnHostedPage`, `signedOutTarget` and `hostedPageRedirect`.
   */
  readonly signIn?: Omit<SignInPlace, 'returnPath'> & { readonly returnPath?: string };
  /**
   * How an email proves the address: `code` (a six-digit code, typed here: `emailCode.request`, and sign-up
   * and forgot password answer a code step) or `link` (an email link, as before). Absent from an older Bridge: `link`.
   * Read it with `emailConfirmationOf`.
   */
  readonly emailConfirmation?: 'code' | 'link';
  /** The second step, as the app sets it: whether it is on, the ways it allows, and how many days a device may be remembered. */
  readonly secondStep?: { readonly on: boolean; readonly methods: readonly SecondStepMethod[]; readonly rememberDeviceDays: number };
}

/** How the app's emails prove the address: `code` or `link` (an older Bridge, which says nothing, sends links). */
export function emailConfirmationOf(options: Pick<SignInOptions, 'emailConfirmation'> | null | undefined): 'code' | 'link' {
  return options?.emailConfirmation === 'code' ? 'code' : 'link';
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

/**
 * A company sign-in for an address that already has an account here: the person signs in the way they already do,
 * once, in this browser, and the company's login is linked to the same account then (that sign-in's `linked`).
 * Nothing is linked until they do. Only `companyLogin.finish` answers it.
 */
export interface CompanyLinkRequired {
  readonly done: false;
  readonly next: 'link_required';
  readonly email: string;
  /** The company's name, as the app's owner named its connection. */
  readonly name: string;
}

/** Which company login to start: by work email ("Sign in with SSO"), by a workspace that requires it, or the portal's connection. */
export type CompanyLoginStart = ({ readonly email: string } | { readonly workspace: string } | { readonly connection: string }) & {
  /** The page the company's answer comes back to, on one of the app's browser origins. Default: this page. */
  readonly returnPage?: string;
};

/**
 * The company's answer, as it lands on the page: `#bridge=company&state=…` (`&code=…` for OpenID Connect), or `&error=…`;
 * or the company's portal asking for a sign-in to start, `#bridge=company-start&connection=…`.
 */
export type CompanyReturn = { readonly state: string; readonly code?: string } | { readonly error: string } | { readonly start: string };

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
  /** On a sign-in request, a provider this device tried first, linked as the code was made. */
  readonly linked?: unknown;
  readonly next?: unknown;
  /** With `next: 'verify_email'` after a social finish: the address Bridge emailed. */
  readonly email?: unknown;
  readonly flow?: unknown;
  readonly workspaces?: unknown;
  /** The second step: the number the code went to, whether it was sent, and the backup code after setup. */
  readonly phone?: unknown;
  readonly sent?: unknown;
  readonly backup_code?: unknown;
  /** The second step's ways: the one asked for, the others, remembering this device, recovery, and what to show once. */
  readonly method?: unknown;
  readonly methods?: unknown;
  readonly remember_days?: unknown;
  readonly recovery?: unknown;
  readonly note?: unknown;
  readonly setup?: unknown;
  readonly expires_in?: unknown;
  readonly resend_in?: unknown;
  readonly remember_device?: unknown;
  readonly recovery_codes?: unknown;
  readonly recovery_codes_left?: unknown;
  readonly token?: unknown;
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
        ...(choice['companyLogin'] === true ? { companyLogin: true } : {}),
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

const METHODS: readonly SecondStepMethod[] = ['totp', 'email', 'sms'];
function methodsOf(value: unknown, fallback: readonly SecondStepMethod[]): SecondStepMethod[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((each): each is SecondStepMethod => METHODS.includes(each as SecondStepMethod));
}
const seconds = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** A device remembered for the second step: Bridge's secret for it, until it expires. */
interface RememberedDevice {
  readonly device: string;
  readonly expiresAt: number;
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
  const companyKey = storageKey(deps.issuer, 'company');
  /** A provider waiting to be linked: every tab of the origin reads it, as the sign-up link it came with opens in a new tab. */
  const linkKey = storageKey(deps.issuer, 'social-link');
  /** This device, remembered for the second step: one per app, in storage every tab of the origin shares. */
  const deviceKey = storageKey(deps.issuer, 'device');

  /** The remembered device's secret, to send as `device` with a sign-in: none when there is none, or it expired. */
  async function deviceOf(): Promise<Record<string, string>> {
    const kept = await readJson<RememberedDevice>(deps.signUpStorage, deviceKey);
    if (kept === null) return {};
    if (typeof kept.device !== 'string' || !(kept.expiresAt > Date.now())) {
      await deps.signUpStorage.remove(deviceKey);
      return {};
    }
    return { device: kept.device };
  }

  /** Keeps the device's secret when the person asked to be remembered here, for the days Bridge said. */
  async function keepDevice(answer: CodeAnswer | undefined): Promise<number | null> {
    const days = seconds(answer?.remember_days);
    if (typeof answer?.remember_device !== 'string' || days === undefined || days <= 0) return null;
    await deps.signUpStorage.set(deviceKey, JSON.stringify({ device: answer.remember_device, expiresAt: Date.now() + days * 86_400_000 } satisfies RememberedDevice));
    return days;
  }

  /** A code screen's answer (`next: 'verify_code'`) as a step: its flow, what it shows, and how it goes on. */
  function codeStepOf<Done>(answer: CodeAnswer | undefined, verify: (flow: string, code: string) => Promise<Done>, resendRoute: (typeof ROUTES)[keyof typeof ROUTES]): EmailCodeStep<Done> {
    if (answer?.next !== 'verify_code' || typeof answer.flow !== 'string') throw unknownStep(answer?.next);
    const flow = answer.flow;
    return {
      done: false,
      next: 'verify_code',
      email: typeof answer.email === 'string' ? answer.email : '',
      expiresIn: seconds(answer.expires_in) ?? 600,
      resendIn: seconds(answer.resend_in) ?? 60,
      verify: (code) => verify(flow, code.replace(/\s/g, '')),
      resend: async () => codeStepOf(await post(resendRoute, { flow }), verify, resendRoute),
    };
  }

  /**
   * After a sign-in: links the provider the person tried first on this device, when one waits. Never fails the
   * sign-in: a handle that no longer works, or an issuer that does not offer linking yet, links nothing.
   */
  /**
   * A provider waiting to be linked, sent with a sign-in step: on a sign-in request (Bridge's hosted page), which never
   * holds the person's token, Bridge links it as the request's code is made, when the step proved the login the link
   * names on the device that tried the provider. Elsewhere Bridge takes no notice, and it is linked after the sign-in.
   */
  async function linkFields(): Promise<Record<string, string>> {
    const waiting = await readJson<PendingLink>(deps.signUpStorage, linkKey);
    if (waiting === null || !(waiting.expiresAt > Date.now()) || typeof waiting.link !== 'string' || typeof waiting.verifier !== 'string') return {};
    return { link: waiting.link, link_verifier: waiting.verifier };
  }
  /** What a code made on a request says it linked: the waiting link is spent then. */
  async function linkedOnRequest(answer: CodeAnswer | undefined): Promise<{ readonly linked?: { readonly provider: string; readonly name: string } }> {
    const linked = answer?.linked as { provider?: unknown; name?: unknown } | undefined;
    if (typeof linked?.provider !== 'string') return {};
    await deps.signUpStorage.remove(linkKey);
    return { linked: { provider: linked.provider, name: typeof linked.name === 'string' ? linked.name : linked.provider } };
  }

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

  /**
   * The second step, as Bridge asks for it: a code by the way it names (an authenticator app, an email, a text), or a
   * way to set up first. An older Bridge names no way: it texts. Its answers go on as `onward`.
   */
  function secondStepOf(answer: CodeAnswer, onward: (next: CodeAnswer | undefined) => Promise<SignInStep> | SignInStep): SignInStep {
    const flow = String(answer.flow);
    if (answer.next === 'second_step_setup') {
      return {
        done: false,
        next: 'second_step_setup',
        methods: methodsOf(answer.methods, ['sms']),
        setUp: async (phone) => onward(await post(ROUTES.secondStepSetup, { flow, phone })),
        setUpTotp: async () => onward(await post(ROUTES.secondStepSetup, { flow, method: 'totp' })),
      };
    }
    const method: SecondStepMethod = METHODS.includes(answer.method as SecondStepMethod) ? (answer.method as SecondStepMethod) : 'sms';
    const given = answer.setup as { secret?: unknown; uri?: unknown } | null | undefined;
    const setup = typeof given?.secret === 'string' && typeof given.uri === 'string' && given.uri.startsWith('otpauth://') ? { setup: { secret: given.secret, uri: given.uri } } : {};
    const remember = (options?: { readonly remember?: boolean }) => (options?.remember === true ? { remember: true } : {});
    const expiresIn = seconds(answer.expires_in);
    const resendIn = seconds(answer.resend_in);
    return {
      done: false,
      next: 'second_step',
      method,
      methods: methodsOf(answer.methods, [method]),
      phone: typeof answer.phone === 'string' ? answer.phone : '',
      ...(typeof answer.email === 'string' ? { email: answer.email } : {}),
      sent: answer.sent !== false,
      ...(expiresIn === undefined ? {} : { expiresIn }),
      ...(resendIn === undefined ? {} : { resendIn }),
      rememberDays: seconds(answer.remember_days) ?? 0,
      // An older Bridge says nothing: a texted second step has its backup code.
      recovery: answer.recovery === undefined ? answer.method === undefined : answer.recovery === true,
      ...(answer.note === 'texts_unavailable' ? { note: 'texts_unavailable' as const } : {}),
      ...setup,
      verify: async (code, options) => onward(await post(ROUTES.secondStep, { flow, code: code.replace(/[\s-]/g, ''), ...remember(options) })),
      useRecoveryCode: async (code, options) => onward(await post(ROUTES.secondStep, { flow, recovery_code: code.trim(), ...remember(options) })),
      chooseMethod: async (chosen) => onward(await post(ROUTES.secondStepMethod, { flow, method: chosen })),
      resend: async () => onward(await post(ROUTES.secondStepResend, { flow })),
      reset: async (backupCode) => onward(await post(ROUTES.secondStepReset, { flow, backup_code: backupCode })),
    };
  }

  /** What a finished second step shows once: recovery codes, how many are left, and the days this device is remembered (kept here). */
  async function shownOnce(answer: CodeAnswer | undefined): Promise<{ recoveryCodes?: readonly string[]; recoveryCodesLeft?: number; rememberedForDays?: number }> {
    const codes = Array.isArray(answer?.recovery_codes) ? answer.recovery_codes.filter((each): each is string => typeof each === 'string') : [];
    const left = seconds(answer?.recovery_codes_left);
    const remembered = await keepDevice(answer);
    return { ...(codes.length > 0 ? { recoveryCodes: codes } : {}), ...(left === undefined ? {} : { recoveryCodesLeft: left }), ...(remembered === null ? {} : { rememberedForDays: remembered }) };
  }

  function signInSteps(answer: CodeAnswer | undefined, verifier: string): Promise<SignInStep> | SignInStep {
    if ((answer?.next === 'second_step' || answer?.next === 'second_step_setup') && typeof answer.flow === 'string') return secondStepOf(answer, (next) => signInSteps(next, verifier));
    const backupCode = typeof answer?.backup_code === 'string' ? { backupCode: answer.backup_code } : {};
    return stepOf<SignInStep>(
      answer,
      async (code) => {
        const once = await shownOnce(answer);
        // A code made for a sign-in request is the other app's: it goes to the app's return, and is never traded here.
        if (typeof answer?.redirect_uri === 'string' && typeof answer.state === 'string') return { done: true, handoff: requestReturnUrl(answer.redirect_uri, code, answer.state, deps.issuer), ...(answer.confirm_return === true ? { confirmReturn: true as const } : {}), ...backupCode, ...once, ...(await linkedOnRequest(answer)) };
        await deps.session.exchangeCode(code, verifier);
        const linked = await linkWaiting();
        return { done: true, ...backupCode, ...once, ...(linked === null ? {} : { linked }) };
      },
      (flow, workspaces) => ({
        done: false,
        next: 'workspace',
        workspaces,
        // The second step may come after the workspace: a remembered device skips it there too.
        choose: async (workspace) => signInSteps(await post(ROUTES.signIn, { flow, workspace, ...(await deviceOf()) }), verifier),
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

  /** A sign-up's code step: the code finishes the sign-up; a password asked for afterwards finishes it without the code. */
  function signUpCodeStep(answer: CodeAnswer | undefined, verifier: string): SignUpCodeStep {
    const finish = async (flow: string, body: Readonly<Record<string, unknown>>) => {
      const done = await post(ROUTES.signUpCode, { flow, code_verifier: verifier, ...body });
      return typeof done?.redirect_uri === 'string' ? signInSteps(done, '') : signInSteps(done, verifier);
    };
    let flow = '';
    const wrap = (step: EmailCodeStep<SignInStep>): SignUpCodeStep => ({
      ...step,
      verify: (code: string, password?: string) => finish(flow, { code: code.replace(/\s/g, ''), ...(password === undefined ? {} : { password }) }),
      choosePassword: (password: string) => finish(flow, { password }),
      resend: async () => {
        const again = await post(ROUTES.signUpResend, { flow });
        flow = typeof again?.flow === 'string' ? again.flow : flow;
        return wrap(codeStepOf(again, (_, code) => finish(flow, { code }), ROUTES.signUpResend));
      },
    });
    flow = typeof answer?.flow === 'string' ? answer.flow : '';
    return wrap(codeStepOf(answer, (_, code) => finish(flow, { code }), ROUTES.signUpResend));
  }

  /** Forgot password's code step: a right code gives the token to choose a new password with. */
  function resetCodeStep(answer: CodeAnswer | undefined): EmailCodeStep<PasswordResetToken> {
    return codeStepOf<PasswordResetToken>(
      answer,
      async (flow, code) => {
        const proved = await post(ROUTES.passwordForgotVerify, { flow, code });
        if (proved?.next !== 'reset_password' || typeof proved.token !== 'string') throw unknownStep(proved?.next);
        return { next: 'reset_password', token: proved.token, expiresIn: seconds(proved.expires_in) ?? 600 };
      },
      ROUTES.passwordForgotResend,
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
          ...(await deviceOf()),
          ...(request === null ? {} : await linkFields()),
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
      async start(input: SignUpInput): Promise<{ readonly next: 'verify_email' } | SignUpCodeStep> {
        const pkce = await createPkce();
        // The link opens in a new tab: keep the verifier where that tab can read it. The latest sign-up wins.
        await deps.signUpStorage.set(signUpKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + SIGN_UP_KEEP_MS } satisfies StoredSignUp));
        // On a sign-in request, this device's challenge still binds the link to it: only the code is the other app's.
        const answer = await post(ROUTES.signUp, {
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
        // An app set to codes: the code is typed here, so the verifier stays in memory and no link waits for it.
        if (answer?.next === 'verify_code') {
          await deps.signUpStorage.remove(signUpKey);
          return signUpCodeStep(answer, pkce.verifier);
        }
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
        const answer = await post(ROUTES.magicLinkVerify, { token, ...(verifier === null ? {} : { code_verifier: verifier }), ...(verifier === null ? {} : await deviceOf()), ...(await linkFields()) });
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

    emailCode: {
      /**
       * Emails a six-digit code that signs in to the address, on an app set to codes (`emailConfirmationOf(options) ===
       * 'code'`; an app on links refuses it with `forbidden`, `method_disabled`). The answer is the same whether or not
       * the address has an account. The code works on this device only, for 10 minutes and five tries; a new one may be
       * asked for after 60 seconds. On a sign-in request the sign-in ends with the other app's code, as every step.
       */
      async request(email: string): Promise<EmailCodeStep<SignInStep>> {
        const pkce = await createPkce();
        // This device's challenge binds the code to it, on a sign-in request too: only the code it ends with is the other app's.
        const answer = await post(ROUTES.emailCode, { email, code_challenge: pkce.challenge, code_challenge_method: 'S256', ...(request === null ? {} : { request }) });
        return codeStepOf<SignInStep>(
          answer,
          async (flow, code) => {
            const done = await post(ROUTES.emailCodeVerify, { flow, code, code_verifier: pkce.verifier, ...(await deviceOf()) });
            return typeof done?.redirect_uri === 'string' ? signInSteps(done, '') : signInSteps(done, pkce.verifier);
          },
          ROUTES.emailCodeResend,
        );
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

    companyLogin: {
      /**
       * Starts a company sign-in: by the person's work email ("Sign in with SSO"), by a workspace that requires
       * its company login (a choice whose `needs` is `required_connection`), or by the connection the company's portal
       * named (`takeCompanyReturn` gives `{ start }`). Answers the company's login to send the browser to. Its answer
       * comes back to `returnPage` (this page by default) as `#bridge=company&…`: finish it there with `finish`, in this
       * browser. An address no company covers fails with `invalid` (`no_company_login`).
       */
      async start(input: CompanyLoginStart): Promise<string> {
        const pkce = await createPkce();
        const page = input.returnPage ?? (typeof window === 'undefined' ? undefined : `${window.location.origin}${window.location.pathname}${window.location.search}`);
        if (page === undefined) throw new BridgeError('invalid', "Name the page the company's login comes back to: returnPage.");
        await deps.signUpStorage.set(companyKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + SOCIAL_KEEP_MS } satisfies StoredSignUp));
        const which = 'email' in input ? { email: input.email } : 'workspace' in input ? { workspace: input.workspace } : { connection: input.connection };
        const answer = (await post(ROUTES.companyLoginStart, { ...which, code_challenge: pkce.challenge, code_challenge_method: 'S256', return_page: page, ...(request === null ? {} : { request }) })) as Record<string, unknown> | undefined;
        const url = answer?.['url'];
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new BridgeError('unavailable', "Bridge did not give the company login's address.");
        return url;
      },

      /**
       * Finishes a company sign-in from its answer (`takeCompanyReturn`), in the browser that started it. A first-time
       * employee gets an account in the company's workspace; an address that already has an account answers the step
       * `link_required`: sign in the way they already do, and the company's login is linked then.
       */
      async finish(answer: CompanyReturn): Promise<SignInStep | CompanyLinkRequired> {
        if ('start' in answer) throw new BridgeError('invalid', 'Start a company sign-in with companyLogin.start({ connection }) first.');
        if ('error' in answer) throw new BridgeError('unavailable', "The company's login did not confirm the sign-in. Try again.", { code: answer.error });
        const verifier = await waitingVerifier(companyKey);
        const reply = await post(ROUTES.companyLoginFinish, { state: answer.state, ...(answer.code === undefined ? {} : { code: answer.code }), ...(verifier === null ? {} : { code_verifier: verifier }) });
        if (verifier === null) throw new BridgeError('wrong-device', 'Finish signing in in the browser you started in.', { code: 'wrong_device' });
        await deps.signUpStorage.remove(companyKey);
        const said = reply as Record<string, unknown> | undefined;
        if (said?.['next'] === 'link_required') {
          const link = said['link'];
          if (typeof link === 'string' && link !== '') await deps.signUpStorage.set(linkKey, JSON.stringify({ link, verifier, expiresAt: Date.now() + SOCIAL_KEEP_MS } satisfies PendingLink));
          return { done: false, next: 'link_required', email: typeof said['email'] === 'string' ? said['email'] : '', name: typeof said['name'] === 'string' ? said['name'] : '' };
        }
        if (typeof reply?.redirect_uri === 'string') return signInSteps(reply, '');
        return signInSteps(reply, verifier);
      },
    },

    passkeys: createPasskeys<SignInStep>({ ...deps, post, waitingVerifier, proofOf, linkFields: async () => (request === null ? {} : linkFields()), signInSteps: (answer, verifier) => signInSteps(answer, verifier) as never }),

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
      /**
       * Sends a reset link when the address has an account. The answer is the same either way. On an app set to codes
       * it answers the code step instead: the right code gives the token for `set`, and a code reset never
       * signs anyone in.
       */
      async forgot(email: string): Promise<EmailCodeStep<PasswordResetToken> | undefined> {
        const answer = await post(ROUTES.passwordForgot, { email, ...linkOf() });
        return answer?.next === 'verify_code' ? resetCodeStep(answer) : undefined;
      },
      /**
       * Changes the signed-in person's password: with their current password, or within 10 minutes of a sign-in
       * without it. Refusals: `invalid` with code `wrong_password`, or `password_rules` with `failed` (`history`: used
       * recently); `reauthenticate` when neither was given. The person's other sessions end; this one stays.
       */
      async change(input: { readonly current?: string; readonly password: string }): Promise<void> {
        await call(deps.fetch, deps.endpoints().url(ROUTES.passwordChange), { method: 'POST', token: await deps.session.accessToken(), body: { ...(input.current === undefined || input.current === '' ? {} : { current: input.current }), password: input.password } });
      },
      /**
       * Sets a new password from a reset link. Signs nobody in, and ends every session of the account. When Bridge would
       * offer the person a passkey, the answer's `afterReset` adds one on this browser with
       * `passkeys.addAfterReset`, within minutes and once.
       */
      async set(token: string, password: string): Promise<{ readonly afterReset: PasskeyAfterReset | null }> {
        const pkce = await createPkce();
        const answer = (await post(ROUTES.passwordSet, { token, password, code_challenge: pkce.challenge, code_challenge_method: 'S256' })) as unknown as { passkeyPass?: unknown } | undefined;
        const pass = answer?.passkeyPass;
        return { afterReset: typeof pass === 'string' && pass !== '' ? { pass, verifier: pkce.verifier } : null };
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

/**
 * Reads a company login's answer from the page's address: `#bridge=company&state=…` (with `&code=…` for OpenID
 * Connect) or `&error=…`, or the company's portal asking to start, `#bridge=company-start&connection=…`. Null for none.
 */
export function readCompanyReturn(hashOrUrl: string): CompanyReturn | null {
  const hash = hashOrUrl.includes('#') ? hashOrUrl.slice(hashOrUrl.indexOf('#') + 1) : hashOrUrl;
  const params = new URLSearchParams(hash);
  const kind = params.get('bridge');
  if (kind === 'company-start') {
    const connection = params.get('connection');
    return connection !== null && /^[A-Za-z0-9_-]{1,64}$/.test(connection) ? { start: connection } : null;
  }
  if (kind !== 'company') return null;
  const error = params.get('error');
  if (error !== null) return { error: /^[a-z_]{1,40}$/.test(error) ? error : 'company_login_refused' };
  const state = params.get('state');
  const code = params.get('code');
  if (state === null || state === '') return null;
  return code === null || code === '' ? { state } : { state, code };
}

/** Takes a company login's answer from the page's address and clears it, as `takeSocialReturn` does. Null when there is none. */
export function takeCompanyReturn(win: EmailLinkWindow | undefined = typeof window === 'undefined' ? undefined : window): CompanyReturn | null {
  if (win === undefined) return null;
  const answer = readCompanyReturn(win.location.hash);
  if (answer === null) return null;
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
  return answer;
}
