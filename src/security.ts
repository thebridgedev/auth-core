import type { Endpoints } from './core/discovery.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { storageKey, type BridgeStorage } from './core/storage.js';
import type { Session } from './session.js';
import type { SecondStepMethod } from './sign-in.js';

/**
 * Two-step verification, for the signed-in person's Security settings: what is set up, adding an
 * authenticator app or a phone, which way is used first, turning it on for oneself, removing a way, new recovery codes
 * and forgetting remembered devices. Every change needs a recent sign-in: otherwise it fails with `reauthenticate`, which
 * `recheck.guard` asks the person to confirm and tries once more.
 */

/** One way the person has set up. */
export interface SecondStepWay {
  readonly method: SecondStepMethod;
  /** The way the second step asks for first. */
  readonly first: boolean;
  /** For `sms`: the number, partly hidden. */
  readonly phone?: string;
  /** For `email`: the address, partly hidden. */
  readonly email?: string;
  readonly setUpAt?: string | null;
}

/** What the Security settings show. */
export interface SecurityStatus {
  /** Whether the app offers two-step verification at all. */
  readonly available: boolean;
  /** Where the app requires it: in workspaces that ask for it, or for everyone. */
  readonly requiredIn: 'workspaces' | 'all';
  /** The ways the app allows. */
  readonly allowed: readonly SecondStepMethod[];
  /** Whether it is on for this person: the app requires it for everyone, or they turned it on. */
  readonly on: boolean;
  /** Whether the person turned it on themselves. */
  readonly self: boolean;
  /** The ways the person may use, the first one first. */
  readonly methods: readonly SecondStepWay[];
  /** Whether an authenticator app or a phone is set up. */
  readonly setUp: boolean;
  readonly recoveryCodesLeft: number;
  /** How many devices skip the second step now. */
  readonly rememberedDevices: number;
  readonly rememberDeviceDays: number;
  /** The strongest way: an authenticator app. */
  readonly strongest: SecondStepMethod;
}

/** A change that set a way up: the status, and the recovery codes when this was the first way (shown once). */
export type SecuritySetUp = SecurityStatus & { readonly recoveryCodes?: readonly string[] };

export interface SecurityDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly session: Session;
  /** Where the sign-in keeps this device's remembered secret: forgetting devices forgets it here too. */
  readonly signUpStorage: BridgeStorage;
}

const METHODS: readonly SecondStepMethod[] = ['totp', 'email', 'sms'];

/** Bridge's answer as a status: unknown ways and fields dropped. */
export function securityStatusOf(answer: unknown): SecurityStatus {
  const record = (answer ?? {}) as Record<string, unknown>;
  const methods = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is SecondStepMethod => METHODS.includes(each as SecondStepMethod)) : []);
  const ways = Array.isArray(record['methods'])
    ? record['methods'].flatMap((each: unknown) => {
        const way = (each ?? {}) as Record<string, unknown>;
        if (!METHODS.includes(way['method'] as SecondStepMethod)) return [];
        return [
          {
            method: way['method'] as SecondStepMethod,
            first: way['first'] === true,
            ...(typeof way['phone'] === 'string' ? { phone: way['phone'] } : {}),
            ...(typeof way['email'] === 'string' ? { email: way['email'] } : {}),
            ...(typeof way['setUpAt'] === 'string' || way['setUpAt'] === null ? { setUpAt: way['setUpAt'] as string | null } : {}),
          },
        ];
      })
    : [];
  const count = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : 0);
  return {
    available: record['available'] === true,
    requiredIn: record['requiredIn'] === 'all' ? 'all' : 'workspaces',
    allowed: methods(record['allowed']),
    on: record['on'] === true,
    self: record['self'] === true,
    methods: ways,
    setUp: record['setUp'] === true,
    recoveryCodesLeft: count(record['recoveryCodesLeft']),
    rememberedDevices: count(record['rememberedDevices']),
    rememberDeviceDays: count(record['rememberDeviceDays']),
    strongest: METHODS.includes(record['strongest'] as SecondStepMethod) ? (record['strongest'] as SecondStepMethod) : 'totp',
  };
}

