// TBP-756 — a flag that is off says why. The reason table: rule shape × context.
import { describe, expect, it, vi } from 'vitest';
import {
  attributeFamily,
  evaluateRule,
  type EvalContext,
  type Rule,
} from '../../flags/evaluator.js';
import { BridgeFlags, type CachedFlag } from '../../flags/flag.js';
import { createRouteGuard } from '../../route-guard.js';
import { FeatureFlagService } from '../../feature-flag-service.js';
import type { Logger } from '../../logger.js';
import type { ResolvedConfig } from '../../types.js';

vi.mock('../../http.js', () => ({ httpFetch: vi.fn() }));
import { httpFetch } from '../../http.js';
const mockHttpFetch = httpFetch as ReturnType<typeof vi.fn>;

const c = (attribute: string, operator: any, ...values: any[]) => ({ attribute, operator, values });
const ctx = (attributes: Record<string, unknown>, identity = 'u1'): EvalContext => ({ identity, attributes });
const rule = (branches: Rule['branches'], extra: Partial<Rule> = {}): Rule => ({
  branches,
  otherwiseValue: false,
  rolloutPct: 100,
  ...extra,
});

const ENT = 'bridge:billing.entitlement.analytics';
const planOnly = rule([{ conditions: [c(ENT, 'eq', true)], returnValue: true }]);
const tenantPlan = rule([{ conditions: [c('tenant.plan', 'in', 'pro', 'team')], returnValue: true }]);
const roleOnly = rule([{ conditions: [c('user.role', 'eq', 'ADMIN')], returnValue: true }]);
const privilegeOnly = rule([{ conditions: [c('privileges', 'contains', 'REPORTS_READ')], returnValue: true }]);
const mixed = rule([
  { conditions: [c(ENT, 'eq', true), c('user.role', 'eq', 'ADMIN')], returnValue: true },
]);
const other = rule([{ conditions: [c('country', 'eq', 'SE')], returnValue: true }]);
const planAndOther = rule([{ conditions: [c(ENT, 'eq', true), c('country', 'eq', 'SE')], returnValue: true }]);

describe('attributeFamily', () => {
  it.each([
    ['tenant.plan', 'plan'],
    ['bridge:billing.plan', 'plan'],
    ['bridge:billing.entitlement.analytics', 'plan'],
    ['bridge:billing.quota.seats.remaining', 'plan'],
    ['user.role', 'permission'],
    ['privileges', 'permission'],
    ['user.email', 'other'],
    ['country', 'other'],
    ['bridge:auth.role', 'other'],
  ])('%s is %s', (attribute, family) => {
    expect(attributeFamily(attribute)).toBe(family);
  });
});

