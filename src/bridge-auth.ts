import { AuthService } from './auth-service.js';
import { AuthStateManager } from './auth-state.js';
import { resolveConfig } from './config.js';
import { DirectAuthService } from './direct-auth.js';
import { EventEmitter } from './event-emitter.js';
import { FeatureFlagService } from './feature-flag-service.js';
import { createLogger } from './logger.js';
import { PlanService } from './plan-service.js';
import { ProfileService } from './profile-service.js';
import { ApiTokenService } from './api-token-service.js';
import { TeamService } from './team-service.js';
import { createRouteGuard } from './route-guard.js';
import { SsoPopupManager } from './sso-popup.js';
import { TokenManager } from './token-manager.js';
import { httpFetch } from './http.js';
import type {
  AppConfig,
  AuthConfigResponse,
  AuthResult,
  AuthState,
  BridgeAuthConfig,
  BridgeAuthEventName,
  BridgeAuthEvents,
  CheckoutSession,
  MagicLinkResult,
  MfaResult,
  PasskeyAuthOptions,
  PasskeyRegistrationOptions,
  PasskeyVerificationResult,
  Plan,
  PriceOfferSdk,
  Profile,
  ResolvedConfig,
  RouteGuard,
  RouteGuardConfig,
  SignupResult,
  SsoOptions,
  SsoResult,
  SubscriptionStatus,
  TenantUser,
  TokenSet,
} from './types.js';

export class BridgeAuth {
  private readonly config: ResolvedConfig;
  private readonly emitter: EventEmitter;
  private readonly authService: AuthService;
  private readonly directAuth: DirectAuthService;
  private readonly tokenManager: TokenManager;
  private readonly profileService: ProfileService;
  private readonly featureFlags: FeatureFlagService;
  private readonly planService: PlanService;
  private readonly teamService: TeamService;
  private readonly apiTokenService: ApiTokenService;
  private readonly ssoPopup: SsoPopupManager;
  private readonly stateManager: AuthStateManager;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(config: BridgeAuthConfig) {
    this.config = resolveConfig(config);
    this.logger = createLogger(this.config.debug);
    this.emitter = new EventEmitter();

    this.authService = new AuthService(this.config, this.logger);
    this.directAuth = new DirectAuthService(this.config, this.logger);
    this.profileService = new ProfileService(this.config, this.logger);
    this.ssoPopup = new SsoPopupManager(this.config, this.logger);

    this.stateManager = new AuthStateManager(this.logger, (state) => {
      this.emitter.emit('auth:state-change', state);
    });

    this.tokenManager = new TokenManager(
      this.config.storage,
      (rt) => this.authService.refreshToken(rt),
      this.logger,
      (tokens) => {
        if (tokens) {
          this.emitter.emit('auth:token-refreshed', tokens);
        } else {
          this.stateManager.onLogout();
          this.emitter.emit('auth:logout', undefined);
        }
      },
    );

    this.featureFlags = new FeatureFlagService(
      this.config,
      () => this.tokenManager.getTokens(),
      this.logger,
    );

    this.planService = new PlanService(
      this.config,
      () => this.tokenManager.getTokens(),
      this.logger,
    );

    this.teamService = new TeamService(
      this.config,
      () => this.tokenManager.getTokens(),
      this.logger,
    );

    this.apiTokenService = new ApiTokenService(
      this.config,
      () => this.tokenManager.getTokens(),
      this.logger,
    );

    // If tokens already loaded from storage, set state to authenticated
    if (this.tokenManager.isAuthenticated()) {
      this.stateManager.onAuthenticated();
    }

    // Start auto-refresh if we have tokens
    this.tokenManager.startAutoRefresh();
  }

  // --- OAuth flow ---

  createLoginUrl(options?: { redirectUri?: string }): string {
    return this.authService.createLoginUrl(options);
  }

  async login(options?: { redirectUri?: string }): Promise<void> {
    const url = this.createLoginUrl(options);
    window.location.href = url;
  }

  /** Silently clear tokens without emitting events or redirecting. Used to wipe stale tokens before showing a login page. */
  clearSession(): void {
    this.tokenManager.clearTokens();
  }

  async logout(): Promise<void> {
    this.tokenManager.clearTokens();
    this.stateManager.onLogout();
    this.emitter.emit('auth:logout', undefined);
    window.location.href = this.authService.createLogoutUrl();
  }

  async handleCallback(code: string): Promise<TokenSet> {
    const tokens = await this.authService.exchangeCode(code);
    this.tokenManager.setTokens(tokens);
    this.stateManager.onAuthenticated();
    this.emitter.emit('auth:login', tokens);
    return tokens;
  }

  async getCodeFromToken(redirectUri?: string): Promise<string> {
    const tokens = this.tokenManager.getTokens();
    if (!tokens?.accessToken) throw new Error('Not authenticated');
    return this.authService.getCodeFromToken(tokens.accessToken, redirectUri);
  }

