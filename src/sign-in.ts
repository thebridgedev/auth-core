import type { Endpoints } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { readJson, storageKey, type BridgeStorage } from './core/storage.js';
import { createPkce, isS256Challenge } from './core/util.js';
import type { Session } from './session.js';

/**
 * Sign-in, sign-up and password recovery, in the Child App's own pages.
 *
 * Every sign-in is a short conversation with Bridge: the SDK sends what the
 * person typed, and Bridge answers either "done" (an authorization code) or
 * the next thing it needs, such as which workspace. A code is bound to this
 * device with PKCE and traded for tokens at once.
 *
 * Today's steps are email and password and the workspace choice. Other steps
 * (a second factor, passkeys, email codes, company login) arrive as new
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
  | { readonly done: true }
  | {
      readonly done: false;
      readonly next: 'workspace';
      readonly workspaces: readonly WorkspaceChoice[];
      /** Goes on with the chosen workspace. Works once. */
      choose(workspaceId: string): Promise<SignInStep>;
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
  readonly password: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** `true` for a new workspace with no name yet, or its name. Leave out for none. */
  readonly workspace?: boolean | string;
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
  readonly password: string;
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
  /** The sign-in methods on offer, such as `password`. */
  readonly methods: readonly string[];
  readonly password: { readonly minLength: number; readonly maxLength?: number };
}

/** An email link Bridge sent, as it lands on the app's page: `#bridge=<kind>&token=<token>`. */
export interface EmailLink {
  readonly kind: 'verify-email' | 'reset-password' | 'invite';
  readonly token: string;
}

interface CodeAnswer {
  readonly code?: unknown;
  readonly next?: unknown;
  readonly flow?: unknown;
  readonly workspaces?: unknown;
}

interface StoredSignUp {
  readonly verifier: string;
  readonly expiresAt: number;
}

/** How long a sign-up's email link works, and so how long its verifier is kept. */
const SIGN_UP_KEEP_MS = 15 * 60 * 1000;

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

function unknownStep(next: unknown): BridgeError {
  const step = typeof next === 'string' ? next : 'unknown';
  return new BridgeError('unsupported-step', `Bridge asked for a sign-in step this SDK version does not offer: "${step}".`, { step });
}

export interface SignInDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  /** Where a sign-up's verifier waits for its email link: storage every tab of the origin shares. */
  readonly signUpStorage: BridgeStorage;
  readonly session: Session;
}

export function createSignIn(deps: SignInDeps) {
  const post = async (route: (typeof ROUTES)[keyof typeof ROUTES], body: Readonly<Record<string, unknown>>, token?: string) =>
    (await call<CodeAnswer>(deps.fetch, deps.endpoints().url(route), { method: 'POST', body, ...(token === undefined ? {} : { token }) })).body;
  const signUpKey = storageKey(deps.issuer, 'sign-up');

  /**
   * One answer of the challenge endpoint: the code, or the next step. `onCode`
   * says what happens to a code: traded here, or handed off.
   */
  function stepOf<T>(answer: CodeAnswer | undefined, onCode: (code: string) => Promise<T>, onWorkspace: (flow: string, workspaces: WorkspaceChoice[]) => T): Promise<T> | T {
    if (typeof answer?.code === 'string') return onCode(answer.code);
    if (answer?.next === 'workspace' && typeof answer.flow === 'string') return onWorkspace(answer.flow, choicesOf(answer.workspaces));
    throw unknownStep(answer?.next);
  }

  function signInSteps(answer: CodeAnswer | undefined, verifier: string): Promise<SignInStep> | SignInStep {
    return stepOf<SignInStep>(
      answer,
      async (code) => {
        await deps.session.exchangeCode(code, verifier);
        return { done: true };
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
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
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
        await post(ROUTES.signUp, {
          email: input.email,
          password: input.password,
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
          ...(input.workspace === undefined || input.workspace === false ? {} : { workspace: input.workspace }),
        });
        return { next: 'verify_email' };
      },

      /**
       * Finishes a sign-up from its email link, on the device that started
       * it. Opened anywhere else, it fails with `wrong-device`, and the link
       * still works on the right device.
       */
      async finish(token: string): Promise<SignInStep> {
        const stored = await readJson<StoredSignUp>(deps.signUpStorage, signUpKey);
        const verifier = stored !== null && stored.expiresAt > Date.now() && typeof stored.verifier === 'string' ? stored.verifier : null;
        // Past its link's lifetime the verifier is no use to anyone: it is not kept.
        if (stored !== null && verifier === null) await deps.signUpStorage.remove(signUpKey);
        const answer = await post(ROUTES.signUpVerify, { token, ...(verifier === null ? {} : { code_verifier: verifier }) });
        if (verifier === null) throw new BridgeError('wrong-device', 'Open the link on the device you signed up on.', { code: 'wrong_device' });
        // Bridge took the verifier: it is spent, and the rest needs it only in memory.
        await deps.signUpStorage.remove(signUpKey);
        return signInSteps(answer, verifier);
      },
    },

    password: {
      /** Sends a reset link when the address has an account. The answer is the same either way. */
      async forgot(email: string): Promise<void> {
        await post(ROUTES.passwordForgot, { email });
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
          password: input.password,
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
  if (kind !== 'verify-email' && kind !== 'reset-password' && kind !== 'invite') return null;
  return { kind, token };
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
