// Per-call context override tests (TBP-167).
//
// The global SDK context (set via setContext) is the default, but each
// bridge.flag() call can pass a per-call override. Attributes deep-merge:
// per-call wins on overlap, global keys not in the override are preserved.

import { describe, expect, it, vi } from 'vitest';
import { BridgeFlags, type CachedFlag } from '../../flags/flag.js';

const ruleFlag: CachedFlag = {
  key: 'eu_pricing',
  state: 'on-with-rule',
  valueType: 'string',
  offValue: 'us-pricing',
  onValue: 'eu-pricing',
  rule: {
    branches: [
      { conditions: [{ attribute: 'country', operator: 'in', values: ['DE', 'FR'] }], returnValue: 'eu-pricing' },
    ],
    otherwiseValue: 'us-pricing',
    rolloutPct: 100,
  },
};

describe('BridgeFlags — per-call context override (TBP-167)', () => {
  it('uses global context when no per-call override is supplied', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'u-1', attributes: { country: 'DE' } });
    expect(b.flag('eu_pricing', 'us-pricing').value).toBe('eu-pricing');
  });

  it('per-call attributes override global on overlap', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'u-1', attributes: { country: 'DE' } });
    // Override country = GB just for this call
    expect(b.flag('eu_pricing', 'us-pricing', { attributes: { country: 'GB' } }).value).toBe('us-pricing');
    // Global context untouched
    expect(b.getContext().attributes.country).toBe('DE');
  });

  it('per-call attributes merge with global (global keys preserved)', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'u-1', attributes: { country: 'DE', plan: 'pro' } });
    // Override country; plan should still come from global
    const fl: CachedFlag = {
      ...ruleFlag,
      rule: {
        branches: [
          {
            conditions: [
              { attribute: 'plan', operator: 'eq', values: ['pro'] },
              { attribute: 'country', operator: 'in', values: ['DE', 'FR'] },
            ],
            returnValue: 'eu-pricing',
          },
        ],
        otherwiseValue: 'us-pricing',
        rolloutPct: 100,
      },
    };
    b.hydrate([fl]);
    // Override only country → plan (global=pro) + country (override=FR) → matches
    expect(b.flag('eu_pricing', 'us-pricing', { attributes: { country: 'FR' } }).value).toBe('eu-pricing');
  });

  it('per-call identity overrides global identity', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'global-user', attributes: { country: 'GB' } });
    const onEval = vi.fn();
    b.setHooks({ onEval });
    b.flag('eu_pricing', 'us-pricing', { identity: 'per-call-user' });
    expect(onEval.mock.calls[0][0].identity).toBe('per-call-user');
  });

  it('per-call identity falls back to global when omitted', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'global-user', attributes: { country: 'DE' } });
    const onEval = vi.fn();
    b.setHooks({ onEval });
    b.flag('eu_pricing', 'us-pricing', { attributes: { country: 'FR' } });
    expect(onEval.mock.calls[0][0].identity).toBe('global-user');
  });

  it('anonymous eval (no identity globally or per-call) still works for rules without rollout', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]); // rolloutPct: 100 — no identity needed
    expect(b.flag('eu_pricing', 'us-pricing', { attributes: { country: 'DE' } }).value).toBe('eu-pricing');
  });

  it('per-call attributes do not pollute global state', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'u-1', attributes: { country: 'GB' } });
    b.flag('eu_pricing', 'us-pricing', { attributes: { country: 'FR' } });
    expect(b.getContext().attributes.country).toBe('GB');
  });

  it('per-call context with only identity (no attributes) works', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'global', attributes: { country: 'DE' } });
    // Override identity only — attributes come from global
    const result = b.flag('eu_pricing', 'us-pricing', { identity: 'per-call' });
    expect(result.value).toBe('eu-pricing'); // country: DE from global still matches
  });

  it('empty per-call context behaves the same as no override', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'u-1', attributes: { country: 'DE' } });
    expect(b.flag('eu_pricing', 'us-pricing', {}).value).toBe('eu-pricing');
  });
});
