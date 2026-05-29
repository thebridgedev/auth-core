// Bridge Feature Flags 2.0 rule evaluator.
//
// This module is the SINGLE SOURCE OF TRUTH for both:
//   - bridge-api server-side eval
//   - bridge-* SDK client-side eval
//
// Imports `evaluateCondition` from the operator module in the same package
// (./operators.js). Server-side bridge-api imports from
// `@nebulr-group/bridge-auth-core` and gets identical semantics.
//
// Companion module: ./operators.ts (operator set + per-condition eval +
// save-time validation). This file builds the rule layer (branches + rollout)
// on top of those primitives.

import { evaluateCondition } from './operators.js';
import type { AttributeType, Condition, Operator } from './operators.js';
import {
  isOperator,
  isOperatorValidForType,
  validOperatorsForType,
} from './operators.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** A branch is a list of conditions (AND-ed) + the value returned on match. */
export interface Branch {
  conditions: Condition[];
  returnValue: unknown;
}

export interface Rule {
  /** First-match-wins. */
  branches: Branch[];
  /** Returned when no branch matches. */
  otherwiseValue: unknown;
  /** 0-100. Applies to the whole rule. */
  rolloutPct: number;
  /** When set, the flag uses a saved group's branches; `branches` is ignored. */
  groupRef?: string;
}

export type FlagState = 'off' | 'on' | 'on-with-rule';

export interface EvalContext {
  /** Stable per-eval identity. Required when rolloutPct < 100. */
  identity?: string;
  /** Flat or nested attribute map. */
  attributes: Record<string, unknown>;
}

export interface EvalResult {
  value: unknown;
  /** Which branch fired, 0-indexed. -1 if otherwise was returned. */
  variantIndex: number;
  matched: boolean;
  excludedByRollout: boolean;
}

// ── Attribute resolution ────────────────────────────────────────────────────

/**
 * Resolve a dotted-path attribute name against the eval context.
 * Tries the flat key first, then walks dots.
 */
export function resolveAttribute(ctx: EvalContext, attribute: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx.attributes, attribute)) {
    return ctx.attributes[attribute];
  }
  const parts = attribute.split('.');
  let current: unknown = ctx.attributes;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Stable hash bucketing ───────────────────────────────────────────────────

/**
 * 32-bit FNV-1a hash of `${flagKey}|${identity}` mod 100. Same bucket for same
 * inputs across server and SDK. Used for rule-level rollout and (future)
 * variant assignment in L: Experiments.
 */
export function bucket(flagKey: string, identity: string): number {
  const input = `${flagKey}|${identity}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash % 100;
}

// ── Branch + rule evaluation ────────────────────────────────────────────────

/** Evaluate a single branch's conditions against the context. AND between conditions. */
export function evaluateBranch(branch: Branch, ctx: EvalContext): boolean {
  if (!branch.conditions || branch.conditions.length === 0) return false;
  return branch.conditions.every((c) => evaluateCondition(c, resolveAttribute(ctx, c.attribute)));
}

/**
 * Evaluate a Rule (branches + otherwise + rollout). First-match-wins; rollout
 * applies to the whole rule (excluded users fall through to otherwise).
 */
export function evaluateRule(rule: Rule, flagKey: string, ctx: EvalContext): EvalResult {
  const rolloutPct = clampPct(rule.rolloutPct ?? 100);

  if (rolloutPct < 100) {
    if (!ctx.identity) {
      return { value: rule.otherwiseValue, variantIndex: -1, matched: false, excludedByRollout: true };
    }
    if (bucket(flagKey, ctx.identity) >= rolloutPct) {
      return { value: rule.otherwiseValue, variantIndex: -1, matched: false, excludedByRollout: true };
    }
  }

  const branches = rule.branches ?? [];
  for (let i = 0; i < branches.length; i++) {
    if (evaluateBranch(branches[i], ctx)) {
      return {
        value: branches[i].returnValue,
        variantIndex: i,
        matched: true,
        excludedByRollout: false,
      };
    }
  }
  return { value: rule.otherwiseValue, variantIndex: -1, matched: false, excludedByRollout: false };
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 100;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

// ── Save-time rule validation ───────────────────────────────────────────────

export interface RuleValidationError {
  branchIndex: number;
  conditionIndex: number;
  attribute?: string;
  operator?: string;
  message: string;
}

const RULE_CONDITIONS_HARD_MAX = 50;

export function validateRule(
  rule: Rule,
  attributeTypes: Readonly<Record<string, AttributeType>> = {},
): RuleValidationError[] {
  const errors: RuleValidationError[] = [];

  if (!rule || typeof rule !== 'object') {
    return [{ branchIndex: -1, conditionIndex: -1, message: 'Rule must be an object.' }];
  }

  const branches = rule.branches ?? [];
  let totalConditions = 0;
  branches.forEach((branch, bi) => {
    if (!branch.conditions || branch.conditions.length === 0) {
      errors.push({
        branchIndex: bi,
        conditionIndex: -1,
        message: `Branch ${bi} has no conditions.`,
      });
      return;
    }
    branch.conditions.forEach((c, ci) => {
      totalConditions++;
      if (!isOperator(c.operator)) {
        errors.push({
          branchIndex: bi,
          conditionIndex: ci,
          attribute: c.attribute,
          operator: c.operator,
          message: `Unknown operator "${c.operator}".`,
        });
        return;
      }
      const opType = attributeTypes[c.attribute];
      if (opType && !isOperatorValidForType(c.operator, opType)) {
        errors.push({
          branchIndex: bi,
          conditionIndex: ci,
          attribute: c.attribute,
          operator: c.operator,
          message: `Operator "${c.operator}" not valid for type ${opType}. Valid: ${validOperatorsForType(opType).join(', ')}.`,
        });
      }
    });
  });

  if (totalConditions > RULE_CONDITIONS_HARD_MAX) {
    errors.push({
      branchIndex: -1,
      conditionIndex: -1,
      message: `Rule has ${totalConditions} conditions; max is ${RULE_CONDITIONS_HARD_MAX}.`,
    });
  }

  if (rule.rolloutPct !== undefined) {
    if (typeof rule.rolloutPct !== 'number' || rule.rolloutPct < 0 || rule.rolloutPct > 100) {
      errors.push({
        branchIndex: -1,
        conditionIndex: -1,
        message: `rolloutPct must be a number in [0, 100], got ${rule.rolloutPct}.`,
      });
    }
  }

  if (rule.groupRef && branches.length > 0) {
    errors.push({
      branchIndex: -1,
      conditionIndex: -1,
      message: 'Rule cannot have both an inline `branches` and a `groupRef`.',
    });
  }

  return errors;
}

// Re-export operator types for convenience
export type { Operator, AttributeType, Condition };