  async refreshTokens(): Promise<TokenSet | null> {
    const tokens = this.tokenManager.getTokens();
    if (!tokens?.refreshToken) return null;
    const newTokens = await this.authService.refreshToken(tokens.refreshToken);
    if (newTokens) {
      this.tokenManager.setTokens(newTokens);
    }
    return newTokens;
  }

  // --- Direct auth (SDK mode) ---

  async getAuthConfig(email: string): Promise<AuthConfigResponse> {
    return this.directAuth.getCredentialsConfig(email);
  }

  async authenticate(email: string, password: string): Promise<AuthResult> {
    const result = await this.directAuth.authenticate(email, password);
    this.stateManager.onCredentialsValidated(
      result.session,
      result.expires,
      result.mfaState,
      result.tenantUsers,
    );

    // Auto-select tenant if only one and MFA is not pending
    const mfaReady = result.mfaState === 'COMPLETED' || result.mfaState === 'DISABLED';
    if (mfaReady && result.tenantUsers.length === 1) {
      const tokens = await this.directAuth.selectTenant(result.session, result.tenantUsers[0].id);
      this.tokenManager.setTokens(tokens);
      this.stateManager.onAuthenticated();
      this.emitter.emit('auth:login', tokens);
    }

    return result;
  }

  async verifyMfa(code: string): Promise<MfaResult> {
    const session = this.stateManager.getSession();
    if (!session) throw new Error('No active session. Call authenticate() first.');
    const result = await this.directAuth.commitMfaCode(code, session);
    this.stateManager.onMfaCompleted(result.session, result.expires);

    // Auto-select tenant if only one
    const tenantUsers = this.stateManager.getTenantUsers();
    if (tenantUsers.length === 1) {
      const tokens = await this.directAuth.selectTenant(result.session, tenantUsers[0].id);
      this.tokenManager.setTokens(tokens);
      this.stateManager.onAuthenticated();
      this.emitter.emit('auth:login', tokens);
    }

    return result;
  }

  async setupMfa(phoneNumber: string): Promise<MfaResult> {
    const session = this.stateManager.getSession();
    if (!session) throw new Error('No active session. Call authenticate() first.');
    return this.directAuth.startMfaUserSetup(phoneNumber, session);
  }

  async confirmMfaSetup(code: string): Promise<MfaResult> {
    const session = this.stateManager.getSession();
    if (!session) throw new Error('No active session. Call authenticate() first.');
    const result = await this.directAuth.finishMfaUserSetup(code, session);
    this.stateManager.onMfaCompleted(result.session, result.expires);

    const tenantUsers = this.stateManager.getTenantUsers();
    if (tenantUsers.length === 1) {
      const tokens = await this.directAuth.selectTenant(result.session, tenantUsers[0].id);
      this.tokenManager.setTokens(tokens);
      this.stateManager.onAuthenticated();
      this.emitter.emit('auth:login', tokens);
    }

    return result;
  }

  async resetMfa(backupCode: string): Promise<MfaResult> {
    const session = this.stateManager.getSession();
    if (!session) throw new Error('No active session. Call authenticate() first.');
    return this.directAuth.resetUserMfaSetup(backupCode, session);
  }

  /** Returns the list of workspaces (tenants) the user has access to, as returned during authentication. */
  getWorkspaces(): TenantUser[] {
    return this.stateManager.getTenantUsers();
  }

  async selectTenant(tenantUserId: string): Promise<TokenSet> {
    const session = this.stateManager.getSession();
    if (!session) throw new Error('No active session.');
    const tokens = await this.directAuth.selectTenant(session, tenantUserId);
    this.tokenManager.setTokens(tokens);
    this.stateManager.onAuthenticated();
    this.emitter.emit('auth:login', tokens);
    return tokens;
  }

  // --- Signup ---

  async signup(email: string, firstName: string, lastName: string): Promise<SignupResult> {
    return this.directAuth.signup(email, firstName, lastName);
  }

  // --- Magic link ---

  async sendMagicLink(email: string): Promise<MagicLinkResult> {
    return this.directAuth.sendMagicLink(email);
  }

  // --- Password reset ---

  async sendResetPasswordLink(email: string): Promise<void> {
    return this.directAuth.sendResetPasswordLink(email);
  }

  async updatePassword(token: string, password: string): Promise<void> {
    return this.directAuth.updatePassword(token, password);
  }

  // --- Passkeys: authentication ---

  async getPasskeyAuthOptions(): Promise<PasskeyAuthOptions> {
    return this.directAuth.passkeysAuthenticationOptions();
  }

  async authenticateWithPasskey(response: any): Promise<AuthResult> {
    const result = await this.directAuth.passkeysAuthenticate(response);
    this.stateManager.onCredentialsValidated(
      result.session,
      result.expires,
      result.mfaState,
      result.tenantUsers,
    );

    // Auto-select tenant if only one and MFA is not pending
    const mfaReady = result.mfaState === 'COMPLETED' || result.mfaState === 'DISABLED';
    if (mfaReady && result.tenantUsers.length === 1) {
      const tokens = await this.directAuth.selectTenant(result.session, result.tenantUsers[0].id);
      this.tokenManager.setTokens(tokens);
      this.stateManager.onAuthenticated();
      this.emitter.emit('auth:login', tokens);
    }

    return result;
  }

