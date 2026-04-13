import type { Logger } from './logger.js';
import type { AuthState, TenantUser } from './types.js';

export class AuthStateManager {
  private state: AuthState = 'unauthenticated';
  private session: string | null = null;
  private sessionExpires: number | null = null;
  private tenantUsers: TenantUser[] = [];
  private mfaState: string | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly onStateChange: (state: AuthState) => void,
  ) {}

  getState(): AuthState {
    return this.state;
  }

  getSession(): string | null {
    return this.session;
  }

  getSessionExpires(): number | null {
    return this.sessionExpires;
  }

  getTenantUsers(): TenantUser[] {
    return this.tenantUsers;
  }

  getMfaState(): string | null {
    return this.mfaState;
  }

  /** After authenticate() — credentials validated, check MFA + tenants */
  onCredentialsValidated(session: string, expires: number, mfaState: string, tenantUsers: TenantUser[]): void {
    this.session = session;
    this.sessionExpires = expires;
    this.mfaState = mfaState;
    this.tenantUsers = tenantUsers;

    if (mfaState === 'REQUIRED' || mfaState === 'SETUP') {
      this.transition(mfaState === 'SETUP' ? 'mfa-setup-required' : 'mfa-required');
    } else if (tenantUsers.length > 1) {
      this.transition('tenant-selection');
    } else {
      // Single tenant or MFA completed — ready for token exchange
      this.transition('credentials-validated');
    }
  }

  /**
   * Refresh the stored session without changing UI state.
   * Used by confirmMfaSetup where the backend advances the session to COMPLETED,
   * but we need the UI to stay on MfaSetup so the user can acknowledge the
   * backup code before the tenant-select + authentication transition fires.
   */
  updateSession(session: string, expires: number): void {
    this.session = session;
    this.sessionExpires = expires;
  }

  /** After any MFA step — backend returns the new state, we trust it */
  onMfaStateChanged(session: string, expires: number, mfaState: string): void {
    this.session = session;
    this.sessionExpires = expires;
    this.mfaState = mfaState;

    if (mfaState === 'COMPLETED' || mfaState === 'DISABLED') {
      this.transition(this.tenantUsers.length > 1 ? 'tenant-selection' : 'credentials-validated');
    } else if (mfaState === 'SETUP') {
      this.transition('mfa-setup-required');
    } else if (mfaState === 'REQUIRED') {
      this.transition('mfa-required');
    }
  }

  /** After token exchange */
  onAuthenticated(): void {
    this.session = null;
    this.sessionExpires = null;
    this.tenantUsers = [];
    this.mfaState = null;
    this.transition('authenticated');
  }

  /** On logout or token clear */
  onLogout(): void {
    this.session = null;
    this.sessionExpires = null;
    this.tenantUsers = [];
    this.mfaState = null;
    this.transition('unauthenticated');
  }

  reset(): void {
    this.onLogout();
  }

  private transition(newState: AuthState): void {
    const prev = this.state;
    this.state = newState;
    this.logger.debug(`State: ${prev} → ${newState}`);
    this.onStateChange(newState);
  }
}
