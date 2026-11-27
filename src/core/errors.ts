/**
 * One error type for everything the SDK refuses or Bridge answers with a
 * refusal. Read `kind` to decide what to show; `status` and `code` are there
 * for logs.
 *
 * Bridge answers in two shapes, and both become a `BridgeError`:
 *
 * - problem details (RFC 9457): `{ type, title, status, detail }`, from every
 *   API route;
 * - OAuth errors: `{ error, error_description }`, from sign-in and the token
 *   endpoint.
 */

/** What went wrong, in one word. */
import type { BillingStatus } from '../billing.js';

export type BridgeErrorKind =
  /** The email or password is wrong, or the address has no account. Bridge never says which. */
  | 'wrong-credentials'
  /** An email link was opened on a device other than the one that started the flow. The link stays usable there. */
  | 'wrong-device'
  /** An email link is unknown, used or expired. */
  | 'link-invalid'
  /** A sign-in step took too long; start again. */
  | 'flow-expired'
  /** There is no session, or it ended. Sign in again. */
  | 'signed-out'
  /** The action needs a recent sign-in. Ask the person to sign in again. */
  | 'reauthenticate'
  /** The caller may not do this. */
  | 'forbidden'
  /** The record does not exist, or is out of the caller's reach. */
  | 'not-found'
  /** The plan does not include this. `entitlement` names what is missing. */
  | 'plan-required'
  /** The change conflicts with a record that exists. */
  | 'conflict'
  /** The request itself is malformed. `message` says why. */
  | 'invalid'
  /**
   * Too many requests. `retryAfterSeconds` says when to try again. At sign-in, `code` is `too_many_attempts` (the
   * account or this network address is paused: show `login.error.tooManyAttempts` with {@link waitMinutes}, or `login.error.tooManyAttemptsOneMinute` when it is 1) or
   * `account_locked` (locked until the password is reset: `login.error.accountLocked`). Bridge answers both the same
   * whether or not the email has an account.
   */
  | 'rate-limited'
  /** Bridge could not decide right now. Never treat this as a yes; try again later. */
  | 'unavailable'
  /** The request did not reach Bridge. */
  | 'network'
  /** This page's origin is not one of the app's browser addresses. */
  | 'origin-not-allowed'
  /** Sign-in asked for a step this SDK version does not know yet. `step` names it. */
  | 'unsupported-step'
  /** The issuer does not offer this yet. */
  | 'not-offered'
  /** The SDK is set up wrongly, or the issuer's metadata is not usable. */
  | 'misconfigured'
  /** The person closed the passkey dialog, or it timed out. */
  | 'cancelled'
  /** This browser cannot use passkeys, or could not use this one. */
  | 'not-supported';

/** An RFC 9457 problem, as Bridge sent it. */
export interface Problem {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly [extension: string]: unknown;
}

export interface BridgeErrorInit {
  readonly status?: number;
  readonly code?: string | null;
  readonly retryAfterSeconds?: number | null;
  readonly entitlement?: string | null;
  readonly step?: string | null;
  readonly problem?: Problem | null;
  readonly quota?: LimitReached | null;
  readonly signInUrl?: string | null;
  readonly failed?: readonly string[] | null;
  readonly reason?: string | null;
  readonly triesLeft?: number | null;
  readonly cause?: unknown;
}

/** What a refused hold says about the plan's limit: the metric, the limit and how much of it is used. */
export interface LimitReached {
  readonly metric: string;
  readonly limit: number;
  readonly used: number;
}

export class BridgeError extends Error {
  override readonly name = 'BridgeError';
  readonly kind: BridgeErrorKind;
  /** The HTTP status, or 0 when there was no answer. */
  readonly status: number;
  /** Bridge's own code: the OAuth `error`, or the last part of the problem's `type`. */
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  /** For `plan-required`: the plan feature that is missing. */
  readonly entitlement: string | null;
  /** For `unsupported-step`: the step sign-in asked for. */
  readonly step: string | null;
  readonly problem: Problem | null;
  /** For a refusal because the plan's limit is reached (`limit-reached`): the metric, the limit and what is used. */
  readonly quota: LimitReached | null;
  /**
   * For `passkey_on_app_page`: the app's own sign-in page, where the passkey belongs (an http or https address). Bridge's
   * pages hand a passkey sign-in over to it.
   */
  readonly signInUrl: string | null;
  /** For `password_change_required`: which of the app's password rules the person's password breaks. Never the password. */
  readonly failed: readonly string[] | null;
  /**
   * For `microsoft_account_not_allowed`: `personal`, `work` or `directory` (who can sign in turned the account away). For
   * `provider_error`: what Microsoft's error means, when Bridge knows it (`secret_expired`, `wrong_return_address`,
   * `wrong_account_types`, `app_not_in_directory`, `admin_approval_needed`). For `password_change_required`: `expired`
   * when the password is older than the app allows, absent when the app's rules changed.
   */
  readonly reason: string | null;
  /** For `wrong_code` (an email code or a second step's code): how many tries the code has left; 0 means ask for a new one. */
  readonly triesLeft: number | null;

