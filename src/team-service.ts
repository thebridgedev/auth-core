import { graphqlFetch } from './graphql.js';
import type { Logger } from './logger.js';
import {
  CREATE_USERS,
  DELETE_USER,
  GET_ME,
  GET_TENANT,
  LIST_USER_ROLES,
  LIST_USERS,
  SEND_PASSWORD_RESET_LINK,
  UPDATE_ME,
  UPDATE_TENANT,
  UPDATE_USER,
} from './team-queries.js';
import type {
  TeamProfile,
  TeamUser,
  TeamUserListResult,
  TeamUserUpdateInput,
  TeamProfileUpdateInput,
  TeamWorkspace,
  TeamWorkspaceUpdateInput,
} from './team-types.js';
import type { ResolvedConfig, TokenSet } from './types.js';

export class TeamService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly getTokens: () => TokenSet | null,
    private readonly logger: Logger,
  ) {}

  // --- User Management ---

  async listUsers(): Promise<TeamUserListResult> {
    const data = await this.query<{
      listUsers: TeamUser[];
      getTenant: { mfa: boolean };
    }>(LIST_USERS);

    return {
      users: data.listUsers ?? [],
      mfaEnabled: Boolean(data.getTenant?.mfa),
    };
  }

  async listUserRoles(): Promise<string[]> {
    const data = await this.query<{ listUserRoles: string[] }>(LIST_USER_ROLES);
    return data.listUserRoles ?? [];
  }

  async createUsers(emails: string[]): Promise<TeamUser[]> {
    const data = await this.query<{ createUsers: TeamUser[] }>(CREATE_USERS, {
      userNames: emails,
    });
    return data.createUsers ?? [];
  }

  async updateUser(input: TeamUserUpdateInput): Promise<TeamUser> {
    const data = await this.query<{ updateUser: TeamUser }>(UPDATE_USER, {
      user: input,
    });
    return data.updateUser;
  }

  async deleteUser(userId: string): Promise<boolean> {
    const data = await this.query<{ deleteUser: boolean }>(DELETE_USER, {
      userId,
    });
    return data.deleteUser ?? false;
  }

  async sendPasswordResetLink(userId: string): Promise<boolean> {
    const data = await this.query<{ sendPasswordResetLink: boolean }>(
      SEND_PASSWORD_RESET_LINK,
      { userId },
    );
    return data.sendPasswordResetLink ?? false;
  }

  // --- Profile (current user) ---

  async getProfile(): Promise<TeamProfile> {
    const data = await this.query<{ getMe: TeamProfile }>(GET_ME);
    return data.getMe;
  }

  async updateProfile(input: TeamProfileUpdateInput): Promise<TeamProfile> {
    const data = await this.query<{ updateMe: TeamProfile }>(UPDATE_ME, {
      user: input,
    });
    return data.updateMe;
  }

  // --- Workspace (tenant) ---

  async getWorkspace(): Promise<TeamWorkspace> {
    const data = await this.query<{ getTenant: TeamWorkspace }>(GET_TENANT);
    return data.getTenant;
  }

  async updateWorkspace(input: TeamWorkspaceUpdateInput): Promise<void> {
    await this.query(UPDATE_TENANT, { tenant: input });
  }

  // --- Private helper ---

  private query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return graphqlFetch<T>(
      this.config,
      this.getTokens(),
      query,
      variables,
      this.logger,
    );
  }
}
