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

interface DirectTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  user_profile?: Record<string, unknown>;
}

export class DirectAuthService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
  ) {}

  async getCredentialsConfig(email: string): Promise<AuthConfigResponse> {
    const url = `${this.config.authBaseUrl}/auth/credentialsConfig`;
    return httpFetch<AuthConfigResponse>(url, {
      method: 'POST',
      body: { username: email, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async authenticate(email: string, password: string): Promise<AuthResult> {
    const url = `${this.config.authBaseUrl}/auth/authenticate`;
    return httpFetch<AuthResult>(url, {
      method: 'POST',
      body: { username: email, password, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async commitMfaCode(mfaCode: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/auth/commitMfaCode`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      headers: { Cookie: `LOGIN_SESSION=${session}` },
      body: { mfaCode, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async startMfaUserSetup(phoneNumber: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/auth/startMfaUserSetup`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      headers: { Cookie: `LOGIN_SESSION=${session}` },
      body: { phoneNumber, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async finishMfaUserSetup(mfaCode: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/auth/finishMfaUserSetup`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      headers: { Cookie: `LOGIN_SESSION=${session}` },
      body: { mfaCode, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  async resetUserMfaSetup(backupCode: string, session: string): Promise<MfaResult> {
    const url = `${this.config.authBaseUrl}/auth/resetUserMfaSetup`;
    return httpFetch<MfaResult>(url, {
      method: 'POST',
      headers: { Cookie: `LOGIN_SESSION=${session}` },
      body: { backupCode, mode: 'sdk', appId: this.config.appId },
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

  async signup(email: string, firstName: string, lastName: string): Promise<SignupResult> {
    const url = `${this.config.authBaseUrl}/auth/signup`;
    return httpFetch<SignupResult>(url, {
      method: 'POST',
      body: { email, firstName, lastName, appId: this.config.appId },
    }, this.logger);
  }

  // --- Magic link ---

  async sendMagicLink(email: string): Promise<MagicLinkResult> {
    const url = `${this.config.authBaseUrl}/auth/magic-link`;
    return httpFetch<MagicLinkResult>(url, {
      method: 'POST',
      body: { username: email, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  // --- Password reset ---

  async sendResetPasswordLink(email: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/auth/auth/password`;
    await httpFetch<any>(url, {
      method: 'POST',
      body: { username: email },
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  async updatePassword(token: string, password: string): Promise<void> {
    const url = `${this.config.apiBaseUrl}/auth/auth/password`;
    await httpFetch<any>(url, {
      method: 'PUT',
      body: { token, password },
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  // --- Passkeys: authentication ---

  async passkeysAuthenticationOptions(): Promise<PasskeyAuthOptions> {
    const url = `${this.config.authBaseUrl}/auth/passkeys/authentication-options`;
    return httpFetch<PasskeyAuthOptions>(url, {
      method: 'GET',
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  async passkeysAuthenticate(response: any): Promise<AuthResult> {
    const url = `${this.config.authBaseUrl}/auth/passkeys/verify-authentication`;
    return httpFetch<AuthResult>(url, {
      method: 'POST',
      body: { ...response, mode: 'sdk', appId: this.config.appId },
    }, this.logger);
  }

  // --- Passkeys: registration ---

  async requestPasskeySetupLink(email: string): Promise<{ success: boolean }> {
    const url = `${this.config.authBaseUrl}/auth/passkeys/request-setup-link`;
    return httpFetch<{ success: boolean }>(url, {
      method: 'POST',
      body: { username: email, appId: this.config.appId },
    }, this.logger);
  }

  async getPasskeyRegistrationOptions(token: string): Promise<PasskeyRegistrationOptions> {
    const url = `${this.config.authBaseUrl}/auth/passkeys/registration-options?passkeySetupToken=${encodeURIComponent(token)}`;
    return httpFetch<PasskeyRegistrationOptions>(url, {
      method: 'GET',
      headers: { 'x-app-id': this.config.appId },
    }, this.logger);
  }

  async verifyPasskeyRegistration(credential: any, token: string): Promise<PasskeyVerificationResult> {
    const url = `${this.config.authBaseUrl}/auth/passkeys/verify-registration?passkeySetupToken=${encodeURIComponent(token)}`;
    return httpFetch<PasskeyVerificationResult>(url, {
      method: 'POST',
      body: { ...credential, appId: this.config.appId },
    }, this.logger);
  }
}
