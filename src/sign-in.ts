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
  /** An invite to accept on the way in. Needs an issuer that accepts invites at sign-in. */
  readonly invite?: string;
}

export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** `true` for a new workspace with no name yet, or its name. Leave out for none. */
  readonly workspace?: boolean | string;
  /** An invite to accept once the address is proved. Needs an issuer that accepts invites at sign-up. */
  readonly invite?: string;
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
  readonly app: {
    readonly name: string | null;
    readonly logo: string | null;
    readonly website: string | null;
    readonly privacyPolicy: string | null;
    readonly termsOfService: string | null;
  };
  readonly signUp: boolean;
  readonly methods: readonly string[];
  readonly password: { readonly minLength: number };
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
  readonly storage: BridgeStorage;
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
          ...(input.invite === undefined ? {} : { invite: input.invite }),
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
        await deps.storage.set(signUpKey, JSON.stringify({ verifier: pkce.verifier, expiresAt: Date.now() + SIGN_UP_KEEP_MS } satisfies StoredSignUp));
        await post(ROUTES.signUp, {
          email: input.email,
          password: input.password,
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
          ...(input.workspace === undefined || input.workspace === false ? {} : { workspace: input.workspace }),
          ...(input.invite === undefined ? {} : { invite: input.invite }),
        });
        return { next: 'verify_email' };
      },

      /**
       * Finishes a sign-up from its email link, on the device that started
       * it. Opened anywhere else, it fails with `wrong-device`, and the link
       * still works on the right device.
       */
      async finish(token: string): Promise<SignInStep> {
        const stored = await readJson<StoredSignUp>(deps.storage, signUpKey);
        const verifier = stored !== null && stored.expiresAt > Date.now() && typeof stored.verifier === 'string' ? stored.verifier : null;
        const answer = await post(ROUTES.signUpVerify, { token, ...(verifier === null ? {} : { code_verifier: verifier }) });
        if (verifier === null) throw new BridgeError('wrong-device', 'Open the link on the device you signed up on.', { code: 'wrong_device' });
        const step = await signInSteps(answer, verifier);
        await deps.storage.remove(signUpKey);
        return step;
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
      /** Shows an invite before anyone signs in: the workspace and when it expires. */
      async preview(token: string): Promise<unknown> {
        return (await call<unknown>(deps.fetch, deps.endpoints().url(ROUTES.invitePreview, { token }), { method: 'GET' })).body;
      },
      /** Accepts an invite as the signed-in person, then moves the session into the new workspace. */
      async accept(token: string): Promise<void> {
        const answer = await post(ROUTES.inviteAccept, { invite: token }, await deps.session.accessToken());
        const workspace = (answer as { workspace?: unknown } | undefined)?.workspace;
        await deps.session.refresh(typeof workspace === 'string' ? { workspace } : { force: true });
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
