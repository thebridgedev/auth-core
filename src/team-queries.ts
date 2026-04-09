export const LIST_USERS = `
  query ListUsers {
    listUsers {
      id
      firstName
      lastName
      fullName
      email
      username
      createdAt
      onboarded
      enabled
      role
      teams
    }
    getTenant {
      mfa
    }
  }
`;

export const LIST_USER_ROLES = `
  query ListUserRoles {
    listUserRoles
  }
`;

export const CREATE_USERS = `
  mutation CreateUsers($userNames: [String!]!) {
    createUsers(userNames: $userNames) {
      id
      firstName
      lastName
      fullName
      email
      username
      createdAt
      onboarded
      enabled
      role
      teams
    }
  }
`;

export const UPDATE_USER = `
  mutation UpdateUser($user: UserInput!) {
    updateUser(user: $user) {
      id
      firstName
      lastName
      fullName
      email
      username
      createdAt
      onboarded
      enabled
      role
      teams
    }
  }
`;

export const DELETE_USER = `
  mutation DeleteUser($userId: String!) {
    deleteUser(userId: $userId)
  }
`;

export const SEND_PASSWORD_RESET_LINK = `
  mutation SendPasswordResetLink($userId: String!) {
    sendPasswordResetLink(userId: $userId)
  }
`;

export const GET_ME = `
  query GetMe {
    getMe {
      id
      firstName
      lastName
      fullName
      email
      username
      createdAt
      onboarded
      enabled
      role
      teams
    }
  }
`;

export const UPDATE_ME = `
  mutation UpdateMe($user: MeInput!) {
    updateMe(user: $user) {
      id
      firstName
      lastName
      fullName
      email
      username
      createdAt
      onboarded
      enabled
      role
      teams
    }
  }
`;

export const GET_TENANT = `
  query GetTenant {
    getTenant {
      createdAt
      id
      logo
      locale
      mfa
      name
      onboarded
      plan
      paymentStatus {
        shouldSelectPlan
        shouldSetupPayments
        paymentsEnabled
        provider
      }
    }
  }
`;

export const UPDATE_TENANT = `
  mutation UpdateTenant($tenant: TenantInput!) {
    updateTenant(tenant: $tenant) {
      createdAt
      id
      logo
      locale
      mfa
      name
      plan
      paymentStatus {
        shouldSelectPlan
        shouldSetupPayments
        paymentsEnabled
        provider
      }
    }
  }
`;
