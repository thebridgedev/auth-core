/**
 * Changing the sign-in address. The address is how a person signs
 * in, recovers their account and gets their codes, so whoever can change it
 * can take the account over. Bridge therefore asks for a recent sign-in
 * (`reauthenticate`, answered with `recheck`), then a confirmation from the
 * current inbox, then one from the new inbox. The old address keeps working
 * until both are done. Afterwards the old address gets a notice with "This
 * wasn't me", which puts it back, signs every device out and sends a link to
 * set a new password.
 *
 * An address that Google, Microsoft or a company's sign-in manages cannot be
 * changed here: `status().managedBy` names who does, and a change is refused
 * with `managed-by-provider`. Someone who lost their inbox asks the app's
 * admin, who changes it from the dashboard or the CLI.
 *
 * Bridge's answers never say whether the new address has an account: a
 * screen says "If that address can be used, we've sent it a link."
 */
import type { Endpoints } from './core/discovery.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES, type Route } from './core/routes.js';
import type { Session } from './session.js';

/** A change asked for and not finished: which inbox is to confirm next, and until when the links work. */
export interface PendingEmailChange {
  readonly newEmail: string;
  /** `current`: the link in the current inbox is next; `new`: the current inbox confirmed, the new one is next. */
  readonly stage: 'current' | 'new';
  readonly expiresAt: string;
}

/** The signed-in person's login: the address they sign in with, and whether they can change it here. */
export interface MyLogin {
  readonly email: string;
  readonly emailChangeable: boolean;
  /** Who manages the address (`google`, `microsoft`, `apple`, `facebook`, a company's provider…), or null. */
  readonly managedBy: string | null;
  readonly pendingChange: PendingEmailChange | null;
}

/** After asking for a change: a link is on its way to the current inbox. */
export interface EmailChangeStarted {
  readonly next: 'confirm_current';
}

/** After a link was confirmed: the new inbox is next, or the change is done. */
export type EmailChangeConfirmed = { readonly next: 'confirm_new'; readonly done?: undefined } | { readonly done: true; readonly email: string; readonly next?: undefined };

/** After "This wasn't me": the old address is back, every device signed out, a link to set a new password sent. */
export interface EmailChangeReverted {
  readonly next: 'reset_password';
}

export interface EmailChangeDeps {
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly session: Session;
  /** The page the links open on, as `BridgeOptions.linkAddress` says. */
  readonly linkAddress?: string;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function pendingOf(value: unknown): PendingEmailChange | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const newEmail = text(record['newEmail']);
  if (newEmail === null) return null;
  return { newEmail, stage: record['stage'] === 'new' ? 'new' : 'current', expiresAt: text(record['expiresAt']) ?? '' };
}

/** The page's own origin, so a link opens where the change started (Bridge checks it is one of the app's). */
function pageOrigin(): string | undefined {
  const here = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof here === 'string' && /^https?:\/\//.test(here) ? here : undefined;
}

export function createEmailChange(deps: EmailChangeDeps) {
  const signedIn = async <T>(route: Route, body?: Readonly<Record<string, unknown>>): Promise<T> =>
    (await call<T>(deps.fetch, deps.endpoints().url(route), { method: route.method, token: await deps.session.accessToken(), ...(body === undefined ? {} : { body }) })).body;
  const fromLink = async <T>(route: Route, token: string): Promise<T> => (await call<T>(deps.fetch, deps.endpoints().url(route), { method: route.method, body: { token } })).body;

  return {
    /** The signed-in person's login address, whether they can change it, who manages it, and a change waiting. */
    async status(): Promise<MyLogin> {
      const answer = ((await signedIn<Record<string, unknown> | undefined>(ROUTES.myLogin)) ?? {}) as Record<string, unknown>;
      const managedBy = text(answer['managedBy']);
      return {
        email: text(answer['email']) ?? '',
        emailChangeable: answer['emailChangeable'] === true && managedBy === null,
        managedBy,
        pendingChange: pendingOf(answer['pendingChange']),
      };
    },

    /**
     * Asks to change the address to `email`. Needs a recent sign-in: otherwise
     * `reauthenticate` (confirm it is you, then call again). An address a
     * provider manages is `managed-by-provider`; a malformed one `invalid`.
     * Resolves the same whether or not the new address is taken.
     */
    async start(email: string): Promise<EmailChangeStarted> {
      const origin = pageOrigin();
      await signedIn(ROUTES.emailChangeStart, {
        email: email.trim(),
        ...(deps.linkAddress === undefined ? {} : { link_address: deps.linkAddress }),
        ...(origin === undefined ? {} : { link_origin: origin }),
      });
      return { next: 'confirm_current' };
    },

    /** Cancels the change waiting: its links stop working, and the address stays as it is. */
    async cancel(): Promise<void> {
      await signedIn<void>(ROUTES.emailChangeCancel);
    },

    /**
     * Confirms a link from `#bridge=email-change&token=…`, signed in or not.
     * The current inbox's link answers `confirm_new` (a link is on its way to
     * the new address); the new inbox's finishes the change. A link that is
     * used, unknown or out of date is `link-invalid`.
     */
    async confirm(token: string): Promise<EmailChangeConfirmed> {
      const answer = ((await fromLink<Record<string, unknown> | undefined>(ROUTES.emailChangeConfirm, token)) ?? {}) as Record<string, unknown>;
      if (answer['done'] === true) return { done: true, email: text(answer['email']) ?? '' };
      return { next: 'confirm_new' };
    },

    /**
     * "This wasn't me", from `#bridge=email-revert&token=…` in the notice to
     * the old address: the old address is back, every device is signed out,
     * and a link to set a new password is on its way to it.
     */
    async revert(token: string): Promise<EmailChangeReverted> {
      await fromLink(ROUTES.emailChangeRevert, token);
      return { next: 'reset_password' };
    },
  };
}

export type EmailChange = ReturnType<typeof createEmailChange>;