  // --- Passkeys: setup ---

  async requestPasskeySetupLink(email: string): Promise<{ success: boolean }> {
    return this.directAuth.requestPasskeySetupLink(email);
  }

  async getPasskeyRegistrationOptions(token: string): Promise<PasskeyRegistrationOptions> {
    return this.directAuth.getPasskeyRegistrationOptions(token);
  }

  async verifyPasskeyRegistration(credential: any, token: string): Promise<PasskeyVerificationResult> {
    return this.directAuth.verifyPasskeyRegistration(credential, token);
  }

  // --- SSO ---

  async startSsoLogin(provider: string, opts?: SsoOptions): Promise<SsoResult> {
    return this.ssoPopup.startSsoLogin(provider, opts);
  }

  // --- Profile ---

  async getProfile(): Promise<Profile | null> {
    const tokens = this.tokenManager.getTokens();
    if (!tokens?.idToken) return null;
    const profile = await this.profileService.verifyAndDecode(tokens.idToken);
    this.emitter.emit('auth:profile', profile);
    return profile;
  }

  // --- Feature flags ---

  async isFeatureEnabled(flag: string, opts?: { forceLive?: boolean }): Promise<boolean> {
    return this.featureFlags.isEnabled(flag, opts?.forceLive);
  }

  async loadFeatureFlags(): Promise<Record<string, boolean>> {
    return this.featureFlags.loadAll();
  }

  // --- App config ---

  async getAppConfig(): Promise<AppConfig> {
    const url = `${this.config.apiBaseUrl}/account/auth/app-config`;
    return httpFetch<AppConfig>(url, {
      method: 'GET',
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  // --- Plans & Subscription ---

  async redirectToPlanSelection(): Promise<void> {
    return this.planService.redirectToPlanSelection();
  }

  async setSecurityCookie(): Promise<void> {
    return this.planService.setSecurityCookie();
  }

  async getSubscriptionStatus(): Promise<SubscriptionStatus> {
    const token = this.tokenManager.getTokens()?.accessToken;
    if (!token) throw new Error('Not authenticated');
    const url = `${this.config.apiBaseUrl}/account/subscription/status`;
    return httpFetch<SubscriptionStatus>(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'x-app-id': this.config.appId },
    }, this.logger);
  }

  async getPlans(): Promise<Plan[]> {
    const token = this.tokenManager.getTokens()?.accessToken;
    if (!token) throw new Error('Not authenticated');
    const url = `${this.config.apiBaseUrl}/account/subscription/plans`;
    return httpFetch<Plan[]>(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'x-app-id': this.config.appId },
    }, this.logger);
  }

  async startCheckout(planKey: string, priceOffer: PriceOfferSdk, options: { successUrl: string; cancelUrl: string }): Promise<CheckoutSession> {
    const token = this.tokenManager.getTokens()?.accessToken;
    if (!token) throw new Error('Not authenticated');
    const url = `${this.config.apiBaseUrl}/account/subscription/checkout`;
    return httpFetch<CheckoutSession>(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-app-id': this.config.appId },
      body: { planKey, priceOffer, ...options },
    }, this.logger);
  }

  async changePlan(planKey: string, priceOffer: PriceOfferSdk): Promise<void> {
    const token = this.tokenManager.getTokens()?.accessToken;
    if (!token) throw new Error('Not authenticated');
    const url = `${this.config.apiBaseUrl}/account/subscription/change`;
    await httpFetch<void>(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-app-id': this.config.appId },
      body: { planKey, priceOffer },
    }, this.logger);
  }

  // --- Team management ---

  get team(): TeamService {
    return this.teamService;
  }

  // --- API token management ---

  get apiTokens(): ApiTokenService {
    return this.apiTokenService;
  }

  // --- Route guard ---

  createRouteGuard(config: RouteGuardConfig): RouteGuard {
    return createRouteGuard(
      config,
      this.config,
      () => this.tokenManager.isAuthenticated(),
      (opts) => this.createLoginUrl(opts),
      this.featureFlags,
      this.logger,
    );
  }

  // --- Token access + state ---

  getTokens(): TokenSet | null {
    return this.tokenManager.getTokens();
  }

  isAuthenticated(): boolean {
    return this.tokenManager.isAuthenticated();
  }

  getAuthState(): AuthState {
    return this.stateManager.getState();
  }

  getTenantUsers() {
    return this.stateManager.getTenantUsers();
  }

  // --- Debug ---

  get debugEnabled(): boolean {
    return this.config.debug;
  }

  // --- Events ---

  on<E extends BridgeAuthEventName>(event: E, handler: (data: BridgeAuthEvents[E]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  // --- Lifecycle ---

  destroy(): void {
    this.tokenManager.destroy();
    this.ssoPopup.close();
    this.emitter.removeAllListeners();
  }
}