  constructor(kind: BridgeErrorKind, message: string, init: BridgeErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.entitlement = init.entitlement ?? null;
    this.step = init.step ?? null;
    this.problem = init.problem ?? null;
    this.quota = init.quota ?? null;
    this.signInUrl = init.signInUrl ?? null;
    this.failed = init.failed ?? null;
    this.reason = init.reason ?? null;
    this.triesLeft = init.triesLeft ?? null;
  }
}

/** What a lock says: the billing status it was found in, and where to recover. */
export interface BillingLockedPayload {
  readonly reason: 'billing_locked';
  readonly billing: {
    readonly status: BillingStatus;
    readonly gateEngaged: boolean;
    readonly recoveryUrl?: string;
  };
}

/** Where a locked workspace is sent to pay and come back, unless Bridge says another. */
const LOCK_RECOVERY_URL = '/subscription';

/**
 * The refusal of a change in a workspace locked for payment (402), as 0.9 threw it: `code` is `BILLING_GATE_ENGAGED`
 * and `payload` says the status and where to recover. `reason` is what Bridge itself calls the refusal
 * (`billing-locked`), for code that matches on Bridge's own codes. This is also what `assertNotLocked()` throws.
 */
export class BillingLockedError extends BridgeError {
  readonly payload: BillingLockedPayload;
  /** Bridge's own name for this refusal. */
  readonly reason = 'billing-locked' as const;
  constructor(payload: BillingLockedPayload, init: BridgeErrorInit = {}) {
    super('plan-required', 'Billing gate engaged — workspace access is locked', { ...init, status: 402, code: 'BILLING_GATE_ENGAGED' });
    (this as { name: string }).name = 'BillingLockedError';
    this.payload = payload;
  }
}

/** Every name a lock goes by: Bridge's problem type, and the code the 0.9 plugins and Child Apps answered with. */
const LOCK_NAMES: readonly string[] = ['billing-locked', 'BILLING_GATE_ENGAGED'];
const PROBLEM_PREFIX = 'urn:bridge:problem:';
const isLockName = (value: unknown): boolean => typeof value === 'string' && LOCK_NAMES.includes(value.startsWith(PROBLEM_PREFIX) ? value.slice(PROBLEM_PREFIX.length) : value);

/** True for a refusal because the workspace is locked for payment: a {@link BillingLockedError} or Bridge's own 402 `billing-locked`. */
export function isBillingLocked(error: unknown): boolean {
  if (!isBridgeError(error) || error.status !== 402) return false;
  return isLockName(error.code) || isLockName(error.problem?.type);
}

/** Whether a passkey was refused because it did no fingerprint, face or PIN check (`passkey_needs_verification`). */
export function needsUserVerification(error: unknown): boolean {
  return isBridgeError(error) && error.code === 'passkey_needs_verification';
}

/**
 * A social sign-in's refusal the page can name: who can sign in turned the Microsoft account away
 * (`microsoft_account_not_allowed`, with `personal`, `work` or `directory`), or the provider refused for a known cause
 * (`provider_error`, with its reason). Null for any other error, and for a provider error with no known cause.
 */
export function socialRefusal(error: unknown): { readonly code: 'microsoft_account_not_allowed' | 'provider_error'; readonly reason: string } | null {
  if (!isBridgeError(error) || error.reason === null) return null;
  return error.code === 'microsoft_account_not_allowed' || error.code === 'provider_error' ? { code: error.code, reason: error.reason } : null;
}

/**
 * Where a passkey sign-in on Bridge's own pages is to continue: the app's sign-in page, when Bridge refused it with
 * `passkey_on_app_page` (a passkey belongs to the app's own domain); null for any other error. Send the browser there.
 */
export function passkeyHandOver(error: unknown): string | null {
  return isBridgeError(error) && error.code === 'passkey_on_app_page' ? error.signInUrl : null;
}

/**
 * Whether Bridge refused a sign-in with the right password because the app's password rules changed and it no longer
 * meets them (`password_change_required`). Bridge has already emailed a link to choose a new one; `error.failed` names
 * the rules the password breaks.
 */
export function isPasswordChangeRequired(error: unknown): boolean {
  return isBridgeError(error) && error.code === 'password_change_required';
}

/**
 * Whether Bridge refused a sign-in with the right password because it has expired: the app makes passwords
 * expire, and this one is older than it allows. Bridge has already emailed a link to choose a new one. Also
 * `isPasswordChangeRequired`.
 */