describe('evaluateRule reason (TBP-756)', () => {
  it.each<[string, Rule, Record<string, unknown>, string | undefined, string | undefined]>([
    // [name, rule, attributes, reason, feature]
    ['entitlement missing → plan', planOnly, { [ENT]: false }, 'plan', 'analytics'],
    ['entitlement absent → plan', planOnly, {}, 'plan', 'analytics'],
    ['entitlement present → on, no reason', planOnly, { [ENT]: true }, undefined, undefined],
    ['tenant.plan wrong → plan, no feature', tenantPlan, { 'tenant.plan': 'free' }, 'plan', undefined],
    ['role wrong → permission', roleOnly, { 'user.role': 'MEMBER' }, 'permission', undefined],
    ['privilege missing → permission', privilegeOnly, { privileges: ['X'] }, 'permission', undefined],
    ['privilege present → on', privilegeOnly, { privileges: ['REPORTS_READ'] }, undefined, undefined],
    ['mixed, both fail → permission', mixed, { [ENT]: false, 'user.role': 'MEMBER' }, 'permission', undefined],
    ['mixed, only plan fails → plan', mixed, { [ENT]: false, 'user.role': 'ADMIN' }, 'plan', 'analytics'],
    ['mixed, only role fails → permission', mixed, { [ENT]: true, 'user.role': 'MEMBER' }, 'permission', undefined],
    ['other attribute → rule', other, { country: 'NO' }, 'rule', undefined],
    ['plan + other both fail → rule', planAndOther, { [ENT]: false, country: 'NO' }, 'rule', undefined],
    ['plan + other, only plan fails → plan', planAndOther, { [ENT]: false, country: 'SE' }, 'plan', 'analytics'],
  ])('%s', (_name, r, attributes, reason, feature) => {
    const result = evaluateRule(r, 'f', ctx(attributes));
    expect(result.reason).toBe(reason);
    expect(result.feature).toBe(feature);
    if (reason === undefined) expect(result.value).toBe(true);
  });

  it('several branches: an upgrade alone unlocks one of them → plan', () => {
    const r = rule([
      { conditions: [c('user.role', 'eq', 'OWNER')], returnValue: true },
      { conditions: [c(ENT, 'eq', true)], returnValue: true },
    ]);
    const result = evaluateRule(r, 'f', ctx({ 'user.role': 'MEMBER', [ENT]: false }));
    expect(result).toMatchObject({ value: false, reason: 'plan', feature: 'analytics' });
  });

  it('several branches: role and other fail → permission beats rule', () => {
    const r = rule([
      { conditions: [c('country', 'eq', 'SE')], returnValue: true },
      { conditions: [c('user.role', 'eq', 'OWNER')], returnValue: true },
    ]);
    expect(evaluateRule(r, 'f', ctx({ 'user.role': 'MEMBER', country: 'NO' })).reason).toBe('permission');
  });

  it('a deny branch that fired explains itself by its own conditions', () => {
    const r = rule(
      [{ conditions: [c('tenant.plan', 'eq', 'free')], returnValue: false }],
      { otherwiseValue: true },
    );
    const result = evaluateRule(r, 'f', ctx({ 'tenant.plan': 'free' }));
    expect(result).toMatchObject({ value: false, matched: true, reason: 'plan' });
    const role = rule([{ conditions: [c('user.role', 'eq', 'GUEST')], returnValue: false }], { otherwiseValue: true });
    expect(evaluateRule(role, 'f', ctx({ 'user.role': 'GUEST' })).reason).toBe('permission');
  });

  it('outside the rollout → rollout', () => {
    const r = rule([{ conditions: [c(ENT, 'eq', true)], returnValue: true }], { rolloutPct: 0 });
    const result = evaluateRule(r, 'f', ctx({ [ENT]: true }));
    expect(result).toMatchObject({ value: false, excludedByRollout: true, reason: 'rollout' });
  });

  it('no branch that would turn it on → rule', () => {
    expect(evaluateRule(rule([]), 'f', ctx({})).reason).toBe('rule');
  });

  it('a non-off otherwise value carries no reason (string flags)', () => {
    const r = rule([{ conditions: [c(ENT, 'eq', true)], returnValue: 'dark' }], { otherwiseValue: 'light' });
    const result = evaluateRule(r, 'f', ctx({}));
    expect(result.value).toBe('light');
    expect(result.reason).toBeUndefined();
  });
});

describe('BridgeFlags.flag reason (TBP-756)', () => {
  const flag = (over: Partial<CachedFlag>): CachedFlag => ({
    key: 'analytics',
    state: 'on-with-rule',
    valueType: 'boolean',
    offValue: false,
    onValue: true,
    rule: planOnly,
    ...over,
  });

  it('switched off → off', () => {
    const b = new BridgeFlags();
    b.hydrate([flag({ state: 'off' })]);
    expect(b.flag('analytics', false)).toEqual({ passed: false, value: false, reason: 'off' });
  });

  it('plan rule → plan with the feature', () => {
    const b = new BridgeFlags();
    b.hydrate([flag({})]);
    expect(b.flag('analytics', false, { attributes: { [ENT]: false } })).toEqual({
      passed: false,
      value: false,
      reason: 'plan',
      feature: 'analytics',
    });
  });

  it('role rule → permission', () => {
    const b = new BridgeFlags();
    b.hydrate([flag({ rule: roleOnly })]);
    expect(b.flag('analytics', false, { attributes: { 'user.role': 'MEMBER' } }).reason).toBe('permission');
  });

  it('on → no reason; unknown flag → no reason', () => {
    const b = new BridgeFlags();
    b.hydrate([flag({ state: 'on' })]);
    expect(b.flag('analytics', false)).toEqual({ passed: true, value: true });
    expect(b.flag('nope', false)).toEqual({ passed: false, value: false });
  });
});

