// ─── Configuration ───────────────────────────────────────────────────────────

export interface ManagementConfig {
  apiKey: string;
  baseUrl?: string;
  debug?: boolean;
}

// ─── Common ─────────────────────────────────────────────────────────────────

export type TenantPaymentStatus = 'ACTIVE' | 'PAUSED' | 'CANCELED' | 'UNKNOWN';

export type OnboardingFlow = 'B2B' | 'B2C';

export interface PriceOffer {
  currency: string;
  recurrenceInterval: 'day' | 'month' | 'week' | 'year';
}

export interface CustomParam {
  value: string;
}

// ─── App ────────────────────────────────────────────────────────────────────

export interface AppResponse {
  id: string;
  name: string;
  domain: string;
  apiUrl: string;
  uiUrl: string;
  logo: string;
  websiteUrl: string;
  webhookUrl: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  emailSenderName?: string;
  emailSenderEmail?: string;
  paymentsAutoRedirect: boolean;
  stripeEnabled: boolean;
  stripeSetupStatus?: 'pending' | 'completed' | 'failed' | null;
  stripeSetupError?: string | null;
  allowedTokenPrivileges?: string[] | null;
  passkeysEnabled: boolean;
  mfaEnabled: boolean;
  magicLinkEnabled: boolean;
  googleSsoEnabled: boolean;
  linkedinSsoEnabled: boolean;
  azureAdSsoEnabled: boolean;
  azureMarketplaceEnabled: boolean;
  appleSsoEnabled: boolean;
  githubSsoEnabled: boolean;
  facebookSsoEnabled: boolean;
  onboardingFlow: OnboardingFlow;
  tenantSelfSignup: boolean;
  redirectUris: string[];
  allowedOrigins: string[];
  defaultCallbackUri: string;
  accessTokenTTL: number;
  refreshTokenTTL: number;
}

export interface UpdateAppRequest {
  name?: string;
  apiUrl?: string;
  uiUrl?: string;
  webhookUrl?: string;
  logo?: string;
  tenantSelfSignup?: boolean;
  redirectUris?: string[];
  allowedOrigins?: string[];
  defaultCallbackUri?: string;
  onboardingFlow?: OnboardingFlow;
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  emailSenderName?: string;
  emailSenderEmail?: string;
  paymentsAutoRedirect?: boolean;
  passkeysEnabled?: boolean;
  stripeEnabled?: boolean;
  currency?: string;
  mfaEnabled?: boolean;
  magicLinkEnabled?: boolean;
  googleSsoEnabled?: boolean;
  linkedinSsoEnabled?: boolean;
  azureAdSsoEnabled?: boolean;
  appleSsoEnabled?: boolean;
  githubSsoEnabled?: boolean;
  facebookSsoEnabled?: boolean;
  azureMarketplaceEnabled?: boolean;
  accessTokenTTL?: number;
  refreshTokenTTL?: number;
  allowedTokenPrivileges?: string[] | null;
}

// ─── Tenant ─────────────────────────────────────────────────────────────────

export interface TenantResponse {
  id: string;
  plan?: string;
  mfa: boolean;
  paymentStatus: TenantPaymentStatus;
  trial: boolean;
  locale: string;
  name?: string;
  logo?: string;
  metadata: Record<string, string>;
  onboarded: boolean;
  federationConnection?: string;
  signupBy?: {
    email?: string;
    firstName?: string;
    lastName?: string;
  };
  createdAt: string;
}

export interface CreateTenantRequest {
  owner: {
    email: string;
    firstName?: string;
    lastName?: string;
    muteNotifications?: boolean;
  };
  plan?: string;
  priceOffer?: PriceOffer;
  name?: string;
  onboarded?: boolean;
  logo?: string;
  locale?: string;
  metadata?: Record<string, string>;
  authOriginUrl?: string;
}

export interface UpdateTenantRequest {
  name?: string;
  onboarded?: boolean;
  locale?: string;
  logo?: string;
  mfa?: boolean;
  federationConnection?: string;
  metadata?: Record<string, string>;
}

// ─── User ───────────────────────────────────────────────────────────────────

export interface UserResponse {
  id: string;
  role: string;
  email: string;
  username: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  onboarded: boolean;
  consentsToPrivacyPolicy: boolean;
  enabled: boolean;
  teams: string[];
  createdAt: string;
  lastSeen?: string;
  customParams: CustomParam[];
  tenant: TenantResponse;
}

export interface InviteUserRequest {
  username: string;
  role?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  muteNotifications?: boolean;
  customParams?: CustomParam[];
}

export interface UpdateUserRequest {
  role?: string;
  enabled?: boolean;
  teams?: string[];
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  onboarded?: boolean;
  consentsToPrivacyPolicy?: boolean;
  customParams?: CustomParam[];
}

// ─── Access Role ────────────────────────────────────────────────────────────

