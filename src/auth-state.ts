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

  /** After MFA commit/finish */
  onMfaCompleted(session: string, expires: number): void {
    this.session = session;
    this.sessionExpires = expires;
    this.mfaState = 'COMPLETED';

    if (this.tenantUsers.length > 1) {
      this.transition('tenant-selection');
    } else {
      this.transition('credentials-validated');
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