export function isPasswordExpired(error: unknown): boolean {
  return isPasswordChangeRequired(error) && (error as BridgeError).reason === 'expired';
}

/**
 * The refusals of a typed code (an email code, or a second step's code), by name: `wrong` with the tries left, `expired`
 * (too old, or tried too many times: ask for a new one), `too-soon` (a new code was asked for within its wait, with the
 * seconds left), or null for any other error.
 */
export function codeRefusal(error: unknown): { readonly reason: 'wrong'; readonly triesLeft: number | null } | { readonly reason: 'expired' } | { readonly reason: 'too-soon'; readonly retryAfterSeconds: number | null } | null {
  if (!isBridgeError(error)) return null;
  if (error.code === 'wrong_code') return error.triesLeft === 0 ? { reason: 'expired' } : { reason: 'wrong', triesLeft: error.triesLeft };
  if (error.code === 'code_expired') return { reason: 'expired' };
  if (error.code === 'too_soon') return { reason: 'too-soon', retryAfterSeconds: error.retryAfterSeconds };
  return null;
}

/** Why a checkout could not start because of how the app is set up (no return address, or one that is not registered), or null. */
export function checkoutSetupProblem(error: unknown): 'no-return-url' | 'return-url-not-registered' | null {
  if (!isBridgeError(error)) return null;
  return error.code === 'no-return-url' || error.code === 'return-url-not-registered' ? error.code : null;
}

export function isBridgeError(value: unknown, kind?: BridgeErrorKind): value is BridgeError {
  return value instanceof BridgeError && (kind === undefined || value.kind === kind);
}

/** OAuth and sign-in error codes, and the kind each one is. */
const CODE_KINDS: Readonly<Record<string, BridgeErrorKind>> = {
  wrong_credentials: 'wrong-credentials',
  wrong_device: 'wrong-device',
  invalid_link: 'link-invalid',
  flow_expired: 'flow-expired',
  invalid_grant: 'signed-out',
  invalid_token: 'signed-out',
  access_denied: 'forbidden',
  temporarily_unavailable: 'unavailable',
  invalid_client: 'misconfigured',
  unsupported_grant_type: 'misconfigured',
  invalid_request: 'invalid',
  // Sign-in protection: paused (with Retry-After) or locked until the password is reset.
  too_many_attempts: 'rate-limited',
  account_locked: 'rate-limited',
  // Passkeys: one that could not be verified, one Bridge does not know, a ceremony that took too long or was used.
  passkey_refused: 'wrong-credentials',
  unknown_passkey: 'wrong-credentials',
  // A passkey or security key that did no fingerprint, face or PIN check: the person can fix it, so it is told apart.
  passkey_needs_verification: 'invalid',
  // Typed codes: a wrong one, one too old or tried too often, a new one asked for too soon.
  wrong_code: 'invalid',
  code_expired: 'invalid',
  wrong_recovery_code: 'invalid',
  too_soon: 'rate-limited',
  // Social sign-in: who can sign in with Microsoft turned the account away; the provider refused, with a known cause or not.
  microsoft_account_not_allowed: 'forbidden',
  provider_error: 'unavailable',
  invalid_challenge: 'flow-expired',
  origin_not_allowed: 'origin-not-allowed',
  // An invite's link that no longer works: revoked, used, or out of date (also what a link that names no invite gets).
  invite_revoked: 'link-invalid',
  invite_used: 'link-invalid',
  invite_expired: 'link-invalid',
};

/** Problem `type`s whose kind is not the status's. */
const PROBLEM_KINDS: Readonly<Record<string, BridgeErrorKind>> = {
  'identity-recheck': 'reauthenticate',
  'entitlement-missing': 'plan-required',
  'origin-not-allowed': 'origin-not-allowed',
  'rate-limited': 'rate-limited',
  unavailable: 'unavailable',
};

function kindOfStatus(status: number): BridgeErrorKind {
  if (status === 400 || status === 413 || status === 415) return 'invalid';
  if (status === 401) return 'signed-out';
  if (status === 402) return 'plan-required';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 409 || status === 412 || status === 422) return 'conflict';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

/**
 * The whole minutes to wait before trying again, rounded up and never 0, for a refusal that says when
 * (`retryAfterSeconds`); null for any other error. For "Too many attempts. Try again in N minutes.", and
 * "... in 1 minute." (`login.error.tooManyAttemptsOneMinute`) when it is 1.
 */
export function waitMinutes(error: unknown): number | null {
  if (!isBridgeError(error) || error.retryAfterSeconds === null) return null;
  return Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
}

