import type { FeatureFlagService } from './feature-flag-service.js';
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
    if (!rule?.featureFlag) return null;

    const ok = await evaluateFlagRequirement(rule.featureFlag);
    logger.debug(`Route ${pathname} flag check: ${ok}`);
    if (!ok) return rule.redirectTo ?? '/';
    return null;
  }

  function getLoginRedirect(): string {
    return createLoginUrl();
  }

  async function getNavigationDecision(pathname: string): Promise<NavigationDecision> {
    if (shouldRedirectToLogin(pathname)) {
      return { type: 'login', loginUrl: getLoginRedirect() };
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
  };
}
