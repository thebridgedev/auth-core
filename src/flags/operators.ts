// The locked operator set for Bridge Feature Flags v1.
//
// This module is the SINGLE SOURCE OF TRUTH for both:
//   - bridge-api server-side rule evaluation
//   - bridge-* SDK client-side rule evaluation (via auth-core)
//
// Adding or removing an operator is a breaking change of the v1 contract.
// The `OPERATOR_VERSION` constant is forward-compat space — a stored rule
// carries the operator-set version it was authored against, so future
// expansions of the closed set can be migrated cleanly.

export const OPERATORS = [
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
] as const;

export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_VERSION = 1 as const;

export type AttributeType = 'string' | 'number' | 'boolean' | 'date';

// Which operators are valid for which attribute type. Used by:
//   - Server-side save-time validation (reject mixed-type rules)
//   - Admin UI operator picker (filter dropdown by attribute type)
//   - SDK eval (defensive — should already be validated server-side)
const VALID_OPERATORS_BY_TYPE: Readonly<Record<AttributeType, ReadonlyArray<Operator>>> = {
  string: ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'regex', 'exists', 'not_exists'],
  number: ['eq', 'neq', 'gt', 'lt', 'between', 'in', 'not_in', 'exists', 'not_exists'],
  boolean: ['eq', 'neq', 'exists', 'not_exists'],
  date: ['eq', 'neq', 'gt', 'lt', 'between', 'exists', 'not_exists'],
};

export function isOperator(value: unknown): value is Operator {
  return typeof value === 'string' && (OPERATORS as ReadonlyArray<string>).includes(value);
}

export function isOperatorValidForType(op: Operator, type: AttributeType): boolean {
  return VALID_OPERATORS_BY_TYPE[type]?.includes(op) ?? false;
}

export function validOperatorsForType(type: AttributeType): ReadonlyArray<Operator> {
  return VALID_OPERATORS_BY_TYPE[type] ?? [];
}

// ── Safety limits ───────────────────────────────────────────────────────────
//
// Bounds on inputs that protect against denial-of-service or pathological
// rules. These are deliberately generous — they exist to draw a line, not to
// constrain reasonable use. Anything beyond these limits is treated as a
// non-match rather than evaluated (fail-safe).

// Cap regex input length to mitigate ReDoS on malicious patterns. Inputs
// longer than this are treated as non-matching rather than evaluated.
// Note: a real sandboxed regex engine (e.g. re2-wasm) is a future hardening
// step. v1 caps input + uses try/catch around the standard engine.
const REGEX_INPUT_MAX = 10_000;

// Hard cap on the number of items in `in` / `not_in` value arrays.
const IN_LIST_MAX = 1_000;

// Hard cap on the number of conditions allowed in a single rule (across
// all branches combined). Enforced at save time by the server, exposed here
// so the UI can surface the limit consistently.
export const CONDITIONS_PER_RULE_MAX = 50;

// ── Condition shape ─────────────────────────────────────────────────────────

export type ConditionValue = string | number | boolean | null;