/** `Retry-After` as seconds: a number of seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** An address a browser may be sent to: http or https, with no credentials in it. */
function webAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The error for one refused answer. `body` is the parsed JSON body, or
 * anything else the server sent.
 */
export function errorFromAnswer(status: number, body: unknown, headers?: { get(name: string): string | null }): BridgeError {
  const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  // A browser reads `Retry-After` only when Bridge exposes it to the page: the body's `retry_after` says the same.
  const retryAfterSeconds = parseRetryAfter(headers?.get('retry-after')) ?? (typeof record['retry_after'] === 'number' && record['retry_after'] >= 0 ? Math.ceil(record['retry_after']) : null);
  const challenge = headers?.get('www-authenticate') ?? '';

  // OAuth's shape: sign-in and the token endpoint.
  const oauth = text(record['error']);
  if (oauth !== undefined) {
    if (oauth === 'insufficient_user_authentication') {
      const needs = text(record['needs']);
      // At sign-in: the workspace needs a step this SDK cannot do yet (a second step, company login).
      if (needs !== undefined) return new BridgeError('unsupported-step', `Signing in to this workspace needs a step this SDK does not offer yet: ${needs}.`, { status, code: oauth, step: needs });
      return new BridgeError('reauthenticate', text(record['error_description']) ?? 'Sign in again to confirm it is you.', { status, code: oauth });
    }
    const kind = CODE_KINDS[oauth] ?? kindOfStatus(status);
    const reason = text(record['reason']);
    const message = text(record['error_description']) ?? (reason !== undefined ? `Refused: ${reason}.` : `Bridge refused the request (${oauth}).`);
    const handOverTo = oauth === 'passkey_on_app_page' ? webAddress(record['sign_in_url']) : null;
    const failed = Array.isArray(record['failed']) ? record['failed'].filter((each): each is string => typeof each === 'string') : null;
    // These keep their own code, and carry the reason beside it.
    // A password that must change keeps its code too: its reason (`expired`) only says why.
    const ownCode = oauth === 'microsoft_account_not_allowed' || oauth === 'provider_error' || oauth === 'password_change_required';
    return new BridgeError(kind, message, {
      status,
      code: ownCode ? oauth : (reason ?? oauth),
      ...(ownCode && reason !== undefined ? { reason } : {}),
      retryAfterSeconds,
      ...(handOverTo === null ? {} : { signInUrl: handOverTo }),
      ...((oauth === 'password_change_required' || oauth === 'password_rules') && failed !== null ? { failed } : {}),
      ...(typeof record['tries_left'] === 'number' ? { triesLeft: Math.max(0, Math.floor(record['tries_left'])) } : {}),
    });
  }

  // Problem details: every API route.
  const type = text(record['type']);
  const problem: Problem | null = type !== undefined || text(record['title']) !== undefined ? (record as Problem) : null;
  const code = type?.startsWith('urn:bridge:problem:') ? type.slice('urn:bridge:problem:'.length) : null;
  let kind = (code !== null ? PROBLEM_KINDS[code] : undefined) ?? kindOfStatus(status);
  if (status === 401 && challenge.includes('insufficient_user_authentication')) kind = 'reauthenticate';
  const message =
    text(record['detail']) ??
    text(record['title']) ??
    (typeof record['message'] === 'string' ? record['message'] : Array.isArray(record['message']) ? record['message'].join(' ') : undefined) ??
    `Bridge answered ${String(status)}.`;
  // A lock goes by Bridge's problem type `billing-locked` and by 0.9's code `BILLING_GATE_ENGAGED` (or its `billing_locked` reason).
  if (status === 402 && (isLockName(type) || isLockName(record['code']) || record['reason'] === 'billing_locked')) {
    const billing = record['billing'] !== null && typeof record['billing'] === 'object' ? (record['billing'] as Record<string, unknown>) : {};
    const lockedStatus = text(billing['status']);
    return new BillingLockedError(
      { reason: 'billing_locked', billing: { status: (lockedStatus ?? 'past_due') as BillingStatus, gateEngaged: true, recoveryUrl: text(billing['recoveryUrl']) ?? LOCK_RECOVERY_URL } },
      { problem, retryAfterSeconds },
    );
  }
  const entitlement = text(record['entitlement']) ?? null;
  const limit = record['limit'];
  const used = record['used'];
  const quota: LimitReached | null =
    code === 'limit-reached' && text(record['metric']) !== undefined && typeof limit === 'number' && typeof used === 'number' ? { metric: text(record['metric'])!, limit, used } : null;
  // A checkout that could not start because of how the app is set up says which, in the words of its detail.
  const setup = /^(no-return-url|return-url-not-registered):/.exec(message)?.[1] ?? null;
  return new BridgeError(kind, message, { status, code: setup ?? code, retryAfterSeconds, entitlement, problem, quota });
}
