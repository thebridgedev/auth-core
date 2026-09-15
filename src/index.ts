// Duplicate-instance detection (TBP-598).
//
// Runs at import time. This package keeps state at module scope (the billing
// singleton, the realtime client, the flag cache), so a second copy silently
// splits it — most sharply the billing lock, which is registered on one copy
// and emitted on the other and therefore never fires. Warns; never throws.
import { registerInstance } from './instance-guard.js';
registerInstance();

export {
  loadedInstanceCount,
  __resetInstanceRegistryForTests,
} from './instance-guard.js';

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
  CurrentUser,
  FederationConnection,
  FlagRequirement,
  IDToken,
  MagicLinkResult,
  MfaResult,
  NavigationDecision,
  PasskeyAuthOptions,
  PasskeyRegistrationOptions,
  PasskeyVerificationResult,
  PaymentClaims,
  Plan,
  PriceOfferSdk,
  Profile,
  ResolvedConfig,
  ReturnToConfig,
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
export {
  BridgeAuthError,
  HttpError,
  BillingLockedError,
  OriginNotAllowedError,
  isOriginNotAllowedError,
  originNotAllowedHint,
  ALLOWED_ORIGINS_ADMIN_PATH,
  ORIGIN_NOT_ALLOWED_DOCS_URL,
} from './errors.js';

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
  CreatePrivilegeRequest, UpdatePrivilegeRequest,
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
  REALTIME_DOCS_BASE_URL,
  REALTIME_ANONYMOUS_TOKEN,
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
  RealtimeStatus,
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
  FlagChange,
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

// TBP-629 — deep-link preservation for SDK-mode route guards. Exported so a
// consumer's login page can read the return target back with the validation
// already applied, rather than each app reinventing the open-redirect check.
export {
  DEFAULT_RETURN_TO_PARAM,
  RETURN_TO_STORAGE_KEY,
  readReturnTo,
  sanitizeReturnTo,
  stashReturnTo,
  takeReturnTo,
  withReturnTo,
} from './return-to.js';

// TBP-630 — SDK auth message catalogue. Lives in core so bridge-svelte,
// -react, -angular and -nextjs resolve identical copy rather than drifting
// into four slightly different logins.
export {
  createTranslator,
  hasLocale,
  interpolate,
  normalizeLocale,
  resetMissingLocaleWarnings,
} from './i18n/resolver.js';
export type { MessageOverrides, Translator } from './i18n/resolver.js';
export { LOCALES, da, de, en, es, fi, fr, it, nb, nl, pl, pt, sv } from './i18n/messages.js';
export type { MessageKey, Messages } from './i18n/messages.js';

