import type { FeatureFlagService, FlagOffExplanation } from './feature-flag-service.js';
import type { FlagOffReason } from './flags/evaluator.js';
import { sanitizeReturnTo } from './return-to.js';
import { useBridge } from './billing/use-bridge.js';
import type { Logger } from './logger.js';
import type {
  FlagRequirement,
  NavigationDecision,
  ResolvedConfig,
  RouteGuard,
  RouteGuardConfig,
  RouteRestriction,
  RouteRule,
} from './types.js';

// TBP-756 — how close a reason is to "an upgrade alone opens it".
const REASON_RANK: Record<FlagOffReason, number> = { plan: 0, permission: 1, rule: 2, off: 3, rollout: 4 };

type FlagVerdict = { ok: boolean; flag?: string; explanation?: FlagOffExplanation };

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

  function explain(flag: string): FlagOffExplanation | undefined {
    // Older FeatureFlagService stand-ins (tests, adapters) have no getReason.
    const read = (featureFlags as Partial<FeatureFlagService>).getReason;
    return typeof read === 'function' ? read.call(featureFlags, flag) : undefined;
  }

  /**
   * TBP-756 — evaluate a route's flag requirement and, when it fails, say why.
   *   - one flag: that flag's reason;
   *   - `any`: every flag failed; the one closest to "an upgrade alone opens
   *     it" wins, since opening any one of them is enough;
   *   - `all`: only the failing flags count, and the one furthest from it
   *     wins, since each of them has to open.
   * A failing flag whose reason is unknown makes the whole reason unknown.
   */
  async function evaluateFlagRequirement(req: FlagRequirement): Promise<FlagVerdict> {
    if (typeof req === 'string') {
      const ok = await featureFlags.isEnabled(req);
      return ok ? { ok } : { ok, flag: req, explanation: explain(req) };
    }
    const flags = 'any' in req ? req.any : 'all' in req ? req.all : null;
    if (!flags) return { ok: true };
    const results = await Promise.all(flags.map((f) => featureFlags.isEnabled(f)));
    const isAny = 'any' in req;
    const ok = isAny ? results.some(Boolean) : results.every(Boolean);
    if (ok) return { ok };
    const failing = flags.filter((_, i) => !results[i]);
    let pick: { flag: string; explanation: FlagOffExplanation } | undefined;
    for (const flag of failing) {
      const explanation = explain(flag);
      if (!explanation) return { ok, flag: failing[0] };
      const better = !pick
        || (isAny
          ? REASON_RANK[explanation.reason] < REASON_RANK[pick.explanation.reason]
          : REASON_RANK[explanation.reason] > REASON_RANK[pick.explanation.reason]);
      if (better) pick = { flag, explanation };
    }
    return pick ? { ok, flag: pick.flag, explanation: pick.explanation } : { ok, flag: failing[0] };
  }

  async function checkRouteRestriction(pathname: string): Promise<RouteRestriction | null> {
    const rule = findMatchingRule(pathname, guardConfig.rules);
    if (!rule) return null;

    if (rule.featureFlag) {
      const verdict = await evaluateFlagRequirement(rule.featureFlag);
      logger.debug(`Route ${pathname} flag check: ${verdict.ok}`);
      if (!verdict.ok) {
        return {
          to: rule.redirectTo ?? '/',
          // Only with a known reason, so a server that says nothing gives the
          // exact pre-TBP-756 decision.
          ...(verdict.explanation && verdict.flag ? { flag: verdict.flag } : {}),
          ...(verdict.explanation ? { reason: verdict.explanation.reason } : {}),
          ...(verdict.explanation?.feature ? { feature: verdict.explanation.feature } : {}),
        };
      }
    }

    if (rule.billing === 'hard') {
      const gate = useBridge().gateState();
      if (gate.locked) {
        logger.debug(`Route ${pathname} billing-locked → recovery`);
        return { to: gate.recoveryUrl ?? rule.redirectTo ?? '/billing' };
      }
    }

    return null;
  }

  async function checkRouteRestrictions(pathname: string): Promise<string | null> {
    const restriction = await checkRouteRestriction(pathname);
    return restriction ? restriction.to : null;
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
    const restriction = await checkRouteRestriction(pathname);
    if (restriction) {
      return { type: 'redirect', ...restriction };
    }
    return { type: 'allow' };
  }

  return {
    isPublicRoute,
    isProtectedRoute,
    shouldRedirectToLogin,
    checkRouteRestrictions,
    checkRouteRestriction,
    getLoginRedirect,
    getNavigationDecision,
    resolveReturnTo,
  };
}
