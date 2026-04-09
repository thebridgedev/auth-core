import type { BridgeAuthConfig, ResolvedConfig } from './types.js';
import { LocalStorageAdapter, MemoryAdapter } from './token-storage.js';

const DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  hostedUrl: 'https://auth.thebridge.dev',
  defaultRedirectRoute: '/',
  loginRoute: '/login',
  callbackUrl: '',
  debug: false,
} as const;

function detectBrowser(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as any).window !== 'undefined';
}

export function resolveConfig(config: BridgeAuthConfig): ResolvedConfig {
  const isBrowser = detectBrowser();
  const callbackUrl = config.callbackUrl ?? (isBrowser ? `${window.location.origin}/auth/oauth-callback` : '');

  // Two base URLs: apiBaseUrl (API endpoints) and hostedUrl (user-facing hosted UI)
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULTS.apiBaseUrl;
  const hostedUrl = config.hostedUrl ?? DEFAULTS.hostedUrl;

  // Derived
  const authBaseUrl = `${apiBaseUrl}/auth`;
  const teamManagementUrl = `${hostedUrl}/user-management-portal/users`;

  return {
    appId: config.appId,
    callbackUrl,
    apiBaseUrl,
    hostedUrl,
    authBaseUrl,
    teamManagementUrl,
    defaultRedirectRoute: config.defaultRedirectRoute ?? DEFAULTS.defaultRedirectRoute,
    loginRoute: config.loginRoute ?? DEFAULTS.loginRoute,
    debug: config.debug ?? DEFAULTS.debug,
    storage: config.storage ?? (isBrowser ? new LocalStorageAdapter() : new MemoryAdapter()),
  };
}
