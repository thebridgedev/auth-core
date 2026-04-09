/** Bridge auth configuration */
export interface BridgeAuthConfig {
  /** Your Bridge application ID */
  appId: string;

  /** The URL to redirect to after successful login */
  callbackUrl?: string;

  /** Base URL for the Bridge API. All API endpoints are derived from this.
   *  @default 'https://api.thebridge.dev' */
  apiBaseUrl?: string;

  /** Base URL for the Bridge hosted UI (login page, plan selection, etc.).
   *  @default 'https://auth.thebridge.dev' */
  hostedUrl?: string;

  /** Route to redirect to after login. @default '/' */
  defaultRedirectRoute?: string;

  /** Route to redirect to when authentication fails. @default '/login' */
  loginRoute?: string;

  /** Token storage adapter. Defaults to localStorage (browser) or memory (SSR). */
  storage?: TokenStorage;

  /** Enable debug logging. @default false */
  debug?: boolean;
}

/** Resolved config with all defaults applied */
export interface ResolvedConfig extends Required<Omit<BridgeAuthConfig, 'storage'>> {
  /** Derived: apiBaseUrl + '/auth' */
  authBaseUrl: string;
  /** Derived: hostedUrl + '/user-management-portal/users' */
  teamManagementUrl: string;
  storage: TokenStorage;
}

/** Token set returned from auth endpoints */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

/** ID token payload (JWT claims) */
export interface IDToken {
  sub: string;
  preferred_username: string;
  email: string;
  email_verified: boolean;
  name: string;
  family_name?: string;
  given_name?: string;
  locale?: string;
  onboarded?: boolean;
  multi_tenant?: boolean;
  tenant_id?: string;
  tenant_name?: string;
  tenant_locale?: string;
  tenant_logo?: string;
  tenant_onboarded?: boolean;
}

/** User profile derived from ID token */
export interface Profile {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  fullName: string;
  familyName?: string;
  givenName?: string;
  locale?: string;
  onboarded?: boolean;
  multiTenantAccess?: boolean;
  tenant?: {
    id: string;
    name: string;
    locale?: string;
    logo?: string;
    onboarded?: boolean;
  };
}

/** Auth state machine states */
export type AuthState =
  | 'unauthenticated'
  | 'credentials-validated'
  | 'mfa-required'
  | 'mfa-setup-required'
  | 'tenant-selection'
  | 'authenticated';

/** Response from credentialsConfig endpoint */
export interface AuthConfigResponse {
  hasPassword: boolean;
  hasPasskeys: boolean;
  federationConnections: FederationConnection[];
}

export interface FederationConnection {
  id: string;
  type: string;
  name: string;
}

/** Tenant user for tenant selection */
export interface TenantUser {
  id: string;
  username: string;
  fullName: string;
  tenant: {
    id: string;
    name: string;
    logo: string;
  };
}

/** Result from authenticate endpoint */
export interface AuthResult {
  session: string;
  expires: number;
  mfaState: string;
  tenantUsers: TenantUser[];
}

/** Result from MFA endpoints */
export interface MfaResult {
  session: string;
  expires: number;
  mfaState?: string;
  backupCode?: string;
  qrCode?: string;
  phoneNumber?: string;
}

/** SSO popup options */
export interface SsoOptions {
  provider: string;
  width?: number;
  height?: number;
}

/** SSO popup result */
export interface SsoResult {
  type: 'auth_success' | 'auth_mfa_required' | 'auth_tenant_selection' | 'auth_error';
  session?: string;
  expires?: number;
  mfaState?: string;
  tenantUsers?: TenantUser[];
  tokens?: TokenSet;
  error?: string;
}

/** Route guard types */
export type FlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };

export interface RouteRule {
  match: string | RegExp;
  public?: boolean;
  featureFlag?: FlagRequirement;
  redirectTo?: string;
}

export interface RouteGuardConfig {
  rules: RouteRule[];
  defaultAccess?: 'public' | 'protected';
}

export type NavigationDecision =
  | { type: 'allow' }
  | { type: 'login'; loginUrl: string }
  | { type: 'redirect'; to: string };

export interface RouteGuard {
  isPublicRoute(pathname: string): boolean;
  isProtectedRoute(pathname: string): boolean;
  shouldRedirectToLogin(pathname: string): boolean;
  checkRouteRestrictions(pathname: string): Promise<string | null>;
  getLoginRedirect(): string;
  getNavigationDecision(pathname: string): Promise<NavigationDecision>;
}

/** Token storage interface — pluggable */
export interface TokenStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** App-level configuration (SSO providers, feature flags, etc.) */
export interface AppConfig {
  id: string;
  name: string;
  logo?: string;
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  onboardingFlow?: boolean;
  uiUrl?: string;
  emailSenderName?: string;
  emailSenderEmail?: string;
  paymentsEnabled?: boolean;
  mfa?: boolean;
  federationConnections?: FederationConnection[];
  passkeysEnabled?: boolean;
  magicLinkEnabled?: boolean;
  signupEnabled?: boolean;
  googleSsoEnabled?: boolean;
  azureSsoEnabled?: boolean;
}

/** Subscription status for the current tenant */
export interface SubscriptionStatus {
  paymentsEnabled: boolean;
  shouldSelectPlan: boolean;
  shouldSetupPayments: boolean;
  paymentFailed: boolean;
  trial: boolean;
  plan?: string;
}

/** A plan available for selection */
export interface Plan {
  key: string;
  name: string;
  description?: string;
  trial?: boolean;
  trialDays?: number;
  prices: PriceOfferSdk[];
}

/** Price offer for a plan */
export interface PriceOfferSdk {
  id: string;
  amount: number;
  currency: string;
  recurrenceInterval: 'month' | 'year' | 'week' | 'day';
}

/** Checkout session for Stripe */
export interface CheckoutSession {
  sessionId: string;
  publicKey: string;
}

/** Workspace (tenant) for workspace selection in SDK auth */
export interface Workspace {
  id: string;
  name: string;
  logo?: string;
}

/** Events emitted by BridgeAuth */
export interface BridgeAuthEvents {
  'auth:login': TokenSet;
  'auth:logout': void;
  'auth:token-refreshed': TokenSet;
  'auth:token-refresh-failed': Error;
  'auth:state-change': AuthState;
  'auth:profile': Profile | null;
  'auth:error': Error;
  'auth:workspace-changed': TokenSet;
}

export type BridgeAuthEventName = keyof BridgeAuthEvents;

// --- SDK auth additions ---

/** Result from signup endpoint */
export interface SignupResult {
  success: boolean;
  message?: string;
}

/** Result from magic link send */
export interface MagicLinkResult {
  expiresIn: number;
}

/** WebAuthn authentication options (PublicKeyCredentialRequestOptionsJSON) */
export interface PasskeyAuthOptions {
  [key: string]: any;
}

/** WebAuthn registration options (PublicKeyCredentialCreationOptionsJSON) */
export interface PasskeyRegistrationOptions {
  [key: string]: any;
}

/** Result from passkey registration verification */
export interface PasskeyVerificationResult {
  verified: boolean;
}
