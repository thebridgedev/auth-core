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

const LOGIN_URL = 'https://api.example.com/auth/url/login/app1';

function makeGuard(opts: {
  rules?: RouteGuardConfig['rules'];
  defaultAccess?: RouteGuardConfig['defaultAccess'];
  isAuthenticated?: boolean;
  flags?: Record<string, boolean>;
  returnTo?: RouteGuardConfig['returnTo'];
}) {
  const guardConfig: RouteGuardConfig = {
    rules: opts.rules ?? [],
    defaultAccess: opts.defaultAccess,
    ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
  };
  const isAuthenticated = vi.fn(() => opts.isAuthenticated ?? false);
  const createLoginUrl = vi.fn((_opts?: { redirectUri?: string }) => LOGIN_URL);
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

  // -------------------------------------------------------------------------
  // resolveReturnTo — deep-link preservation
  // -------------------------------------------------------------------------

  // Regression: the guard dropped the attempted URL, so an emailed deep link to
  // a protected page "just logged you into the system" (TBP-629).
  describe('resolveReturnTo (TBP-629)', () => {
    const DEEP_LINK = '/incident-exported-file/KEY/IV/incident/123';

    it('returns the attempted path with its query intact', () => {
      const { guard } = makeGuard({ rules: [], defaultAccess: 'protected' });
      expect(guard.resolveReturnTo(`${DEEP_LINK}?tab=files`)).toBe(`${DEEP_LINK}?tab=files`);
    });

    it('returns null when returnTo is disabled, and the path when it is not', () => {
      const disabled = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        returnTo: { enabled: false },
      });
      expect(disabled.guard.resolveReturnTo(DEEP_LINK)).toBeNull();

      // Same input, same guard shape, opt-out removed — proves the null above
      // came from `enabled: false` and not from something else rejecting it.
      const enabled = makeGuard({ rules: [], defaultAccess: 'protected' });
      expect(enabled.guard.resolveReturnTo(DEEP_LINK)).toBe(DEEP_LINK);
    });

    it('excludes the configured loginRoute, including when it carries a query', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        returnTo: { loginRoute: '/auth/login' },
      });
      expect(guard.resolveReturnTo('/auth/login')).toBeNull();
      // Compared on path only — a query must not sneak the login route past.
      expect(guard.resolveReturnTo('/auth/login?next=x')).toBeNull();
      // A sibling auth path is NOT the login route and must survive.
      expect(guard.resolveReturnTo('/auth/logout')).toBe('/auth/logout');
    });

    it('excludes paths matching a string-with-* exclude pattern', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        returnTo: { exclude: ['/auth/*'] },
      });
      expect(guard.resolveReturnTo('/auth/callback')).toBeNull();
      expect(guard.resolveReturnTo('/auth/callback?code=1')).toBeNull();
      expect(guard.resolveReturnTo('/app/callback')).toBe('/app/callback');
    });

    it('excludes paths matching a RegExp exclude pattern', () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        returnTo: { exclude: [/^\/internal\//] },
      });
      expect(guard.resolveReturnTo('/internal/tools')).toBeNull();
      expect(guard.resolveReturnTo('/external/tools')).toBe('/external/tools');
    });

    it('returns null for a public route but keeps a protected one', () => {
      const { guard } = makeGuard({
        rules: [{ match: '/marketing/*', public: true }],
        defaultAccess: 'protected',
      });
      expect(guard.resolveReturnTo('/marketing/pricing')).toBeNull();
      expect(guard.resolveReturnTo('/dashboard')).toBe('/dashboard');
    });

    it('rejects hostile attempted values but keeps same-origin paths', () => {
      const { guard } = makeGuard({ rules: [], defaultAccess: 'protected' });
      for (const hostile of [
        'https://evil.test/x',
        '//evil.test/x',
        '/\\evil.test',
        '/path\\back',
        'javascript:alert(1)',
        'relative/path',
        '',
        '   ',
        null,
        undefined,
      ]) {
        expect(guard.resolveReturnTo(hostile)).toBeNull();
      }
      expect(guard.resolveReturnTo(DEEP_LINK)).toBe(DEEP_LINK);
    });
  });

  // -------------------------------------------------------------------------
  // getNavigationDecision — returnTo on the login decision
  // -------------------------------------------------------------------------

  describe('getNavigationDecision returnTo (TBP-629)', () => {
    const DEEP_LINK = '/incident-exported-file/KEY/IV/incident/123';

    it('carries the full attempted path+query on a protected deep link', async () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      const decision = await guard.getNavigationDecision(DEEP_LINK, `${DEEP_LINK}?tab=files`);
      expect(decision).toEqual({
        type: 'login',
        loginUrl: LOGIN_URL,
        returnTo: `${DEEP_LINK}?tab=files`,
      });
    });

    it('falls back to the pathname when attempted is omitted', async () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      const decision = await guard.getNavigationDecision('/reports/42');
      expect(decision).toEqual({ type: 'login', loginUrl: LOGIN_URL, returnTo: '/reports/42' });
    });

    it('omits returnTo entirely when disabled — the documented opt-out shape', async () => {
      const disabled = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
        returnTo: { enabled: false },
      });
      const decision = await disabled.guard.getNavigationDecision(DEEP_LINK, DEEP_LINK);
      expect(decision).toEqual({ type: 'login', loginUrl: LOGIN_URL });
      // Byte-identical to the pre-TBP-629 shape: no extra key at all.
      expect(Object.keys(decision).sort()).toEqual(['loginUrl', 'type']);

      // The same call WITHOUT the opt-out carries the deep link.
      const enabled = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      const withReturn = await enabled.guard.getNavigationDecision(DEEP_LINK, DEEP_LINK);
      expect(withReturn).toEqual({ type: 'login', loginUrl: LOGIN_URL, returnTo: DEEP_LINK });
    });

    it('omits returnTo when the attempt is the login route itself', async () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
        returnTo: { loginRoute: '/auth/login' },
      });
      const bounced = await guard.getNavigationDecision('/auth/login', '/auth/login?next=x');
      expect(bounced).toEqual({ type: 'login', loginUrl: LOGIN_URL });

      // …while a real protected page still comes back with its return target.
      const real = await guard.getNavigationDecision(DEEP_LINK, DEEP_LINK);
      expect(real).toEqual({ type: 'login', loginUrl: LOGIN_URL, returnTo: DEEP_LINK });
    });

    it('never lets a hostile attempted value reach the decision', async () => {
      const { guard } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      const hijacked = await guard.getNavigationDecision('/dashboard', 'https://evil.test/x');
      expect(hijacked).toEqual({ type: 'login', loginUrl: LOGIN_URL });
      expect(JSON.stringify(hijacked)).not.toContain('evil.test');

      // Same pathname, safe attempt — the mechanism is alive, it just refused.
      const honest = await guard.getNavigationDecision('/dashboard', '/dashboard?tab=1');
      expect(honest).toEqual({
        type: 'login',
        loginUrl: LOGIN_URL,
        returnTo: '/dashboard?tab=1',
      });
    });

    it('leaves allow and redirect decisions unchanged (no returnTo key)', async () => {
      const { guard } = makeGuard({
        rules: [{ match: '/beta', featureFlag: 'beta-flag', redirectTo: '/home' }],
        flags: { 'beta-flag': false },
        isAuthenticated: true,
        defaultAccess: 'protected',
      });
      expect(await guard.getNavigationDecision('/beta', '/beta?x=1')).toEqual({
        type: 'redirect',
        to: '/home',
      });

      const allowing = makeGuard({
        rules: [{ match: '/dashboard', public: false }],
        isAuthenticated: true,
        defaultAccess: 'protected',
      });
      expect(await allowing.guard.getNavigationDecision('/dashboard', '/dashboard?x=1')).toEqual({
        type: 'allow',
      });
    });

    it('keeps the legacy single-argument caller working with a usable loginUrl', async () => {
      const { guard, createLoginUrl } = makeGuard({
        rules: [],
        defaultAccess: 'protected',
        isAuthenticated: false,
      });
      const decision = await guard.getNavigationDecision('/dashboard');
      expect(decision.type).toBe('login');
      if (decision.type !== 'login') throw new Error('expected a login decision');
      expect(decision.loginUrl).toBe(LOGIN_URL);
      expect(createLoginUrl).toHaveBeenCalled();
    });
  });
});
