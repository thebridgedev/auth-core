import type { Endpoints } from './core/discovery.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES, type Route } from './core/routes.js';
import type { Session } from './session.js';

/**
 * Accounts: the signed-in person, their workspaces, and the workspace's team.
 *
 * What a person may do here is decided by Bridge on every call, never by the
 * SDK. To show or hide a team admin's controls, use a flag (by default
 * `bridge-team-manage`), not the person's role.
 */

export interface Me {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phoneNumber: string | null;
  readonly onboarded: boolean;
  readonly consentsToPrivacyPolicy: boolean;
  readonly suspended: boolean;
  readonly workspaces: readonly MyWorkspace[];
}

export interface MyWorkspace {
  readonly id: string;
  readonly name: string | null;
  readonly logo: string | null;
  /** The person's membership in it. */
  readonly member: string;
  readonly role: string;
  readonly status: string;
}

export interface MeUpdate {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phoneNumber?: string;
  readonly onboarded?: boolean;
  readonly consentsToPrivacyPolicy?: boolean;
}

export interface Workspace {
  readonly id: string;
  readonly name: string | null;
  readonly logo: string | null;
  readonly locale: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly onboarded: boolean;
  readonly state: string;
  readonly joinRole: string | null;
  readonly createdAt: string | null;
  readonly [field: string]: unknown;
}

export interface WorkspaceUpdate {
  readonly name?: string;
  readonly logo?: string;
  readonly locale?: string;
  readonly joinRole?: string;
  readonly onboarded?: boolean;
}

export interface Member {
  readonly id: string;
  readonly user: { readonly id: string; readonly email: string; readonly firstName: string | null; readonly lastName: string | null };
  readonly role: string;
  readonly teams: readonly string[];
  readonly status: string;
  readonly customParams: Readonly<Record<string, unknown>>;
  readonly ownerOffered: boolean;
  readonly lastSignIn: string | null;
  readonly joinedAt: string | null;
}

export interface MemberUpdate {
  readonly role?: string;
  readonly enabled?: boolean;
  readonly teams?: readonly string[];
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phoneNumber?: string;
  readonly customParams?: Readonly<Record<string, unknown>>;
}

/** An open invite, as the workspace's list shows it. Accepted and revoked ones leave the list. */
export interface Invite {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  /** `open` while the link works; `expired` once its 30 days have passed. */
  readonly state: 'open' | 'expired' | (string & {});
  readonly expiresAt: string;
  readonly invitedBy: string | null;
  readonly createdAt: string | null;
}

export interface Role {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
  readonly isDefault?: boolean;
  readonly privileges: readonly string[];
}

export interface Page {
  /** At most this many, 1 to 500. @default 100 */
  readonly limit?: number;
  /** The id of the last one already shown. */
  readonly after?: string;
}

export interface AccountsDeps {
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly session: Session;
}

export function createAccounts(deps: AccountsDeps) {
  async function send<T>(route: Route, options: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const token = await deps.session.accessToken();
    const url = deps.endpoints().url(route, options.params, options.query);
    return (await call<T>(deps.fetch, url, { method: route.method, token, ...(options.body === undefined ? {} : { body: options.body }) })).body;
  }
  const paging = (page: Page = {}) => ({ limit: page.limit === undefined ? undefined : String(page.limit), after: page.after });

  return {
    me: {
      get: () => send<Me>(ROUTES.me),
      update: (fields: MeUpdate) => send<Omit<Me, 'workspaces'>>(ROUTES.meUpdate, { body: fields }),
    },

    workspaces: {
      /** The workspaces the person belongs to, with names and logos for a chooser. */
      list: async (): Promise<readonly MyWorkspace[]> => (await send<Me>(ROUTES.me)).workspaces,
      /** Moves the session to another of the person's workspaces. Every tab follows. */
      switch: (workspaceId: string) => deps.session.refresh({ workspace: workspaceId }),
      /** Makes a workspace the person owns. Switch to it to work in it. */
      create: (fields: { readonly name?: string; readonly logo?: string; readonly locale?: string }) => send<Workspace>(ROUTES.workspaceCreate, { body: fields }),
    },

    team: {
      workspace: {
        get: () => send<Workspace>(ROUTES.workspace),
        update: (fields: WorkspaceUpdate) => send<Workspace>(ROUTES.workspaceUpdate, { body: fields }),
      },
      members: {
        list: (options: Page & { readonly search?: string } = {}) => send<Member[]>(ROUTES.members, { query: { ...paging(options), search: options.search } }),
        get: (memberId: string) => send<Member>(ROUTES.member, { params: { memberId } }),
        update: (memberId: string, fields: MemberUpdate) => send<Member>(ROUTES.memberUpdate, { params: { memberId }, body: fields }),
        remove: (memberId: string) => send<unknown>(ROUTES.memberRemove, { params: { memberId } }),
        /** What removing the member would delete, to show before asking. */
        deletionPreview: (memberId: string) => send<unknown>(ROUTES.memberDeletionPreview, { params: { memberId } }),
      },
      invites: {
        /** The workspace's open invites. */
        list: () => send<Invite[]>(ROUTES.invites),
        /**
         * Invites an email with a role (the workspace's default when left out),
         * or sends the invite again: the old link stops working. Bridge emails
         * the link; it works for 30 days. Refused with `conflict` when the app
         * has no email-links address or the person is a member already, and
         * with `rate-limited` when the workspace has sent too many for now.
         */
        create: (invite: { readonly email: string; readonly role?: string }) => send<Invite>(ROUTES.inviteCreate, { body: invite }),
        revoke: (inviteId: string) => send<{ revoked: boolean }>(ROUTES.inviteRevoke, { params: { inviteId } }),
      },
      roles: {
        /** The app's roles. With `assignable`, only those the person may give. */
        list: (options: { readonly assignable?: boolean } = {}) => send<Role[]>(ROUTES.roles, { query: { assignable: options.assignable ? 'true' : undefined } }),
      },
    },

    sessions: {
      /** The person's signed-in devices. */
      list: () => send<{ id: string; current: boolean; signedInAt: string; lastUsedAt: string; methods: string[] }[]>(ROUTES.sessions),
      /** Signs one of the person's other devices out. */
      end: (sessionId: string) => send<void>(ROUTES.sessionEnd, { params: { sessionId } }),
    },
  };
}
