import type { FeatureFlagService } from './feature-flag-service.js';
import { sanitizeReturnTo } from './return-to.js';
import { useBridge } from './billing/use-bridge.js';
import type { Logger } from './logger.js';
import type {
  FlagRequirement,
  NavigationDecision,
  ResolvedConfig,
  RouteGuard,
  RouteGuardConfig,
  RouteRule,
} from './types.js';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRegExp(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) return pattern;
  if (!pattern.includes('*')) {
    return new RegExp(`^${escapeRegex(pattern)}$`);
  }
  const escaped = escapeRegex(pattern).replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function findMatchingRule(pathname: string, rules: RouteRule[]): RouteRule | null {
  for (const rule of rules) {
    if (toRegExp(rule.match).test(pathname)) return rule;
  }
  return null;
}

export function createRouteGuard(
  guardConfig: RouteGuardConfig,
  authConfig: ResolvedConfig,
  isAuthenticated: () => boolean,
  createLoginUrl: (opts?: { redirectUri?: string }) => string,
  featureFlags: FeatureFlagService,
  logger: Logger,
): RouteGuard {
  function isPublicRoute(pathname: string): boolean {
    const rule = findMatchingRule(pathname, guardConfig.rules);
    if (rule) return !!rule.public;
    return (guardConfig.defaultAccess ?? 'protected') === 'public';
  }

  function isProtectedRoute(pathname: string): boolean {
    return !isPublicRoute(pathname);
  }

  function shouldRedirectToLogin(pathname: string): boolean {
    return isProtectedRoute(pathname) && !isAuthenticated();
  }

  async function evaluateFlagRequirement(req: FlagRequirement): Promise<boolean> {
    if (typeof req === 'string') return featureFlags.isEnabled(req);
    if ('any' in req) {
      const results = await Promise.all(req.any.map((f) => featureFlags.isEnabled(f)));
      return results.some(Boolean);
    }
    if ('all' in req) {
      const results = await Promise.all(req.all.map((f) => featureFlags.isEnabled(f)));
      return results.every(Boolean);
    }
    return true;
  }

  async function checkRouteRestrictions(pathname: string): Promise<string | null> {
    const rule = findMatchingRule(pathname, guardConfig.rules);
    if (!rule) return null;

    if (rule.featureFlag) {
      const ok = await evaluateFlagRequirement(rule.featureFlag);
      logger.debug(`Route ${pathname} flag check: ${ok}`);
      if (!ok) return rule.redirectTo ?? '/';
    }

    if (rule.billing === 'hard') {
      const gate = useBridge().gateState();
      if (gate.locked) {
        logger.debug(`Route ${pathname} billing-locked → recovery`);
        return gate.recoveryUrl ?? rule.redirectTo ?? '/billing';
      }
    }

    return null;
  }

  function getLoginRedirect(): string {
    return createLoginUrl();
  }

  /**
   * TBP-629 — decide what the visitor should be sent back to after logging in.
   *
   * Returns null rather than a best guess whenever the answer is not clearly
   * safe and useful. A null here just means the consumer falls back to its
   * `defaultRedirectRoute`, i.e. exactly the old behaviour, so failing closed
   * costs nothing.
   *
   * The login route excludes itself. Without that, a visitor bounced through
   * `/auth/login` comes back carrying `?redirectUri=/auth/login`, which either
   * loops or strands them on a login form they have already completed — a
   * worse outcome than the bug this is fixing.
   */
  function resolveReturnTo(attempted: string | null | undefined): string | null {
    const returnToConfig = guardConfig.returnTo;
    if (returnToConfig?.enabled === false) return null;

    const safe = sanitizeReturnTo(attempted);
    if (!safe) return null;

    // Compare paths only — a query string must not let `/auth/login?x=1` slip
    // past an exclusion written as `/auth/login`.
    const path = safe.split('?')[0];

    const loginRoute = returnToConfig?.loginRoute;
    if (loginRoute && path === loginRoute.split('?')[0]) return null;

    const excluded = returnToConfig?.exclude ?? [];
    if (excluded.some((pattern) => toRegExp(pattern).test(path))) return null;

    // A public route is never what the guard turned somebody away from, and
    // sending them "back" to one after login is noise.
    if (isPublicRoute(path)) return null;

    return safe;
  }

  async function getNavigationDecision(
    pathname: string,
    attempted?: string,
  ): Promise<NavigationDecision> {
    if (shouldRedirectToLogin(pathname)) {
      // Fall back to the bare pathname when the caller did not supply the full
      // attempted URL, so older adapters still preserve something useful.
      const returnTo = resolveReturnTo(attempted ?? pathname);
      return {
        type: 'login',
        loginUrl: getLoginRedirect(),
        ...(returnTo ? { returnTo } : {}),
      };
    }
    const redirectTo = await checkRouteRestrictions(pathname);
    if (redirectTo) {
      return { type: 'redirect', to: redirectTo };
    }
    return { type: 'allow' };
  }

  return {
    isPublicRoute,
    isProtectedRoute,
    shouldRedirectToLogin,
    checkRouteRestrictions,
    getLoginRedirect,
    getNavigationDecision,
    resolveReturnTo,
  };
}
