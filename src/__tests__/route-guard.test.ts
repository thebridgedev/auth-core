import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouteGuard } from '../route-guard.js';
import type { FeatureFlagService } from '../feature-flag-service.js';
import type { Logger } from '../logger.js';
import type { ResolvedConfig, RouteGuardConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: ResolvedConfig = {
  appId: 'app1',
  apiBaseUrl: 'https://api.example.com',
  hostedUrl: 'https://hosted.example.com',
  authBaseUrl: 'https://api.example.com/auth',
  callbackUrl: 'https://myapp.com/callback',
  defaultRedirectRoute: '/',
  loginRoute: '/login',
  teamManagementUrl: 'https://team.example.com',
  storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  debug: false,
};

const logger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeFeatureFlags(flags: Record<string, boolean> = {}): FeatureFlagService {
  return {
    isEnabled: vi.fn(async (flag: string) => flags[flag] ?? false),
    loadAll: vi.fn(),
    getCached: vi.fn(() => ({ ...flags })),
  } as unknown as FeatureFlagService;
}

function makeGuard(opts: {
  rules?: RouteGuardConfig['rules'];
  defaultAccess?: RouteGuardConfig['defaultAccess'];
  isAuthenticated?: boolean;
  flags?: Record<string, boolean>;
}) {
  const guardConfig: RouteGuardConfig = {
    rules: opts.rules ?? [],
    defaultAccess: opts.defaultAccess,
  };
  const isAuthenticated = vi.fn(() => opts.isAuthenticated ?? false);
  const createLoginUrl = vi.fn((_opts?: { redirectUri?: string }) => 'https://api.example.com/auth/url/login/app1');
  const featureFlags = makeFeatureFlags(opts.flags ?? {});

  const guard = createRouteGuard(
    guardConfig,
    CONFIG,
    isAuthenticated,
    createLoginUrl,
    featureFlags,
    logger,
  );

  return { guard, isAuthenticated, createLoginUrl, featureFlags };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRouteGuard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Pattern matching — isPublicRoute
  // -------------------------------------------------------------------------

  describe('pattern matching', () => {
    it('marks a route as public via exact string match', () => {
      const { guard } = makeGuard({
        rules: [{ match: '/login', public: true }],
      });
      expect(guard.isPublicRoute('/login')).toBe(true);
    });

    it('does NOT match a partial path with an exact string rule', () => {
      const { guard } = makeGuard({
        rules: [{ match: '/login', public: true }],
      });
      expect(guard.isPublicRoute('/login/extra')).toBe(false);
    });

    it('matches routes using a wildcard pattern', () => {
      const { guard } = makeGuard({
        rules: [{ match: '/public/*', public: true }],
      });
      expect(guard.isPublicRoute('/public/page')).toBe(true);
      expect(guard.isPublicRoute('/public/nested/path')).toBe(true);
    });

    it('does NOT match a path that does not satisfy the wildcard', () => {
      const { guard } = makeGuard({
        rules: [{ match: '/public/*', public: true }],
      });
      expect(guard.isPublicRoute('/private/page')).toBe(false);
    });

    it('matches routes using a RegExp pattern', () => {
      const { guard } = makeGuard({
        rules: [{ match: /^\/auth\/.*/, public: true }],
      });
      expect(guard.isPublicRoute('/auth/callback')).toBe(true);
      expect(guard.isPublicRoute('/auth/logout')).toBe(true);
    });

    it('does NOT match a route that does not satisfy the RegExp', () => {
      const { guard } = makeGuard({
        rules: [{ match: /^\/auth\/.*/, public: true }],
      });
      expect(guard.isPublicRoute('/dashboard')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // defaultAccess
  // -------------------------------------------------------------------------

  describe('defaultAccess', () => {
    it('treats unmatched routes as protected when defaultAccess is "protected" (default)', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
      });
      expect(guard.isPublicRoute('/dashboard')).toBe(false);
    });

    it('treats unmatched routes as public when defaultAccess is "public"', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'public',
      });
      expect(guard.isPublicRoute('/anything')).toBe(true);
    });

    it('defaults to protected when defaultAccess is not specified', () => {
      const { guard } = makeGuard({ rules: [] });
      expect(guard.isPublicRoute('/secret')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isProtectedRoute
  // -------------------------------------------------------------------------

  describe('isProtectedRoute', () => {
    it('returns true for a protected route', () => {
      const { guard } = makeGuard({ rules: [{ match: '/login', public: true }] });
      expect(guard.isProtectedRoute('/dashboard')).toBe(true);
    });

    it('returns false for a public route', () => {
      const { guard } = makeGuard({ rules: [{ match: '/login', public: true }] });
      expect(guard.isProtectedRoute('/login')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // shouldRedirectToLogin
  // -------------------------------------------------------------------------

  describe('shouldRedirectToLogin', () => {
    it('returns true when route is protected and user is not authenticated', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      expect(guard.shouldRedirectToLogin('/dashboard')).toBe(true);
    });

    it('returns false when route is public regardless of authentication', () => {
      const { guard } = makeGuard({
        rules: [{ match: '/login', public: true }],
        isAuthenticated: false,
      });
      expect(guard.shouldRedirectToLogin('/login')).toBe(false);
    });

    it('returns false when user is authenticated even on a protected route', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: true,
      });
      expect(guard.shouldRedirectToLogin('/dashboard')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // checkRouteRestrictions
  // -------------------------------------------------------------------------

  describe('checkRouteRestrictions', () => {
    it('returns null when the route has no featureFlag requirement', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/settings', public: false }],
      });
      const result = await guard.checkRouteRestrictions('/settings');
      expect(result).toBeNull();
    });

    it('returns null when the feature flag is enabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/beta', featureFlag: 'beta-feature', redirectTo: '/' }],
        flags: { 'beta-feature': true },
      });
      const result = await guard.checkRouteRestrictions('/beta');
      expect(result).toBeNull();
    });

    it('returns the redirectTo path when the feature flag is disabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/beta', featureFlag: 'beta-feature', redirectTo: '/home' }],
        flags: { 'beta-feature': false },
      });
      const result = await guard.checkRouteRestrictions('/beta');
      expect(result).toBe('/home');
    });

    it('returns "/" as default redirect when redirectTo is not specified and flag is disabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/beta', featureFlag: 'beta-feature' }],
        flags: { 'beta-feature': false },
      });
      const result = await guard.checkRouteRestrictions('/beta');
      expect(result).toBe('/');
    });

    it('returns null when route does not match any rule', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/beta', featureFlag: 'beta-feature' }],
      });
      const result = await guard.checkRouteRestrictions('/other');
      expect(result).toBeNull();
    });

    it('evaluates "any" flag requirement — returns null when any flag is enabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/multi', featureFlag: { any: ['flag-a', 'flag-b'] }, redirectTo: '/blocked' }],
        flags: { 'flag-a': false, 'flag-b': true },
      });
      const result = await guard.checkRouteRestrictions('/multi');
      expect(result).toBeNull();
    });

    it('evaluates "any" flag requirement — redirects when all flags disabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/multi', featureFlag: { any: ['flag-a', 'flag-b'] }, redirectTo: '/blocked' }],
        flags: { 'flag-a': false, 'flag-b': false },
      });
      const result = await guard.checkRouteRestrictions('/multi');
      expect(result).toBe('/blocked');
    });

    it('evaluates "all" flag requirement — returns null when all flags are enabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/advanced', featureFlag: { all: ['flag-x', 'flag-y'] }, redirectTo: '/no' }],
        flags: { 'flag-x': true, 'flag-y': true },
      });
      const result = await guard.checkRouteRestrictions('/advanced');
      expect(result).toBeNull();
    });

    it('evaluates "all" flag requirement — redirects when any flag is disabled', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/advanced', featureFlag: { all: ['flag-x', 'flag-y'] }, redirectTo: '/no' }],
        flags: { 'flag-x': true, 'flag-y': false },
      });
      const result = await guard.checkRouteRestrictions('/advanced');
      expect(result).toBe('/no');
    });
  });

  // -------------------------------------------------------------------------
  // getNavigationDecision
  // -------------------------------------------------------------------------

  describe('getNavigationDecision', () => {
    it('returns type="login" with loginUrl when route is protected and unauthenticated', async () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      const decision = await guard.getNavigationDecision('/dashboard');
      expect(decision.type).toBe('login');
      if (decision.type === 'login') {
        expect(decision.loginUrl).toBeTruthy();
      }
    });

    it('returns type="redirect" when feature flag blocks a route', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/beta', featureFlag: 'beta-flag', redirectTo: '/home' }],
        flags: { 'beta-flag': false },
        isAuthenticated: true,
      });
      const decision = await guard.getNavigationDecision('/beta');
      expect(decision).toEqual({ type: 'redirect', to: '/home' });
    });

    it('returns type="allow" when route is accessible and no flag restrictions block it', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/dashboard', public: false, featureFlag: 'dash-flag' }],
        flags: { 'dash-flag': true },
        isAuthenticated: true,
        defaultAccess: 'protected',
      });
      const decision = await guard.getNavigationDecision('/dashboard');
      expect(decision).toEqual({ type: 'allow' });
    });

    it('returns type="allow" for a public route even when unauthenticated', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/login', public: true }],
        isAuthenticated: false,
      });
      const decision = await guard.getNavigationDecision('/login');
      expect(decision).toEqual({ type: 'allow' });
    });

    it('returns type="login" before checking flag restrictions', async () => {
      // Route is protected, user is unauthenticated, AND flag is disabled —
      // login redirect takes precedence.
      const { guard } = makeGuard({
        rules: [{ match: '/protected', featureFlag: 'some-flag', redirectTo: '/flag-redirect' }],
        flags: { 'some-flag': false },
        isAuthenticated: false,
        defaultAccess: 'protected',
      });
      const decision = await guard.getNavigationDecision('/protected');
      expect(decision.type).toBe('login');
    });
  });

  // -------------------------------------------------------------------------
  // getLoginRedirect
  // -------------------------------------------------------------------------

  describe('getLoginRedirect', () => {
    it('delegates to the createLoginUrl function', () => {
      const { guard, createLoginUrl } = makeGuard({ rules: [] });
      const url = guard.getLoginRedirect();
      expect(createLoginUrl).toHaveBeenCalled();
      expect(typeof url).toBe('string');
    });
  });
});
