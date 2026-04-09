import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveConfig } from '../config.js';
import { MemoryAdapter, LocalStorageAdapter } from '../token-storage.js';
import type { BridgeAuthConfig, TokenStorage } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  hostedUrl: 'https://auth.thebridge.dev',
  authBaseUrl: 'https://api.thebridge.dev/auth',
  defaultRedirectRoute: '/',
  loginRoute: '/login',
  teamManagementUrl: 'https://auth.thebridge.dev/user-management-portal/users',
  debug: false,
  callbackUrl: '',
};

function minimalConfig(overrides: Partial<BridgeAuthConfig> = {}): BridgeAuthConfig {
  return { appId: 'test-app-id', ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  describe('defaults', () => {
    it('preserves appId from config', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.appId).toBe('test-app-id');
    });

    it('defaults apiBaseUrl to the Bridge API URL', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.apiBaseUrl).toBe(DEFAULTS.apiBaseUrl);
    });

    it('defaults hostedUrl to the Bridge hosted UI URL', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.hostedUrl).toBe(DEFAULTS.hostedUrl);
    });

    it('defaults authBaseUrl derived from apiBaseUrl', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.authBaseUrl).toBe(DEFAULTS.authBaseUrl);
    });

    it('defaults defaultRedirectRoute to /', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.defaultRedirectRoute).toBe('/');
    });

    it('defaults loginRoute to /login', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.loginRoute).toBe('/login');
    });

    it('defaults teamManagementUrl to the Bridge user-management portal URL', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.teamManagementUrl).toBe(DEFAULTS.teamManagementUrl);
    });

    it('defaults debug to false', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.debug).toBe(false);
    });

    it('defaults callbackUrl to empty string in non-browser (test) environment', () => {
      const resolved = resolveConfig(minimalConfig());
      // In a Node.js / vitest environment there is no window, so callbackUrl should be ''
      expect(resolved.callbackUrl).toBe('');
    });

    it('defaults storage to MemoryAdapter in non-browser (test) environment', () => {
      const resolved = resolveConfig(minimalConfig());
      expect(resolved.storage).toBeInstanceOf(MemoryAdapter);
    });
  });

  describe('provided values override defaults', () => {
    it('uses provided apiBaseUrl and derives authBaseUrl', () => {
      const resolved = resolveConfig(minimalConfig({ apiBaseUrl: 'http://localhost:3200' }));
      expect(resolved.apiBaseUrl).toBe('http://localhost:3200');
      expect(resolved.authBaseUrl).toBe('http://localhost:3200/auth');
    });

    it('uses provided hostedUrl', () => {
      const resolved = resolveConfig(minimalConfig({ hostedUrl: 'http://localhost:3091' }));
      expect(resolved.hostedUrl).toBe('http://localhost:3091');
    });

    it('uses provided defaultRedirectRoute', () => {
      const resolved = resolveConfig(minimalConfig({ defaultRedirectRoute: '/dashboard' }));
      expect(resolved.defaultRedirectRoute).toBe('/dashboard');
    });

    it('uses provided loginRoute', () => {
      const resolved = resolveConfig(minimalConfig({ loginRoute: '/auth/sign-in' }));
      expect(resolved.loginRoute).toBe('/auth/sign-in');
    });

    it('derives teamManagementUrl from hostedUrl', () => {
      const resolved = resolveConfig(minimalConfig({ hostedUrl: 'http://localhost:3091' }));
      expect(resolved.teamManagementUrl).toBe('http://localhost:3091/user-management-portal/users');
    });

    it('uses provided callbackUrl', () => {
      const resolved = resolveConfig(minimalConfig({ callbackUrl: 'https://app.example.com/callback' }));
      expect(resolved.callbackUrl).toBe('https://app.example.com/callback');
    });

    it('uses debug=true when provided', () => {
      const resolved = resolveConfig(minimalConfig({ debug: true }));
      expect(resolved.debug).toBe(true);
    });

    it('uses provided storage adapter', () => {
      const customStorage: TokenStorage = {
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
      };
      const resolved = resolveConfig(minimalConfig({ storage: customStorage }));
      expect(resolved.storage).toBe(customStorage);
    });
  });

  describe('browser environment (window present)', () => {
    let originalWindow: unknown;

    beforeEach(() => {
      originalWindow = (globalThis as any).window;
    });

    it('defaults storage to LocalStorageAdapter when window is available', () => {
      // Simulate a browser environment by setting globalThis.window
      const mockLocalStorage = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      Object.defineProperty(globalThis, 'window', {
        value: { location: { origin: 'https://app.example.com' } },
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        value: mockLocalStorage,
        writable: true,
        configurable: true,
      });

      const resolved = resolveConfig(minimalConfig());
      expect(resolved.storage).toBeInstanceOf(LocalStorageAdapter);

      // Restore
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    });

    it('uses window.location.origin to build default callbackUrl when window is present', () => {
      Object.defineProperty(globalThis, 'window', {
        value: { location: { origin: 'https://app.example.com' } },
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        value: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
        writable: true,
        configurable: true,
      });

      const resolved = resolveConfig(minimalConfig());
      expect(resolved.callbackUrl).toBe('https://app.example.com/auth/oauth-callback');

      // Restore
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    });
  });
});
