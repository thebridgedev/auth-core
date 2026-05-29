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
  SessionStalePayload,
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
export { BridgeAuthError, HttpError, BillingLockedError } from './errors.js';

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
  FlagSchedule,
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

// ── Feature Flags 2.0 — locked operator set + branch evaluator ──────────────
// Shared between bridge-api (server eval) and SDK consumers (client eval) so
// there is no drift in semantics. See `flags/operators.ts` (per-condition
// primitives) and `flags/evaluator.ts` (branch + rollout layer).
export {
  OPERATORS,
  OPERATOR_VERSION,
  CONDITIONS_PER_RULE_MAX,
  isOperator,
  isOperatorValidForType,
  validOperatorsForType,
  evaluateCondition,
  validateConditions,
  bucket,
  evaluateBranch,
  evaluateRule,
  resolveAttribute,
  validateRule,
  BridgeFlags,
  BridgeIdentity,
  MemoryIdentityStorage,
  attachIdentity,
  generateAnonymousId,
  AttributeProviderRegistry,
  AuthAttributeProvider,
  BillingAttributeProvider,
  DevAttributeProvider,
  BridgePullCache,
  TelemetryBatcher,
  RealtimeClient,
  BRIDGE_CONTEXT_HEADER,
  serializeContext,
  deserializeContext,
  serverInstanceId,
} from './flags/index.js';
export type {
  Operator,
  AttributeType,
  Condition,
  ConditionValue,
  ValidationError,
  Branch,
  Rule,
  FlagState,
  EvalContext,
  EvalResult,
  RuleValidationError,
  CachedFlag,
  FlagEvalResult,
  FlagValueType,
  EvalTelemetry,
  DiscoveryTelemetry,
  BridgeFlagsHooks,
  DeclaredAttributeType,
  AttributeDeclaration,
  BridgeFlagsMode,
  FlagUsageReporterLike,
  AnonymousTrackingMode,
  IdentityStorage,
  AttributeProvider,
  AuthJwtClaims,
  AuthProviderConfig,
  BillingSnapshot,
  BillingProviderConfig,
  BillingProviderStores,
  AttributeGetter,
  AttributeBulkGetter,
  AttributesSetOptions,
  BridgeRuntimeMode,
  PullCacheOptions,
  TelemetryBatcherConfig,
  RealtimeClientConfig,
  RealtimeMessage,
  FlagUpdateMessage,
  FlagRemovedMessage,
  UserStateMessage,
  SubscriptionPlanChangedMessage,
  BillingLifecycleMessage,
  QuotaUpdatedMessage,
  EntitlementsChangedMessage,
  SessionSnapshotMessage,
  ConnectionState,
  WebSocketLike,
} from './flags/index.js';

// ── Billing 2.0 — canonical SDK reactive surface (TBP-248 / US-2) ───────────
// Parallel to FF 2.0's BridgeFlags surface. Do NOT unify with FF 2.0 yet —
// REF-1 (post-feature) folds them. See TBP-248 for context.
export { useBridge } from './billing/use-bridge.js';
export type {
  UseBridgeApi,
  UseBridgeEntitlementsApi,
  BillingEventHandlers,
  BillingGateState,
} from './billing/use-bridge.js';
export { BridgeSubscription } from './billing/bridge-subscription.js';
export { fetchBillingState } from './billing/fetch-billing-state.js';
export { QuotaStore } from './billing/quota-store.js';
export type { QuotaSnapshot } from './billing/quota-store.js';
// Billing 2.0 US-12 — entitlement cache + types.
export { EntitlementsStore } from './billing/entitlements-store.js';
export type { EntitlementSnapshot } from './billing/entitlements-store.js';
export { deriveNoticeState, deriveSeverity } from './billing/types.js';
export type {
  BillingSubscriptionStatus,
  BillingSeverity,
  PastDueReason,
  BillingPlanRef,
  BillingSubscriptionState,
  BillingSubscriptionSnapshot,
  BillingNoticeState,
  BillingLockedPayload,
  MountOptions,
} from './billing/types.js';
