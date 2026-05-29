import { describe, expect, it } from 'vitest';
import {
  CONDITIONS_PER_RULE_MAX,
  OPERATORS,
  OPERATOR_VERSION,
  evaluateCondition,
  isOperator,
  isOperatorValidForType,
  validOperatorsForType,
  validateConditions,
  type Condition,
} from '../../flags/operators.js';

describe('flags/operators — locked set', () => {
  it('exports exactly 12 operators in the locked v1 set', () => {
    expect(OPERATORS).toEqual([
      'eq',
      'neq',
      'contains',
      'not_contains',
      'in',
      'not_in',
      'gt',
      'lt',
      'between',
      'regex',
      'exists',
      'not_exists',
    ]);
    expect(OPERATOR_VERSION).toBe(1);
  });

  it('exports CONDITIONS_PER_RULE_MAX', () => {
    expect(CONDITIONS_PER_RULE_MAX).toBe(50);
  });

  it('isOperator narrows correctly', () => {
    expect(isOperator('eq')).toBe(true);
    expect(isOperator('in')).toBe(true);
    expect(isOperator('not_exists')).toBe(true);
    expect(isOperator('unknown_op')).toBe(false);
    expect(isOperator(42)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });
});

describe('flags/operators — type compatibility', () => {
  it('string supports text + set + existence ops', () => {
    const valid = validOperatorsForType('string');
    expect(valid).toContain('eq');
    expect(valid).toContain('contains');
    expect(valid).toContain('not_contains');
    expect(valid).toContain('regex');
    expect(valid).toContain('in');
    expect(valid).toContain('not_in');
    expect(valid).toContain('exists');
    expect(valid).not.toContain('gt');
    expect(valid).not.toContain('between');
  });

  it('number supports comparison + set ops', () => {
    const valid = validOperatorsForType('number');
    expect(valid).toContain('eq');
    expect(valid).toContain('gt');
    expect(valid).toContain('lt');
    expect(valid).toContain('between');
    expect(valid).toContain('in');
    expect(valid).not.toContain('contains');
    expect(valid).not.toContain('regex');
  });

  it('boolean supports only eq/neq + existence', () => {
    const valid = validOperatorsForType('boolean');
    expect(valid).toEqual(['eq', 'neq', 'exists', 'not_exists']);
  });

  it('date supports comparison + existence', () => {
    const valid = validOperatorsForType('date');
    expect(valid).toContain('gt');
    expect(valid).toContain('lt');
    expect(valid).toContain('between');
    expect(valid).not.toContain('contains');
  });

  it('isOperatorValidForType rejects mismatches', () => {
    expect(isOperatorValidForType('gt', 'string')).toBe(false);
    expect(isOperatorValidForType('contains', 'number')).toBe(false);
    expect(isOperatorValidForType('between', 'boolean')).toBe(false);
    expect(isOperatorValidForType('regex', 'date')).toBe(false);
  });

  it('isOperatorValidForType accepts matches', () => {
    expect(isOperatorValidForType('eq', 'string')).toBe(true);
    expect(isOperatorValidForType('gt', 'number')).toBe(true);
    expect(isOperatorValidForType('exists', 'boolean')).toBe(true);
    expect(isOperatorValidForType('between', 'date')).toBe(true);
  });
});

// Helper to build conditions concisely
const c = (operator: Condition['operator'], ...values: Condition['values']): Condition => ({
  attribute: 'attr',
  operator,
  values: values as Condition['values'],
});

describe('evaluateCondition — eq / neq', () => {
  it('eq: matches identical primitives', () => {
    expect(evaluateCondition(c('eq', 'pro'), 'pro')).toBe(true);
    expect(evaluateCondition(c('eq', 42), 42)).toBe(true);
    expect(evaluateCondition(c('eq', true), true)).toBe(true);
  });

  it('eq: rejects non-matches', () => {
    expect(evaluateCondition(c('eq', 'pro'), 'free')).toBe(false);
    expect(evaluateCondition(c('eq', 42), '42')).toBe(false); // strict equality
  });

  it('eq: false on missing value', () => {
    expect(evaluateCondition(c('eq', 'pro'), undefined)).toBe(false);
    expect(evaluateCondition(c('eq', 'pro'), null)).toBe(false);
  });

  it('neq: inverts eq', () => {
    expect(evaluateCondition(c('neq', 'pro'), 'free')).toBe(true);
    expect(evaluateCondition(c('neq', 'pro'), 'pro')).toBe(false);
  });

  it('neq: false on missing value (treat as not-applicable)', () => {
    expect(evaluateCondition(c('neq', 'pro'), undefined)).toBe(false);
  });
});

describe('evaluateCondition — contains / not_contains', () => {
  it('contains: substring match', () => {
    expect(evaluateCondition(c('contains', 'beta'), 'beta-cohort')).toBe(true);
    expect(evaluateCondition(c('contains', 'beta'), 'alpha-cohort')).toBe(false);
  });

  it('contains: coerces non-strings', () => {
    expect(evaluateCondition(c('contains', '1'), 4321)).toBe(true);
  });

  it('not_contains: inverts contains', () => {
    expect(evaluateCondition(c('not_contains', 'beta'), 'alpha-cohort')).toBe(true);
    expect(evaluateCondition(c('not_contains', 'beta'), 'beta-cohort')).toBe(false);
  });

  it('contains: empty values list → non-match', () => {
    expect(evaluateCondition({ attribute: 'a', operator: 'contains', values: [] }, 'beta')).toBe(false);
  });
});

describe('evaluateCondition — in / not_in', () => {
  it('in: matches when value is in list', () => {
    expect(evaluateCondition(c('in', 'DE', 'FR', 'NL'), 'DE')).toBe(true);
    expect(evaluateCondition(c('in', 'DE', 'FR', 'NL'), 'GB')).toBe(false);
  });

  it('in: empty list is non-match (vacuously false)', () => {
    expect(evaluateCondition({ attribute: 'a', operator: 'in', values: [] }, 'DE')).toBe(false);
  });

  it('not_in: matches when value is not in list', () => {
    expect(evaluateCondition(c('not_in', 'DE', 'FR'), 'GB')).toBe(true);
    expect(evaluateCondition(c('not_in', 'DE', 'FR'), 'DE')).toBe(false);
  });

  it('not_in: empty list is vacuously true', () => {
    expect(evaluateCondition({ attribute: 'a', operator: 'not_in', values: [] }, 'DE')).toBe(true);
  });

  it('in: works for numbers', () => {
    expect(evaluateCondition(c('in', 1, 2, 3), 2)).toBe(true);
    expect(evaluateCondition(c('in', 1, 2, 3), 4)).toBe(false);
  });

  it('in: oversized list (>1000) is non-match (fail-safe)', () => {
    const huge = Array.from({ length: 1001 }, (_, i) => `v${i}`);
    expect(evaluateCondition({ attribute: 'a', operator: 'in', values: huge }, 'v500')).toBe(false);
  });
});

describe('evaluateCondition — gt / lt / between', () => {
  it('gt: numeric comparison', () => {
    expect(evaluateCondition(c('gt', 100), 200)).toBe(true);
    expect(evaluateCondition(c('gt', 100), 100)).toBe(false);
    expect(evaluateCondition(c('gt', 100), 50)).toBe(false);
  });

  it('gt: coerces strings to numbers', () => {
    expect(evaluateCondition(c('gt', '100'), '200')).toBe(true);
    expect(evaluateCondition(c('gt', 100), 'not a number')).toBe(false); // NaN → fail-safe
  });

  it('lt: numeric comparison', () => {
    expect(evaluateCondition(c('lt', 100), 50)).toBe(true);
    expect(evaluateCondition(c('lt', 100), 100)).toBe(false);
  });

  it('between: inclusive range', () => {
    expect(evaluateCondition(c('between', 10, 20), 10)).toBe(true);
    expect(evaluateCondition(c('between', 10, 20), 15)).toBe(true);
    expect(evaluateCondition(c('between', 10, 20), 20)).toBe(true);
    expect(evaluateCondition(c('between', 10, 20), 9)).toBe(false);
    expect(evaluateCondition(c('between', 10, 20), 21)).toBe(false);
  });

  it('between: auto-swaps reversed bounds', () => {
    expect(evaluateCondition(c('between', 20, 10), 15)).toBe(true);
  });

  it('between: too few values → non-match', () => {
    expect(evaluateCondition({ attribute: 'a', operator: 'between', values: [10] }, 15)).toBe(false);
  });
});

describe('evaluateCondition — regex', () => {
  it('regex: matches pattern', () => {
    expect(evaluateCondition(c('regex', '^v\\d+$'), 'v42')).toBe(true);
    expect(evaluateCondition(c('regex', '^v\\d+$'), 'beta')).toBe(false);
  });

  it('regex: invalid pattern → fail-safe (returns false)', () => {
    expect(evaluateCondition(c('regex', '['), 'anything')).toBe(false);
  });

  it('regex: input over cap → non-match (ReDoS guard)', () => {
    const huge = 'x'.repeat(11_000);
    expect(evaluateCondition(c('regex', 'x+'), huge)).toBe(false);
  });

  it('regex: empty values list → non-match', () => {
    expect(evaluateCondition({ attribute: 'a', operator: 'regex', values: [] }, 'v42')).toBe(false);
  });
});

describe('evaluateCondition — exists / not_exists', () => {
  it('exists: true when present (non-null, non-undefined)', () => {
    expect(evaluateCondition(c('exists'), 'anything')).toBe(true);
    expect(evaluateCondition(c('exists'), '')).toBe(true); // empty string still exists
    expect(evaluateCondition(c('exists'), 0)).toBe(true);
    expect(evaluateCondition(c('exists'), false)).toBe(true);
  });

  it('exists: false when missing', () => {
    expect(evaluateCondition(c('exists'), undefined)).toBe(false);
    expect(evaluateCondition(c('exists'), null)).toBe(false);
  });

  it('not_exists: inverts exists', () => {
    expect(evaluateCondition(c('not_exists'), undefined)).toBe(true);
    expect(evaluateCondition(c('not_exists'), null)).toBe(true);
    expect(evaluateCondition(c('not_exists'), 'present')).toBe(false);
  });
});

describe('evaluateCondition — fail-safe behavior', () => {
  it('unknown operator falls through to false (defensive)', () => {
    const cond = { attribute: 'a', operator: 'bogus' as 'eq', values: ['x'] };
    expect(evaluateCondition(cond as Condition, 'x')).toBe(false);
  });
});

describe('validateConditions', () => {
  it('accepts a clean rule', () => {
    const errors = validateConditions(
      [c('eq', 'pro'), c('in', 'DE', 'FR'), c('gt', 100)],
      { attr: 'string' },
    );
    // type validation only complains about 'gt' on string
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/cannot be used with attribute "attr" of type string/);
  });

  it('rejects unknown operator', () => {
    const errors = validateConditions(
      [{ attribute: 'a', operator: 'bogus' as 'eq', values: ['x'] }],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/Unknown operator/);
  });

  it('rejects between with wrong arity', () => {
    const errors = validateConditions([c('between', 10)]);
    expect(errors.some(e => /requires exactly 2 values/.test(e.message))).toBe(true);
  });

  it('rejects exists with non-empty values', () => {
    const errors = validateConditions([c('exists', 'wat')]);
    expect(errors.some(e => /takes no values/.test(e.message))).toBe(true);
  });

  it('rejects regex with invalid pattern', () => {
    const errors = validateConditions([c('regex', '[')]);
    expect(errors.some(e => /Invalid regex pattern/.test(e.message))).toBe(true);
  });

  it('rejects in with empty list', () => {
    const errors = validateConditions([{ attribute: 'a', operator: 'in', values: [] }]);
    expect(errors.some(e => /requires at least 1 value/.test(e.message))).toBe(true);
  });

  it('rejects type/operator mismatch when type known', () => {
    const errors = validateConditions(
      [c('gt', 100)],
      { attr: 'string' },
    );
    expect(errors.some(e => /cannot be used with attribute "attr" of type string/.test(e.message))).toBe(true);
  });

  it('ignores type check when attribute is unknown', () => {
    const errors = validateConditions([c('gt', 100)]); // no attributeTypes map
    expect(errors).toHaveLength(0);
  });

  it('reports condition index correctly', () => {
    const errors = validateConditions([
      c('eq', 'x'),
      { attribute: 'a', operator: 'bogus' as 'eq', values: ['x'] },
      c('between', 10),
    ]);
    const idxs = errors.map(e => e.conditionIndex).sort();
    expect(idxs).toEqual([1, 2]);
  });
});