export interface PrivilegeResponse {
  id: string;
  key: string;
  description?: string;
}

export interface RoleResponse {
  id: string;
  name: string;
  key: string;
  description?: string;
  privileges: PrivilegeResponse[];
  isDefault: boolean;
}

export interface CreateRoleRequest {
  name: string;
  key: string;
  description?: string;
  privileges: string[];
  isDefault: boolean;
}

export interface UpdateRoleRequest {
  name?: string;
  key?: string;
  description?: string;
  privileges?: string[];
  isDefault?: boolean;
}

// ─── Feature Flag ───────────────────────────────────────────────────────────

// Canonical FF 2.0 shapes live in ./flags/evaluator.ts (Rule, Branch, FlagState,
// EvalContext) and ./flags/flag.ts (FlagValueType). Re-export them here so a
// management consumer can `import { FlagResponse, Rule, FlagState } from
// '@nebulr-group/bridge-auth-core'` from a single named module — no need to
// reach into the SDK eval module to type a management payload.
export type { Rule, Branch, FlagState } from './flags/evaluator.js';
export type { FlagValueType } from './flags/flag.js';

import type { Rule, FlagState } from './flags/evaluator.js';
import type { FlagValueType } from './flags/flag.js';

export interface TargetValue {
  operator: 'eq' | 'beginsWith' | 'endsWith' | 'contains' | 'lessThan' | 'greaterThan';
  value: string;
}

export interface UserTarget {
  id?: string;
  key?: TargetValue;
  role?: TargetValue;
  name?: TargetValue;
  email?: string;
}

export interface TenantTarget {
  id?: string;
  key?: TargetValue;
  plan?: TargetValue;
  name?: TargetValue;
}

export interface KeyTarget {
  key?: TargetValue;
}

export interface Target {
  user?: UserTarget;
  tenant?: TenantTarget;
  device?: KeyTarget;
  custom?: Record<string, TargetValue>;
}

export interface SegmentResponse {
  id: string;
  key: string;
  description: string;
  targets: Target[];
}

export interface SegmentInput {
  id?: string;
  key?: string;
  description?: string;
  targets?: Target[];
}

/**
 * A scheduled future state transition (TBP-189).
 *
 * `null` clears any existing schedule on a write. The runner that flips the
 * state at the appointed time is implemented separately; the management types
 * just describe the persisted shape.
 */
export interface FlagSchedule {
  /** ISO-8601 timestamp at which the transition fires. */
  at: string;
  /** Target state the runner will set when the timer fires. */
  state: FlagState;
}

export interface FlagResponse {
  id: string;
  key: string;
  description: string;

  // ── 1.0 legacy fields (kept for back-compat with existing callers) ────────
  defaultValue: boolean;
  segments: SegmentResponse[];
  targetValue?: boolean;
  enabled: boolean;

  // ── FF 2.0 fields ─────────────────────────────────────────────────────────
  state?: FlagState;
  valueType?: FlagValueType;
  offValue?: unknown;
  onValue?: unknown;
  rule?: Rule | null;
  schedule?: FlagSchedule | null;

  // ── Observability summary (server-computed; optional on the wire) ─────────
  evalCount?: number;
  /** ISO-8601 timestamp of the most recent eval, or null when never evaluated. */
  lastEvalAt?: string | null;
}

export interface CreateFlagInput {
  key: string;
  description?: string;

  // ── 1.0 legacy write-side fields (kept for back-compat) ───────────────────
  defaultValue?: boolean;
  segments?: string[];
  targetValue?: boolean;
  enabled?: boolean;

  // ── FF 2.0 write-side fields ──────────────────────────────────────────────
  state?: FlagState;
  valueType?: FlagValueType;
  offValue?: unknown;
  onValue?: unknown;
  rule?: Rule | null;
  schedule?: FlagSchedule | null;
}

export interface UpdateFlagInput {
  key?: string;
  description?: string;

  // ── 1.0 legacy write-side fields (kept for back-compat) ───────────────────
  defaultValue?: boolean;
  segments?: string[];
  targetValue?: boolean;
  enabled?: boolean;

  // ── FF 2.0 write-side fields ──────────────────────────────────────────────
  state?: FlagState;
  valueType?: FlagValueType;
  offValue?: unknown;
  onValue?: unknown;
  rule?: Rule | null;
  schedule?: FlagSchedule | null;
}

// ─── Branding ───────────────────────────────────────────────────────────────

export interface BrandingResponse {
  bgColor: string;
  fontFamily: string;
  primaryButtonBgColor: string;
  primaryButtonTextColor: string;
  tertiaryButtonBgColor: string;
  tertiaryButtonTextColor: string;
  textColor: string;
  linkColor: string;
  borderRadius: string;
  boxShadow: string;
  customCss: boolean;
  defaultValues: BrandingProps;
}

