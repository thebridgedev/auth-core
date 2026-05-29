import { describe, expect, it } from 'vitest';
import {
  bucket,
  evaluateBranch,
  evaluateRule,
  resolveAttribute,
  validateRule,
  type EvalContext,
  type Rule,
} from '../../flags/evaluator.js';

const c = (attribute: string, operator: any, ...values: any[]) => ({ attribute, operator, values });
const ctx = (identity: string | undefined, attributes: Record<string, unknown>): EvalContext => ({
  identity,
  attributes,
});

describe('resolveAttribute', () => {
  it('finds flat keys', () => {
    expect(resolveAttribute(ctx('u', { plan: 'pro' }), 'plan')).toBe('pro');
  });

  it('walks dotted paths', () => {
    expect(resolveAttribute(ctx('u', { user: { role: 'admin' } }), 'user.role')).toBe('admin');
  });

  it('prefers flat over nested', () => {
    expect(
      resolveAttribute(ctx('u', { 'user.role': 'flat', user: { role: 'nested' } }), 'user.role'),
    ).toBe('flat');
  });

  it('returns undefined when missing', () => {
    expect(resolveAttribute(ctx('u', {}), 'plan')).toBeUndefined();
  });
});

describe('bucket', () => {
  it('is deterministic', () => {
    expect(bucket('flag', 'u-1')).toBe(bucket('flag', 'u-1'));
  });

  it('range [0, 100)', () => {
    for (let i = 0; i < 50; i++) {
      const b = bucket(`flag-${i}`, 'u-1');
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});

describe('evaluateBranch', () => {
  it('AND of conditions', () => {
    const r = evaluateBranch(
      { conditions: [c('plan', 'eq', 'pro'), c('country', 'in', 'DE', 'FR')], returnValue: true },
      ctx('u', { plan: 'pro', country: 'DE' }),
    );
    expect(r).toBe(true);
  });

  it('false when any condition misses', () => {
    const r = evaluateBranch(
      { conditions: [c('plan', 'eq', 'pro'), c('country', 'in', 'DE')], returnValue: true },
      ctx('u', { plan: 'pro', country: 'GB' }),
    );
    expect(r).toBe(false);
  });
});

describe('evaluateRule', () => {
  const rule: Rule = {
    branches: [
      { conditions: [c('plan', 'eq', 'pro')], returnValue: 'pro-value' },
      { conditions: [c('beta', 'eq', true)], returnValue: 'beta-value' },
    ],
    otherwiseValue: 'control',
    rolloutPct: 100,
  };

  it('first match wins', () => {
    const r = evaluateRule(rule, 'k', ctx('u', { plan: 'pro' }));
    expect(r.matched).toBe(true);
    expect(r.value).toBe('pro-value');
    expect(r.variantIndex).toBe(0);
  });

  it('falls through to next branch', () => {
    const r = evaluateRule(rule, 'k', ctx('u', { plan: 'free', beta: true }));
    expect(r.value).toBe('beta-value');
    expect(r.variantIndex).toBe(1);
  });

  it('otherwise when nothing matches', () => {
    const r = evaluateRule(rule, 'k', ctx('u', { plan: 'free', beta: false }));
    expect(r.value).toBe('control');
    expect(r.variantIndex).toBe(-1);
    expect(r.matched).toBe(false);
  });

  it('rollout excludes when pct < 100 and no identity', () => {
    const r = evaluateRule({ ...rule, rolloutPct: 50 }, 'k', { identity: undefined, attributes: { plan: 'pro' } });
    expect(r.excludedByRollout).toBe(true);
    expect(r.value).toBe('control');
  });

  it('rollout sticky for same identity', () => {
    const sticky = { ...rule, rolloutPct: 50 };
    const first = evaluateRule(sticky, 'k', ctx('u', { plan: 'pro' }));
    const second = evaluateRule(sticky, 'k', ctx('u', { plan: 'pro' }));
    expect(first.matched).toBe(second.matched);
  });

  it('100% rollout does not require identity', () => {
    const r = evaluateRule(rule, 'k', { identity: undefined, attributes: { plan: 'pro' } });
    expect(r.matched).toBe(true);
  });

  it('0% rollout always returns otherwise with identity', () => {
    const r = evaluateRule({ ...rule, rolloutPct: 0 }, 'k', ctx('u', { plan: 'pro' }));
    expect(r.excludedByRollout).toBe(true);
  });
});

describe('validateRule', () => {
  it('accepts a clean rule', () => {
    const rule: Rule = {
      branches: [{ conditions: [c('p', 'eq', 'x')], returnValue: true }],
      otherwiseValue: false,
      rolloutPct: 100,
    };
    expect(validateRule(rule)).toEqual([]);
  });

  it('rejects empty branch', () => {
    const errs = validateRule({
      branches: [{ conditions: [], returnValue: true }],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/no conditions/);
  });

  it('rejects bad operator', () => {
    const errs = validateRule({
      branches: [{ conditions: [c('p', 'bogus', 'x')], returnValue: true }],
      otherwiseValue: false,
      rolloutPct: 100,
    });
    expect(errs.some((e) => /Unknown operator/.test(e.message))).toBe(true);
  });

  it('rejects out-of-range rollout', () => {
    const errs = validateRule({
      branches: [{ conditions: [c('p', 'eq', 'x')], returnValue: true }],
      otherwiseValue: false,
      rolloutPct: 150,
    });
    expect(errs.some((e) => /rolloutPct/.test(e.message))).toBe(true);
  });
});
