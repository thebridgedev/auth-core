import type { BillingLockedPayload } from './billing/types.js';

export class BridgeAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BridgeAuthError';
  }
}

export class HttpError extends BridgeAuthError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
    code?: string,
  ) {
    super(message, code ?? `HTTP_${status}`);
    this.name = 'HttpError';
  }
}

/** Where a Bridge admin adds an origin to an app's allowlist. */
export const ALLOWED_ORIGINS_ADMIN_PATH = 'Authentication → Security → Allowed Origins';

/**
 * Docs entry for an origin missing from the app's allowlist. The same anchor
 * the realtime client links for its `origin_not_allowed` reason, so sign-in
 * and live updates point at one explanation.
 */
export const ORIGIN_NOT_ALLOWED_DOCS_URL =
  'https://thebridge.dev/docs/live-updates/troubleshooting/#origin_not_allowed';

/** The page's origin, or undefined outside a browser (SSR, Node). */
export function currentOrigin(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origin = (globalThis as any).location?.origin;
  return typeof origin === 'string' && origin !== '' && origin !== 'null' ? origin : undefined;
}

/** The one-sentence fix, shared by the sign-in error, the realtime status and the console. */
export function originNotAllowedHint(origin: string | undefined = currentOrigin()): string {
  return `This app's allowed origins in Bridge don't include ${origin ?? "this page's origin"} — add it in Bridge admin under ${ALLOWED_ORIGINS_ADMIN_PATH}.`;
}

/**
 * Thrown when Bridge answers `403 {"message":"Origin not allowed"}`: the page's
 * origin is missing from the app's allowed origins (TBP-669). Bridge checks the
 * allowlist on password sign-in, the token exchange that finishes a magic-link
 * or passkey sign-in, signup and passkey options — so an app served from an
 * unlisted origin cannot sign anyone in, and before this error the only trace
 * was a bare "Origin not allowed".
 *
 * The message names the origin and where to add it. `code` is
 * `ORIGIN_NOT_ALLOWED`; `status` stays 403 so status checks keep working.
 */
export class OriginNotAllowedError extends HttpError {
  constructor(
    public readonly origin: string | undefined,
    body?: unknown,
  ) {
    super(originNotAllowedHint(origin), 403, body, 'ORIGIN_NOT_ALLOWED');
    this.name = 'OriginNotAllowedError';
  }
}

/**
 * True for an {@link OriginNotAllowedError} — checked by code rather than
 * `instanceof`, so it holds across duplicate copies of this package.
 */
export function isOriginNotAllowedError(err: unknown): err is OriginNotAllowedError {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ORIGIN_NOT_ALLOWED';
}

/** Bridge's origin-allowlist refusal: 403 with exactly this message. Other 403s are not it. */
export function isOriginNotAllowedResponse(status: number, body: unknown): boolean {
  if (status !== 403 || typeof body !== 'object' || body === null) return false;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.trim().toLowerCase() === 'origin not allowed';
}

/**
 * Thrown when a Bridge API call returns a billing-locked 402. Carries the
 * canonical payload so callers (and the gate UI) can read status + recoveryUrl.
 * Isomorphic — fires on both client and server SDK calls.
 */
export class BillingLockedError extends BridgeAuthError {
  readonly status = 402;
  constructor(public readonly payload: BillingLockedPayload) {
    super('Billing gate engaged — workspace access is locked', 'BILLING_GATE_ENGAGED');
    this.name = 'BillingLockedError';
  }
}