export interface BrandingProps {
  bgColor: string;
  fontFamily: string;
  primaryButtonBgColor: string;
  primaryButtonTextColor: string;
  tertiaryButtonBgColor: string;
  tertiaryButtonTextColor: string;
  textColor: string;
  linkColor: string;
  borderRadius: string;
  boxShadow: string;
}

export interface UpdateBrandingRequest {
  bgColor: string;
  fontFamily: string;
  primaryButtonBgColor: string;
  primaryButtonTextColor: string;
  tertiaryButtonBgColor: string;
  tertiaryButtonTextColor: string;
  textColor: string;
  linkColor: string;
  borderRadius: string;
  boxShadow: string;
  customCss?: boolean;
}

export interface CssFileResponse {
  cssFile: string;
}

export interface UpdateCssFileRequest {
  cssFile?: string;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export interface PlanResponse {
  key: string;
  name: string;
  description?: string;
  trial: boolean;
  trialDays?: number;
  prices: PlanPrice[];
  /** TBP-275 — per-metric usage quotas (hard caps + metered pricing). */
  quotas?: PlanQuotaEntry[];
}

export interface PlanPrice {
  currency: string;
  recurrenceInterval: 'day' | 'month' | 'week' | 'year';
  amount: number;
}

/** TBP-275 — per-unit price for a metered quota. */
export interface PlanQuotaPricing {
  amount: number;
  currency: string;
}

/** TBP-275 — one per-metric usage quota on a plan. */
export interface PlanQuotaEntry {
  metric: string;
  limit: number;
  policy: 'hard' | 'metered';
  /** Required for `metered`, forbidden for `hard`. */
  pricing?: PlanQuotaPricing;
}

export interface CreatePlanRequest {
  key: string;
  name: string;
  description?: string;
  trial?: boolean;
  trialDays?: number;
  prices?: PlanPrice[];
  quotas?: PlanQuotaEntry[];
}

export interface UpdatePlanRequest {
  name?: string;
  description?: string;
  trial?: boolean;
  trialDays?: number;
  prices?: PlanPrice[];
  quotas?: PlanQuotaEntry[];
}

// ─── API Token ──────────────────────────────────────────────────────────────

export interface TokenRecord {
  id: string;
  name: string;
  privileges: string[];
  tenantId?: string | null;
  expireAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string | null;
}

export interface CreateTokenRequest {
  name: string;
  privileges: string[];
  expireAt?: string;
}

export interface CreateTokenResponse {
  token: string;
  record: TokenRecord;
}

// ─── Event Log ──────────────────────────────────────────────────────────────

export interface EventQuery {
  type?: string;
  tenantId?: string;
  userId?: string;
  since?: string;
  limit?: number;
}

export interface EventResult {
  id: string;
  type: string;
  tenantId?: string;
  userId?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

export interface OnboardingSteps {
  test?: boolean;
  done?: boolean;
}

export interface OnboardingStepProgression {
  activeStepId?: string;
  completedStepIds?: string[];
}

export interface OnboardingResponse {
  createApp?: OnboardingSteps;
  userReadiness?: OnboardingSteps;
  featureFlags?: OnboardingSteps;
  stepProgression?: OnboardingStepProgression;
}

export interface UpdateOnboardingRequest {
  createApp?: OnboardingSteps;
  userReadiness?: OnboardingSteps;
  featureFlags?: OnboardingSteps;
  stepProgression?: OnboardingStepProgression;
}

// ─── Credentials ────────────────────────────────────────────────────────────

export interface CredentialsState {
  hasStripeCredentials: boolean;
  hasSendgridCredentials: boolean;
}

export interface UpdateCredentialsRequest {
  stripeSecretKey?: string;
  stripePublicKey?: string;
  sendgridApiKey?: string;
  [key: string]: string | undefined;
}

// ─── Workflow Params ────────────────────────────────────────────────────────

export type SSOProvider = 'google' | 'azure' | 'github' | 'linkedin' | 'facebook' | 'saml' | 'oidc';

export interface SetupSSOParams {
  provider: SSOProvider;
  config: {
    clientId?: string;
    clientSecret?: string;
    metadataUrl?: string;
    discoveryUrl?: string;
  };
}

export interface SetupSSOResult {
  provider: SSOProvider;
  enabled: boolean;
  callbackUrl: string;
  app: AppResponse;
}

export interface SetupPaymentsParams {
  stripeSecretKey: string;
  stripePublicKey?: string;
  plans?: Array<{
    key: string;
    name: string;
    price: number;
    currency?: string;
    interval?: 'month' | 'year';
  }>;
}

export interface SetupPaymentsResult {
  stripeConnected: boolean;
  plans: PlanResponse[];
  app: AppResponse;
}

export interface SetupCommunicationParams {
  provider: string;
  config: {
    apiKey: string;
    fromAddress?: string;
    fromName?: string;
  };
}

export interface SetupCommunicationResult {
  provider: string;
  configured: boolean;
  app: AppResponse;
}