// ── Cross-implementation parity fixture ─────────────────────────────────────
//
// This array is the authoritative behavior table for `evaluateCondition`.
// Server-side (bridge-api) and any other future implementation must reproduce
// these results exactly. Tests in other repos should import-and-run this
// fixture against their evaluator.
export const PARITY_FIXTURE: ReadonlyArray<{
  description: string;
  condition: Condition;
  attributeValue: unknown;
  expected: boolean;
}> = [
  { description: 'eq match',         condition: c('eq', 'pro'),         attributeValue: 'pro',  expected: true  },
  { description: 'eq miss',          condition: c('eq', 'pro'),         attributeValue: 'free', expected: false },
  { description: 'eq undefined',     condition: c('eq', 'pro'),         attributeValue: undefined, expected: false },
  { description: 'neq match',        condition: c('neq', 'pro'),        attributeValue: 'free', expected: true  },
  { description: 'contains hit',     condition: c('contains', 'beta'),  attributeValue: 'beta-c', expected: true },
  { description: 'contains miss',    condition: c('contains', 'beta'),  attributeValue: 'alpha-c', expected: false },
  { description: 'not_contains hit', condition: c('not_contains', 'x'), attributeValue: 'y', expected: true  },
  { description: 'in member',        condition: c('in', 'DE', 'FR'),    attributeValue: 'DE', expected: true  },
  { description: 'in non-member',    condition: c('in', 'DE', 'FR'),    attributeValue: 'GB', expected: false },
  { description: 'not_in non-member',condition: c('not_in', 'DE'),      attributeValue: 'GB', expected: true  },
  { description: 'gt true',          condition: c('gt', 10),            attributeValue: 11,   expected: true  },
  { description: 'gt equal false',   condition: c('gt', 10),            attributeValue: 10,   expected: false },
  { description: 'lt true',          condition: c('lt', 10),            attributeValue: 9,    expected: true  },
  { description: 'between inside',   condition: c('between', 10, 20),   attributeValue: 15,   expected: true  },
  { description: 'between low edge', condition: c('between', 10, 20),   attributeValue: 10,   expected: true  },
  { description: 'between hi edge',  condition: c('between', 10, 20),   attributeValue: 20,   expected: true  },
  { description: 'between below',    condition: c('between', 10, 20),   attributeValue: 9,    expected: false },
  { description: 'regex match',      condition: c('regex', '^v\\d+$'),  attributeValue: 'v42', expected: true },
  { description: 'regex miss',       condition: c('regex', '^v\\d+$'),  attributeValue: 'wat', expected: false },
  { description: 'exists present',   condition: c('exists'),            attributeValue: 0,    expected: true  },
  { description: 'exists missing',   condition: c('exists'),            attributeValue: null, expected: false },
  { description: 'not_exists missing', condition: c('not_exists'),      attributeValue: null, expected: true  },
];

describe('PARITY_FIXTURE — cross-impl behavior table', () => {
  for (const tc of PARITY_FIXTURE) {
    it(tc.description, () => {
      expect(evaluateCondition(tc.condition, tc.attributeValue)).toBe(tc.expected);
    });
  }
});