describe('route guard reason (TBP-756)', () => {
  const CONFIG = {
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
  } as unknown as ResolvedConfig;
  const logger: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  function guardWith(evaluations: Array<{ flag: string; evaluation: Record<string, unknown> }>, rules: any[]) {
    mockHttpFetch.mockReset();
    mockHttpFetch.mockResolvedValue({ flags: evaluations });
    const flags = new FeatureFlagService(CONFIG, () => ({ accessToken: 't' }) as any, logger);
    return createRouteGuard({ rules }, CONFIG, () => true, () => '/login', flags, logger);
  }

  it('a plan-gated route redirects with reason plan, the flag and the feature', async () => {
    const guard = guardWith(
      [{ flag: 'analytics', evaluation: { enabled: false, reason: 'plan', feature: 'reports' } }],
      [{ match: '/analytics', featureFlag: 'analytics', redirectTo: '/home' }],
    );
    expect(await guard.getNavigationDecision('/analytics')).toEqual({
      type: 'redirect',
      to: '/home',
      reason: 'plan',
      flag: 'analytics',
      feature: 'reports',
    });
    expect(await guard.checkRouteRestrictions('/analytics')).toBe('/home');
  });

  it('a permission-gated route redirects with reason permission', async () => {
    const guard = guardWith(
      [{ flag: 'admin', evaluation: { enabled: false, reason: 'permission' } }],
      [{ match: '/admin', featureFlag: 'admin' }],
    );
    expect(await guard.getNavigationDecision('/admin')).toEqual({
      type: 'redirect',
      to: '/',
      reason: 'permission',
      flag: 'admin',
    });
  });

  it('a server that sends no reason gives the exact old decision', async () => {
    const guard = guardWith(
      [{ flag: 'beta', evaluation: { enabled: false } }],
      [{ match: '/beta', featureFlag: 'beta' }],
    );
    expect(await guard.getNavigationDecision('/beta')).toEqual({ type: 'redirect', to: '/' });
  });

  it('any: the flag an upgrade alone would open wins', async () => {
    const guard = guardWith(
      [
        { flag: 'a', evaluation: { enabled: false, reason: 'permission' } },
        { flag: 'b', evaluation: { enabled: false, reason: 'plan' } },
      ],
      [{ match: '/x', featureFlag: { any: ['a', 'b'] } }],
    );
    expect(await guard.getNavigationDecision('/x')).toMatchObject({ reason: 'plan', flag: 'b' });
  });

  it('all: an upgrade is not enough when another failing flag is a permission', async () => {
    const guard = guardWith(
      [
        { flag: 'a', evaluation: { enabled: false, reason: 'plan' } },
        { flag: 'b', evaluation: { enabled: false, reason: 'permission' } },
        { flag: 'c', evaluation: { enabled: true } },
      ],
      [{ match: '/x', featureFlag: { all: ['a', 'b', 'c'] } }],
    );
    expect(await guard.getNavigationDecision('/x')).toMatchObject({ reason: 'permission', flag: 'b' });
  });

  it('an open route stays open and an on flag carries no reason', async () => {
    const guard = guardWith(
      [{ flag: 'analytics', evaluation: { enabled: true, reason: 'plan' } }],
      [{ match: '/analytics', featureFlag: 'analytics' }],
    );
    expect(await guard.getNavigationDecision('/analytics')).toEqual({ type: 'allow' });
  });

  it('an unknown reason string from the server is ignored', async () => {
    const guard = guardWith(
      [{ flag: 'beta', evaluation: { enabled: false, reason: 'because' } }],
      [{ match: '/beta', featureFlag: 'beta' }],
    );
    expect(await guard.getNavigationDecision('/beta')).toEqual({ type: 'redirect', to: '/' });
  });
});
