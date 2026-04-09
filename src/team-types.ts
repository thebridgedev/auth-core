export interface TeamUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  username: string;
  role: string | null;
  enabled: boolean;
  onboarded: boolean;
  teams: string[];
  createdAt: string;
}

export interface TeamProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string;
  username: string;
  role: string | null;
  onboarded: boolean;
}

export interface TeamWorkspace {
  id: string;
  name: string;
  locale: string;
  logo: string | null;
  mfa: boolean;
  onboarded: boolean;
  plan: string | null;
}

export interface TeamUserUpdateInput {
  id: string;
  role?: string;
  enabled?: boolean;
}

export interface TeamProfileUpdateInput {
  firstName?: string;
  lastName?: string;
}

export interface TeamWorkspaceUpdateInput {
  name?: string;
  locale?: string;
}

export interface TeamUserListResult {
  users: TeamUser[];
  mfaEnabled: boolean;
}
