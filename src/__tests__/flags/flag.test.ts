import { describe, expect, it, vi } from 'vitest';
import { BridgeFlags, type CachedFlag } from '../../flags/flag.js';

const boolFlag = (over: Partial<CachedFlag> = {}): CachedFlag => ({
  key: 'dark_mode',
  state: 'on',
  valueType: 'boolean',
  offValue: false,
  onValue: true,
  ...over,
});

describe('BridgeFlags — basic cache + read', () => {
  it('returns the default when the flag is not in cache', () => {
    const b = new BridgeFlags();
    expect(b.flag('unknown', false).value).toBe(false);
    expect(b.flag('unknown', 'fallback').value).toBe('fallback');
    expect(b.flag('unknown', 42).value).toBe(42);
  });

  it('returns onValue for state=on', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'on', onValue: true, offValue: false })]);
    expect(b.flag('dark_mode', false).value).toBe(true);
  });

  it('returns offValue for state=off', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'off', onValue: true, offValue: false })]);
    expect(b.flag('dark_mode', true).value).toBe(false);
  });

  it('infers TypeScript type from default (boolean default → boolean return)', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'on' })]);
    const v: boolean = b.flag('dark_mode', false).value; // would not compile without inference
    expect(v).toBe(true);
  });

  it('falls back to default when cached value type mismatches inferred type', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'on', onValue: 'a string' as any })]); // bad type in cache
    expect(b.flag('dark_mode', false).value).toBe(false); // default wins
  });

  it('handles JSON-typed flags', () => {
    const cfg = { timeout: 5000, retries: 3 };
    const b = new BridgeFlags();
    b.hydrate([
      { key: 'cfg', state: 'on', valueType: 'json', offValue: {}, onValue: cfg },
    ]);
    expect(b.flag('cfg', {}).value).toEqual(cfg);
  });
});

describe('BridgeFlags — rule evaluation', () => {
  const ruleFlag: CachedFlag = {
    key: 'eu_pricing',
    state: 'on-with-rule',
    valueType: 'string',
    offValue: 'us-pricing',
    onValue: 'eu-pricing',
    rule: {
      branches: [
        {
          conditions: [{ attribute: 'country', operator: 'in', values: ['DE', 'FR'] }],
          returnValue: 'eu-pricing',
        },
      ],
      otherwiseValue: 'us-pricing',
      rolloutPct: 100,
    },
  };

  it('evaluates a rule against the current context', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag]);
    b.setContext({ identity: 'u-1', attributes: { country: 'DE' } });
    expect(b.flag('eu_pricing', 'us-pricing').value).toBe('eu-pricing');
    b.setContext({ identity: 'u-1', attributes: { country: 'GB' } });
    expect(b.flag('eu_pricing', 'us-pricing').value).toBe('us-pricing');
  });

  it('context.merge mode keeps existing attributes', () => {
    const b = new BridgeFlags();
    b.setContext({ identity: 'u-1', attributes: { country: 'DE', plan: 'pro' } });
    b.setContext({ attributes: { country: 'FR' } }, true);
    expect(b.getContext().attributes).toEqual({ country: 'FR', plan: 'pro' });
    expect(b.getContext().identity).toBe('u-1');
  });
});

describe('BridgeFlags — discovery hook', () => {
  it('fires onDiscover the first time an unknown flag is read', () => {
    const b = new BridgeFlags();
    const onDiscover = vi.fn();
    b.setHooks({ onDiscover });
    b.flag('new_flag', false);
    b.flag('new_flag', false); // second call should not re-fire
    expect(onDiscover).toHaveBeenCalledTimes(1);
    expect(onDiscover.mock.calls[0][0].flag).toBe('new_flag');
    expect(onDiscover.mock.calls[0][0].defaultValue).toBe(false);
    expect(onDiscover.mock.calls[0][0].observedType).toBe('boolean');
  });

  it('infers observedType from the default', () => {
    const b = new BridgeFlags();
    const onDiscover = vi.fn();
    b.setHooks({ onDiscover });
    b.flag('a_str', 'x');
    b.flag('a_num', 1);
    b.flag('a_json', { foo: 'bar' });
    expect(onDiscover.mock.calls.map((c) => c[0].observedType)).toEqual(['string', 'number', 'json']);
  });

  it('does not call onDiscover for known flags', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag()]);
    const onDiscover = vi.fn();
    b.setHooks({ onDiscover });
    b.flag('dark_mode', false);
    expect(onDiscover).not.toHaveBeenCalled();
  });
});