function setUpOf(answer: unknown): SecuritySetUp {
  const codes = (answer as { recovery_codes?: unknown } | undefined)?.recovery_codes;
  const recoveryCodes = Array.isArray(codes) ? codes.filter((each): each is string => typeof each === 'string') : [];
  return { ...securityStatusOf(answer), ...(recoveryCodes.length > 0 ? { recoveryCodes } : {}) };
}

export function createSecurity(deps: SecurityDeps) {
  const signedIn = async <T>(route: (typeof ROUTES)[keyof typeof ROUTES], body?: Readonly<Record<string, unknown>>, params?: Readonly<Record<string, string>>) =>
    (await call<T>(deps.fetch, deps.endpoints().url(route, params), { method: route.method, token: await deps.session.accessToken(), ...(body === undefined ? {} : { body }) })).body;
  const code = (typed: string) => typed.replace(/[\s-]/g, '');

  return {
    /** Whether the issuer offers the Security settings yet. */
    offered: (): boolean => deps.endpoints().offers(ROUTES.security),

    /** What is set up, and what the app allows. */
    async status(): Promise<SecurityStatus> {
      return securityStatusOf(await signedIn(ROUTES.security));
    },

    /**
     * "Use first" (`first`) and turning two-step verification on or off for oneself (`on`). Turning it on with no way to
     * use fails with `invalid` (`set_up_first`): set up an authenticator app or a phone first.
     */
    async change(input: { readonly first?: SecondStepMethod; readonly on?: boolean }): Promise<SecurityStatus> {
      return securityStatusOf(await signedIn(ROUTES.securityChange, { ...(input.first === undefined ? {} : { first: input.first }), ...(input.on === undefined ? {} : { on: input.on }) }));
    },

    totp: {
      /** Starts adding an authenticator app: the key to type and the `otpauth://` address to draw as a QR code, for 10 minutes. */
      async start(): Promise<{ readonly secret: string; readonly uri: string; readonly expiresIn: number }> {
        const answer = (await signedIn<Record<string, unknown>>(ROUTES.securityTotp, {})) ?? {};
        return { secret: String(answer['secret'] ?? ''), uri: String(answer['uri'] ?? ''), expiresIn: typeof answer['expires_in'] === 'number' ? answer['expires_in'] : 600 };
      },
      /** The app's first code proves it: it is used first from now on. A wrong code fails with `invalid` (`wrong_code`). */
      async confirm(typed: string): Promise<SecuritySetUp> {
        return setUpOf(await signedIn(ROUTES.securityTotpConfirm, { code: code(typed) }));
      },
    },

    sms: {
      /** Sends a code to this number (with its country code), where the app allows texts. */
      async start(phone: string): Promise<{ readonly phone: string; readonly sent: boolean }> {
        const answer = (await signedIn<Record<string, unknown>>(ROUTES.securitySms, { phone })) ?? {};
        return { phone: typeof answer['phone'] === 'string' ? answer['phone'] : '', sent: answer['sent'] !== false };
      },
      /** The texted code proves the number: it is used first from now on. */
      async confirm(typed: string): Promise<SecuritySetUp> {
        return setUpOf(await signedIn(ROUTES.securitySmsConfirm, { code: code(typed) }));
      },
    },

    /** Removes the authenticator app or the phone. The email is the account's own and is never removed. */
    async remove(method: 'totp' | 'sms'): Promise<SecurityStatus> {
      return securityStatusOf(await signedIn(ROUTES.securityRemove, undefined, { method }));
    },

    /** Ten new recovery codes, which replace every old one (and a texted step's backup code). Show them once. */
    async newRecoveryCodes(): Promise<readonly string[]> {
      const answer = (await signedIn<{ recovery_codes?: unknown }>(ROUTES.securityRecoveryCodes, {})) ?? {};
      return Array.isArray(answer.recovery_codes) ? answer.recovery_codes.filter((each): each is string => typeof each === 'string') : [];
    },

    /** Every remembered device, this one too, asks for the second step again at its next sign-in. */
    async forgetDevices(): Promise<void> {
      await signedIn<void>(ROUTES.securityForgetDevices);
      await deps.signUpStorage.remove(storageKey(deps.issuer, 'device'));
    },
  };
}

export type Security = ReturnType<typeof createSecurity>;
