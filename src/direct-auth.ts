import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type {
  AuthConfigResponse,
  AuthResult,
  MagicLinkResult,
  MfaResult,
  PasskeyAuthOptions,
  PasskeyRegistrationOptions,
  PasskeyVerificationResult,
  ResolvedConfig,
  SignupResult,
  TokenSet,
  Workspace,
} from './types.js';

/**
 * The current page without query or fragment, or undefined outside a browser
 * (a server-side caller has no page to return to, so Bridge falls back to the
 * hosted magic-link route).
 */
function currentPageUrl(): string | undefined {
  const loc = typeof globalThis !== 'undefined'
    ? (globalThis as { location?: { origin?: string; pathname?: string } }).location
    : undefined;
  if (!loc?.origin || typeof loc.pathname !== 'string') return undefined;
  return `${loc.origin}${loc.pathname}`;
}

interface DirectTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  user_profile?: Record<string, unknown>;
}

export class DirectAuthService {
  // Captured from the most recent options call and re-attached on the matching
  // verify call — SDK mode has no cookie to carry the WebAuthn challenge, and
  // @simplewebauthn/browser's start*() calls don't forward unrelated fields
  // from the options object they're given, so this has to be threaded manually.
  private _authChallengeToken: string | undefined;
  private _registrationChallengeToken: string | undefined;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
  ) {}

  async getCredentialsConfig(email: string): Promise<AuthConfigResponse> {
    const url = `${this.config.authBaseUrl}/credentialsConfig`;
    return httpFetch<AuthConfigResponse>(url, {
      method: 'POST',
      body: { username: email, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async authenticate(email: string, password: string): Promise<AuthResult> {
    const url = `${this.config.authBaseUrl}/authenticate`;
    return httpFetch<AuthResult>(url, {
      method: 'POST',
      body: { username: email, password, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async commitMfaCode(mfaCode: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/commitMfaCode`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      body: { mfaCode, session, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async resendMfaCode(session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/resendMfaCode`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      body: { session, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async startMfaUserSetup(phoneNumber: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/startMfaUserSetup`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      body: { phoneNumber, session, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async finishMfaUserSetup(mfaCode: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/finishMfaUserSetup`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      body: { mfaCode, session, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async resetUserMfaSetup(backupCode: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/resetUserMfaSetup`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      body: { backupCode, session, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async selectTenant(session: string, tenantUserId: string): Promise<TokenSet> {
    const url = `${this.config.authBaseUrl}/token/direct`;
    const data = await httpFetch<DirectTokenResponse>(url, {
      method: 'POST',
      body: {
        session,
        tenantUserId,
        appId: this.config.appId,
        scope: 'openid profile email onboarding tenant',
        mode: 'sdk',
      },
    }, this.logger);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  // --- Workspace listing & switching ---

  async listWorkspaces(accessToken: string): Promise<Workspace[]> {
    const url = `${this.config.authBaseUrl}/token/workspace-list`;
    return httpFetch<Workspace[]>(url, {
      method: 'POST',
      body: { accessToken },
    }, this.logger);
  }

  async switchWorkspace(accessToken: string, targetTenantUserId: string): Promise<TokenSet> {
    const url = `${this.config.authBaseUrl}/token/workspace-switch`;
    const data = await httpFetch<DirectTokenResponse>(url, {
      method: 'POST',
      body: { accessToken, targetTenantUserId },
    }, this.logger);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  // --- Signup ---

  async signup(
    email: string,
    firstName: string,
    lastName: string,
    options?: { plan?: string; currency?: string; recurrenceInterval?: string },
  ): Promise<SignupResult> {
    const url = `${this.config.authBaseUrl}/signup`;
    return httpFetch<SignupResult>(url, {
      method: 'POST',
      body: {
        email,
        firstName,
        lastName,
        appId: this.config.appId,
        mode: 'sdk',
        // TBP-36 — plan-specific signup links apply the plan at tenant creation.
        ...(options?.plan ? { plan: options.plan } : {}),
        ...(options?.currency ? { currency: options.currency } : {}),
        ...(options?.recurrenceInterval ? { recurrenceInterval: options.recurrenceInterval } : {}),
      },
    }, this.logger);
  }

  // --- Magic link ---

  /**
   * TBP-682: the emailed link has to come back to the page that redeems it.
   * `successUrl` tells Bridge where that is; without it the email points at the
   * hosted magic-link route, which an SDK app does not serve — so every link
   * 404s. Defaults to the current page (no query, no fragment), which is where
   * the login component reads `bridge_magic_link_token` on mount.
   *
   * The URL must be one of the app's allowed origins or Bridge rejects the
   * request — the token in that email signs the user in, so it cannot be sent
   * to an address the app does not own.
   */
  async sendMagicLink(email: string, options?: { successUrl?: string }): Promise<MagicLinkResult> {
    const url = `${this.config.authBaseUrl}/magic-link`;
    const successUrl = options?.successUrl ?? currentPageUrl();
    return httpFetch<MagicLinkResult>(url, {
      method: 'POST',
      body: {
        username: email,
        mode: 'sdk',
        appId: this.config.appId,
        ...(successUrl ? { successUrl } : {}),
      },
    }, this.logger);
  }

  async authenticateWithMagicLinkToken(token: string): Promise<AuthResult> {
    const url = `${this.config.authBaseUrl}/magic-link/authenticate`;
    return httpFetch<AuthResult>(url, {
      method: 'POST',
      body: { token },
    }, this.logger);
  }

  // --- Password reset ---

  async sendResetPasswordLink(email: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/auth/password`;
    await httpFetch<any>(url, {
      method: 'POST',
      body: { username: email },
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  async updatePassword(token: string, password: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/auth/password`;
    await httpFetch<any>(url, {
      method: 'PUT',
      body: { token, password },
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  // --- Passkeys: authentication ---

  async passkeysAuthenticationOptions(): Promise<PasskeyAuthOptions> {
    const url = `${this.config.authBaseUrl}/passkeys/authentication-options`;
    const options = await httpFetch<PasskeyAuthOptions>(url, {
      method: 'GET',
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
    this._authChallengeToken = typeof options?.sdkChallengeToken === 'string' ? options.sdkChallengeToken : undefined;
    return options;
  }

  async passkeysAuthenticate(response: any): Promise<AuthResult> {
    const url = `${this.config.authBaseUrl}/passkeys/verify-authentication`;
    const sdkChallengeToken = this._authChallengeToken;
    this._authChallengeToken = undefined;
    return httpFetch<AuthResult>(url, {
      method: 'POST',
      body: { ...response, ...(sdkChallengeToken ? { sdkChallengeToken } : {}), mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  // --- Passkeys: registration ---

  async requestPasskeySetupLink(email: string): Promise<{ success: boolean }> {
    const url = `${this.config.authBaseUrl}/passkeys/request-setup-link`;
    return httpFetch<{ success: boolean }>(url, {
      method: 'POST',
      body: { username: email, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async getPasskeyRegistrationOptions(token: string): Promise<PasskeyRegistrationOptions> {
    const url = `${this.config.authBaseUrl}/passkeys/registration-options?passkeySetupToken=${encodeURIComponent(token)}`;
    const options = await httpFetch<PasskeyRegistrationOptions>(url, {
      method: 'GET',
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
    this._registrationChallengeToken = typeof options?.sdkChallengeToken === 'string' ? options.sdkChallengeToken : undefined;
    return options;
  }

  async verifyPasskeyRegistration(credential: any, token: string): Promise<PasskeyVerificationResult> {
    const url = `${this.config.authBaseUrl}/passkeys/verify-registration?passkeySetupToken=${encodeURIComponent(token)}`;
    const sdkChallengeToken = this._registrationChallengeToken;
    this._registrationChallengeToken = undefined;
    return httpFetch<PasskeyVerificationResult>(url, {
      method: 'POST',
      body: { ...credential, ...(sdkChallengeToken ? { sdkChallengeToken } : {}), appId: this.config.appId },
    }, this.logger);
  }
}
