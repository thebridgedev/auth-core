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
  readonly cause?: unknown;
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

  constructor(kind: BridgeErrorKind, message: string, init: BridgeErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.entitlement = init.entitlement ?? null;
    this.step = init.step ?? null;
    this.problem = init.problem ?? null;
  }
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

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The error for one refused answer. `body` is the parsed JSON body, or
 * anything else the server sent.
 */
export function errorFromAnswer(status: number, body: unknown, headers?: { get(name: string): string | null }): BridgeError {
  const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const retryAfterSeconds = parseRetryAfter(headers?.get('retry-after'));
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
    return new BridgeError(kind, message, { status, code: reason ?? oauth, retryAfterSeconds });
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
  const entitlement = text(record['entitlement']) ?? null;
  return new BridgeError(kind, message, { status, code, retryAfterSeconds, entitlement, problem });
}