describe('BridgeFlags — eval telemetry hook', () => {
  it('fires onEval on every read of a known flag', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'on' })]);
    const onEval = vi.fn();
    b.setHooks({ onEval });
    b.flag('dark_mode', false);
    b.flag('dark_mode', false);
    expect(onEval).toHaveBeenCalledTimes(2);
    expect(onEval.mock.calls[0][0].flag).toBe('dark_mode');
    expect(onEval.mock.calls[0][0].value).toBe(true);
  });

  it('does not fire onEval for unknown flags', () => {
    const b = new BridgeFlags();
    const onEval = vi.fn();
    b.setHooks({ onEval });
    b.flag('unknown', false);
    expect(onEval).not.toHaveBeenCalled();
  });

  it('eval telemetry includes identity', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'on' })]);
    b.setContext({ identity: 'u-1', attributes: {} });
    const onEval = vi.fn();
    b.setHooks({ onEval });
    b.flag('dark_mode', false);
    expect(onEval.mock.calls[0][0].identity).toBe('u-1');
  });

  it('eval telemetry includes variantIndex from the evaluator', () => {
    const b = new BridgeFlags();
    b.hydrate([
      {
        key: 'rule_flag',
        state: 'on-with-rule',
        valueType: 'string',
        offValue: 'c',
        onValue: 'a',
        rule: {
          branches: [
            { conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }], returnValue: 'a' },
            { conditions: [{ attribute: 'beta', operator: 'eq', values: [true] }], returnValue: 'b' },
          ],
          otherwiseValue: 'c',
          rolloutPct: 100,
        },
      },
    ]);
    const onEval = vi.fn();
    b.setHooks({ onEval });
    b.setContext({ identity: 'u', attributes: { plan: 'free', beta: true } });
    b.flag('rule_flag', 'default');
    expect(onEval.mock.calls[0][0].variantIndex).toBe(1);
  });

  it('telemetry hook errors do not break eval', () => {
    const b = new BridgeFlags();
    b.hydrate([boolFlag({ state: 'on' })]);
    b.setHooks({
      onEval: () => {
        throw new Error('boom');
      },
    });
    expect(() => b.flag('dark_mode', false)).not.toThrow();
    expect(b.flag('dark_mode', false).value).toBe(true);
  });
});

describe('BridgeFlags — cache mutations', () => {
  it('upsert replaces a flag', () => {
    const b = new BridgeFlags();
    b.upsert(boolFlag({ state: 'off' }));
    expect(b.flag('dark_mode', true).value).toBe(false);
    b.upsert(boolFlag({ state: 'on' }));
    expect(b.flag('dark_mode', false).value).toBe(true);
  });

  it('remove drops the flag', () => {
    const b = new BridgeFlags();
    b.upsert(boolFlag({ state: 'on' }));
    expect(b.flag('dark_mode', false).value).toBe(true);
    b.remove('dark_mode');
    expect(b.flag('dark_mode', false).value).toBe(false);
  });

  it('hydrate replaces the entire cache', () => {
    const b = new BridgeFlags();
    b.upsert(boolFlag({ key: 'a' }));
    b.upsert(boolFlag({ key: 'b' }));
    expect(b.cacheSize()).toBe(2);
    b.hydrate([boolFlag({ key: 'c' })]);
    expect(b.cacheSize()).toBe(1);
    expect(b.cachedKeys()).toEqual(['c']);
  });
});
