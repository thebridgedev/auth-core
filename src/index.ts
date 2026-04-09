// Main facade
export { BridgeAuth } from './bridge-auth.js';

// Types
export type {
  AppConfig,
  AuthConfigResponse,
  AuthResult,
  AuthState,
  BridgeAuthConfig,
  BridgeAuthEventName,
  BridgeAuthEvents,
  CheckoutSession,
  FederationConnection,
  FlagRequirement,
  IDToken,
  MagicLinkResult,
  MfaResult,
  NavigationDecision,
  PasskeyAuthOptions,
  PasskeyRegistrationOptions,
  PasskeyVerificationResult,
  Plan,
  PriceOfferSdk,
  Profile,
  ResolvedConfig,
  RouteGuard,
  RouteGuardConfig,
  RouteRule,
  SignupResult,
  SsoOptions,
  SsoResult,
  SubscriptionStatus,
  TenantUser,
  TokenSet,
  TokenStorage,
  Workspace,
} from './types.js';

// Team management
export { TeamService } from './team-service.js';
export type {
  TeamProfile,
  TeamProfileUpdateInput,
  TeamUser,
  TeamUserListResult,
  TeamUserUpdateInput,
  TeamWorkspace,
  TeamWorkspaceUpdateInput,
} from './team-types.js';

// API token management
export { ApiTokenService } from './api-token-service.js';
export type {
  ApiToken,
  AvailablePrivilege,
  CreateApiTokenInput,
  CreateApiTokenResponse,
} from './api-token-service.js';

// Errors
export { BridgeAuthError, HttpError } from './errors.js';

// Storage adapters (for custom configuration)
export { LocalStorageAdapter, MemoryAdapter } from './token-storage.js';

// Utilities
export { decodeJwtPayload, getTokenExpiry, isTokenExpired, shouldRefreshNow } from './token-utils.js';

// Management API (API-key authenticated)
export { BridgeManagement } from './management/index.js';
export { ManagementHttpClient } from './management-http.js';
export type {
  ManagementConfig,
  // App
  AppResponse, UpdateAppRequest, CredentialsState, UpdateCredentialsRequest,
  // Tenant
  TenantResponse, CreateTenantRequest, UpdateTenantRequest,
  // User
  UserResponse, InviteUserRequest, UpdateUserRequest,
  // Role
  RoleResponse, CreateRoleRequest, UpdateRoleRequest, PrivilegeResponse,
  // Feature Flag
  FlagResponse, CreateFlagInput, UpdateFlagInput,
  SegmentResponse, SegmentInput, Target, TargetValue,
  // Branding
  BrandingResponse, UpdateBrandingRequest, CssFileResponse, UpdateCssFileRequest,
  // Plan
  PlanResponse, CreatePlanRequest, UpdatePlanRequest, PlanPrice,
  // Token
  TokenRecord, CreateTokenRequest, CreateTokenResponse,
  // Event
  EventQuery, EventResult,
  // Onboarding
  OnboardingResponse, UpdateOnboardingRequest,
  // Workflows
  SetupSSOParams, SetupSSOResult,
  SetupPaymentsParams, SetupPaymentsResult,
  SetupCommunicationParams, SetupCommunicationResult,
  SSOProvider,
} from './management-types.js';
export { AppManagementService } from './management/app.service.js';
export { TenantManagementService } from './management/tenant.service.js';
export { UserManagementService } from './management/user.service.js';
export { RoleManagementService } from './management/role.service.js';
export { FlagManagementService } from './management/flag.service.js';
export { BrandingManagementService } from './management/branding.service.js';
export { PlanManagementService } from './management/plan.service.js';
export { TokenManagementService } from './management/token.service.js';
export { EventManagementService } from './management/event.service.js';
export { OnboardingManagementService } from './management/onboarding.service.js';
export { ManagementWorkflows } from './management/workflows.js';