export interface Condition {
  attribute: string;
  operator: Operator;
  values: ReadonlyArray<ConditionValue>;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate a single condition against an attribute value.
 *
 * @param condition       The condition (attribute, operator, values) from the rule.
 * @param attributeValue  The value of the named attribute in the eval context.
 *                        May be undefined / null if the SDK didn't supply it.
 * @returns true if the condition matches; false otherwise.
 *
 * Operator semantics:
 *   eq            attributeValue === values[0]
 *   neq           attributeValue !== values[0]
 *   contains      String(attributeValue).includes(String(values[0]))
 *   not_contains  ! contains
 *   in            values.includes(attributeValue)
 *   not_in        ! in
 *   gt            Number(attributeValue) > Number(values[0])
 *   lt            Number(attributeValue) < Number(values[0])
 *   between       Number(values[0]) <= Number(attributeValue) <= Number(values[1])
 *                 (values[0] and values[1] are auto-swapped if out of order)
 *   regex         new RegExp(String(values[0])).test(String(attributeValue))
 *   exists        attributeValue !== undefined && attributeValue !== null
 *   not_exists    ! exists
 *
 * Fail-safe rule: any malformed input (wrong number of values, non-numeric
 * value for a numeric operator, invalid regex, oversized input) returns false
 * rather than throwing. The server must still validate at save time; this
 * function is intentionally lenient at runtime so a bad rule never crashes
 * the consuming app.
 */
export function evaluateCondition(condition: Condition, attributeValue: unknown): boolean {
  const { operator, values } = condition;

  // exists / not_exists handle missing values specially — short-circuit first
  if (operator === 'exists') {
    return attributeValue !== undefined && attributeValue !== null;
  }
  if (operator === 'not_exists') {
    return attributeValue === undefined || attributeValue === null;
  }

  // For every other operator: a missing attribute is always a non-match
  if (attributeValue === undefined || attributeValue === null) {
    return false;
  }

  switch (operator) {
    case 'eq':
      return values.length > 0 && values[0] === attributeValue;

    case 'neq':
      return values.length > 0 && values[0] !== attributeValue;

    case 'contains': {
      if (values.length === 0) return false;
      return String(attributeValue).includes(String(values[0]));
    }

    case 'not_contains': {
      if (values.length === 0) return false;
      return !String(attributeValue).includes(String(values[0]));
    }

    case 'in': {
      if (values.length === 0 || values.length > IN_LIST_MAX) return false;
      return values.includes(attributeValue as ConditionValue);
    }

    case 'not_in': {
      // An empty `not_in` list is vacuously true (no values to exclude).
      if (values.length > IN_LIST_MAX) return false;
      return !values.includes(attributeValue as ConditionValue);
    }

    case 'gt': {
      if (values.length === 0) return false;
      const n = Number(attributeValue);
      const t = Number(values[0]);
      if (Number.isNaN(n) || Number.isNaN(t)) return false;
      return n > t;
    }

    case 'lt': {
      if (values.length === 0) return false;
      const n = Number(attributeValue);
      const t = Number(values[0]);
      if (Number.isNaN(n) || Number.isNaN(t)) return false;
      return n < t;
    }

    case 'between': {
      if (values.length < 2) return false;
      const n = Number(attributeValue);
      const a = Number(values[0]);
      const b = Number(values[1]);
      if (Number.isNaN(n) || Number.isNaN(a) || Number.isNaN(b)) return false;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return n >= lo && n <= hi;
    }

    case 'regex': {
      if (values.length === 0) return false;
      const input = String(attributeValue);
      if (input.length > REGEX_INPUT_MAX) return false;
      try {
        const re = new RegExp(String(values[0]));
        return re.test(input);
      } catch {
        // Invalid regex pattern — fail-safe: treat as non-match.
        return false;
      }
    }

    default: {
      // Exhaustiveness check — `operator` is typed as Operator, so this
      // branch should be unreachable. If it's hit, the rule was authored
      // against a future operator set and we should fail-safe.
      const _exhaustive: never = operator;
      void _exhaustive;
      return false;
    }
  }
}

// ── Save-time validation ────────────────────────────────────────────────────

export interface ValidationError {
  /** Index of the condition within its containing branch (or -1 if global). */
  conditionIndex: number;
  attribute: string;
  operator: Operator;
  message: string;
}

/**
 * Validate a list of conditions against a known attribute type map at save time.
 *
 * @param conditions       The conditions to validate (e.g. a branch's `conditions`).
 * @param attributeTypes   Map of attribute key → known type. If an attribute is
 *                         not in the map its type is treated as unknown and
 *                         validation only checks operator membership in the
 *                         locked set (not type compatibility).
 * @returns list of validation errors; empty list means valid.
 */
export function validateConditions(
  conditions: ReadonlyArray<Condition>,
  attributeTypes: Readonly<Record<string, AttributeType>> = {},
): ValidationError[] {
  const errors: ValidationError[] = [];

  conditions.forEach((c, i) => {
    if (!isOperator(c.operator)) {
      errors.push({
        conditionIndex: i,
        attribute: c.attribute,
        operator: c.operator as Operator,
        message: `Unknown operator "${c.operator}". Valid operators: ${OPERATORS.join(', ')}.`,
      });
      return;
    }

    // Per-operator structural validation
    switch (c.operator) {
      case 'between':
        if (c.values.length !== 2) {
          errors.push({
            conditionIndex: i,
            attribute: c.attribute,
            operator: c.operator,
            message: `Operator "between" requires exactly 2 values, got ${c.values.length}.`,
          });
        }
        break;
      case 'in':
      case 'not_in':
        if (c.values.length === 0) {
          errors.push({
            conditionIndex: i,
            attribute: c.attribute,
            operator: c.operator,
            message: `Operator "${c.operator}" requires at least 1 value.`,
          });
        } else if (c.values.length > IN_LIST_MAX) {
          errors.push({
            conditionIndex: i,
            attribute: c.attribute,
            operator: c.operator,
            message: `Operator "${c.operator}" supports at most ${IN_LIST_MAX} values, got ${c.values.length}.`,
          });
        }
        break;
      case 'exists':
      case 'not_exists':
        if (c.values.length !== 0) {
          errors.push({
            conditionIndex: i,
            attribute: c.attribute,
            operator: c.operator,
            message: `Operator "${c.operator}" takes no values, got ${c.values.length}.`,
          });
        }
        break;
      case 'regex':
        if (c.values.length !== 1) {
          errors.push({
            conditionIndex: i,
            attribute: c.attribute,
            operator: c.operator,
            message: `Operator "regex" requires exactly 1 value, got ${c.values.length}.`,
          });
        } else {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const _ = new RegExp(String(c.values[0]));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push({
              conditionIndex: i,
              attribute: c.attribute,
              operator: c.operator,
              message: `Invalid regex pattern: ${msg}`,
            });
          }
        }
        break;
      default:
        // Most binary operators expect exactly 1 value
        if (c.values.length !== 1) {
          errors.push({
            conditionIndex: i,
            attribute: c.attribute,
            operator: c.operator,
            message: `Operator "${c.operator}" requires exactly 1 value, got ${c.values.length}.`,
          });
        }
        break;
    }

    // Type-vs-operator compatibility (only when the attribute's type is known)
    const type = attributeTypes[c.attribute];
    if (type && !isOperatorValidForType(c.operator, type)) {
      errors.push({
        conditionIndex: i,
        attribute: c.attribute,
        operator: c.operator,
        message: `Operator "${c.operator}" cannot be used with attribute "${c.attribute}" of type ${type}. Valid operators for ${type}: ${validOperatorsForType(type).join(', ')}.`,
      });
    }
  });

  return errors;
}
