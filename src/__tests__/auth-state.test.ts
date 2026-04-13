import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthStateManager } from '../auth-state.js';
import type { Logger } from '../logger.js';
import type { TenantUser } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const logger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const TENANT_USER_1: TenantUser = {
  id: 'tu-1',
  username: 'alice',
  fullName: 'Alice Smith',
  tenant: { id: 'tenant-a', name: 'Tenant A', logo: '' },
};

const TENANT_USER_2: TenantUser = {
  id: 'tu-2',
  username: 'alice-b',
  fullName: 'Alice B',
  tenant: { id: 'tenant-b', name: 'Tenant B', logo: '' },
};

const SESSION = 'session-abc';
const EXPIRES = 9_999_999_999;

function makeManager(onStateChange = vi.fn()) {
  return {
    manager: new AuthStateManager(logger, onStateChange),
    onStateChange,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthStateManager', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  it('starts in the "unauthenticated" state', () => {
    const { manager } = makeManager();
    expect(manager.getState()).toBe('unauthenticated');
  });

  it('starts with null session, no tenantUsers, and no mfaState', () => {
    const { manager } = makeManager();
    expect(manager.getSession()).toBeNull();
    expect(manager.getTenantUsers()).toEqual([]);
    expect(manager.getMfaState()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // onCredentialsValidated
  // -------------------------------------------------------------------------

  describe('onCredentialsValidated', () => {
    it('transitions to "mfa-required" when mfaState is "REQUIRED"', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);
      expect(manager.getState()).toBe('mfa-required');
    });

    it('transitions to "mfa-setup-required" when mfaState is "SETUP"', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'SETUP', [TENANT_USER_1]);
      expect(manager.getState()).toBe('mfa-setup-required');
    });

    it('transitions to "tenant-selection" when mfaState is COMPLETED and multiple tenants', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1, TENANT_USER_2]);
      expect(manager.getState()).toBe('tenant-selection');
    });

    it('transitions to "credentials-validated" when mfaState is COMPLETED and single tenant', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      expect(manager.getState()).toBe('credentials-validated');
    });

    it('transitions to "credentials-validated" when mfaState is COMPLETED and no tenants', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', []);
      expect(manager.getState()).toBe('credentials-validated');
    });

    it('stores session and tenantUsers', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      expect(manager.getSession()).toBe(SESSION);
      expect(manager.getTenantUsers()).toEqual([TENANT_USER_1]);
    });

    it('stores the mfaState', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);
      expect(manager.getMfaState()).toBe('REQUIRED');
    });

    it('fires the onStateChange callback', () => {
      const { manager, onStateChange } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      expect(onStateChange).toHaveBeenCalledWith('credentials-validated');
    });
  });

  // -------------------------------------------------------------------------
  // updateSession
  // -------------------------------------------------------------------------

  describe('updateSession', () => {
    it('updates session and expires without changing state', () => {
      const { manager, onStateChange } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'SETUP', [TENANT_USER_1]);
      expect(manager.getState()).toBe('mfa-setup-required');
      onStateChange.mockClear();

      manager.updateSession('new-sess', 12345);

      expect(manager.getSession()).toBe('new-sess');
      expect(manager.getSessionExpires()).toBe(12345);
      expect(manager.getState()).toBe('mfa-setup-required');
      expect(manager.getMfaState()).toBe('SETUP');
      expect(onStateChange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onMfaStateChanged
  // -------------------------------------------------------------------------

  describe('onMfaStateChanged', () => {
    it('transitions to "tenant-selection" when multiple tenants remain and MFA is COMPLETED', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1, TENANT_USER_2]);

      manager.onMfaStateChanged('new-session', EXPIRES, 'COMPLETED');
      expect(manager.getState()).toBe('tenant-selection');
    });

    it('transitions to "credentials-validated" when single tenant and MFA is COMPLETED', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);

      manager.onMfaStateChanged('new-session', EXPIRES, 'COMPLETED');
      expect(manager.getState()).toBe('credentials-validated');
    });

    it('transitions to "credentials-validated" when MFA is DISABLED', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);

      manager.onMfaStateChanged('new-session', EXPIRES, 'DISABLED');
      expect(manager.getState()).toBe('credentials-validated');
    });

    it('transitions to "mfa-setup-required" when new state is SETUP', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);

      manager.onMfaStateChanged('reset-session', EXPIRES, 'SETUP');
      expect(manager.getState()).toBe('mfa-setup-required');
    });

    it('transitions to "mfa-required" when new state is REQUIRED', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'SETUP', [TENANT_USER_1]);

      manager.onMfaStateChanged('challenge-session', EXPIRES, 'REQUIRED');
      expect(manager.getState()).toBe('mfa-required');
    });

    it('updates the session to the new value', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);

      manager.onMfaStateChanged('updated-session', EXPIRES, 'COMPLETED');
      expect(manager.getSession()).toBe('updated-session');
    });

    it('updates mfaState to the new value', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);

      manager.onMfaStateChanged('s', EXPIRES, 'SETUP');
      expect(manager.getMfaState()).toBe('SETUP');
    });

    it('fires the onStateChange callback', () => {
      const { manager, onStateChange } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);
      onStateChange.mockClear();

      manager.onMfaStateChanged('s', EXPIRES, 'COMPLETED');
      expect(onStateChange).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // onAuthenticated
  // -------------------------------------------------------------------------

  describe('onAuthenticated', () => {
    it('transitions to "authenticated"', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);

      manager.onAuthenticated();
      expect(manager.getState()).toBe('authenticated');
    });

    it('clears session, tenantUsers, and mfaState', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      manager.onAuthenticated();

      expect(manager.getSession()).toBeNull();
      expect(manager.getTenantUsers()).toEqual([]);
      expect(manager.getMfaState()).toBeNull();
    });

    it('fires the onStateChange callback with "authenticated"', () => {
      const { manager, onStateChange } = makeManager();
      manager.onAuthenticated();
      expect(onStateChange).toHaveBeenCalledWith('authenticated');
    });
  });

  // -------------------------------------------------------------------------
  // onLogout
  // -------------------------------------------------------------------------

  describe('onLogout', () => {
    it('transitions to "unauthenticated"', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      manager.onAuthenticated();

      manager.onLogout();
      expect(manager.getState()).toBe('unauthenticated');
    });

    it('clears session', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);

      manager.onLogout();
      expect(manager.getSession()).toBeNull();
    });

    it('clears tenantUsers', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1, TENANT_USER_2]);

      manager.onLogout();
      expect(manager.getTenantUsers()).toEqual([]);
    });

    it('clears mfaState', () => {
      const { manager } = makeManager();
      manager.onCredentialsValidated(SESSION, EXPIRES, 'REQUIRED', [TENANT_USER_1]);

      manager.onLogout();
      expect(manager.getMfaState()).toBeNull();
    });

    it('fires the onStateChange callback with "unauthenticated"', () => {
      const { manager, onStateChange } = makeManager();
      manager.onLogout();
      expect(onStateChange).toHaveBeenCalledWith('unauthenticated');
    });
  });

  // -------------------------------------------------------------------------
  // reset (delegates to onLogout)
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('resets state to "unauthenticated"', () => {
      const { manager } = makeManager();
      manager.onAuthenticated();
      manager.reset();
      expect(manager.getState()).toBe('unauthenticated');
    });
  });

  // -------------------------------------------------------------------------
  // onStateChange callback — called on every transition
  // -------------------------------------------------------------------------

  describe('onStateChange callback', () => {
    it('is called once per transition', () => {
      const { manager, onStateChange } = makeManager();

      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      expect(onStateChange).toHaveBeenCalledTimes(1);

      manager.onAuthenticated();
      expect(onStateChange).toHaveBeenCalledTimes(2);

      manager.onLogout();
      expect(onStateChange).toHaveBeenCalledTimes(3);
    });

    it('receives the new state as its argument on each transition', () => {
      const { manager, onStateChange } = makeManager();

      manager.onCredentialsValidated(SESSION, EXPIRES, 'COMPLETED', [TENANT_USER_1]);
      expect(onStateChange).toHaveBeenNthCalledWith(1, 'credentials-validated');

      manager.onAuthenticated();
      expect(onStateChange).toHaveBeenNthCalledWith(2, 'authenticated');

      manager.onLogout();
      expect(onStateChange).toHaveBeenNthCalledWith(3, 'unauthenticated');
    });
  });
});
