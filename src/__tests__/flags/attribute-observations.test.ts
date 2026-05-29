// Per-call attribute observation tests (TBP-178).
//
// When the dev passes attributes via the per-call `context` argument, the
// SDK emits an `onAttributeObserved` event for each distinct (key, value)
// once per runtime. The telemetry batcher relays these to /v1/flags/discover
// with `kind: 'attribute'` so the admin UI's attribute catalog stays current.

import { describe, expect, it, vi } from 'vitest';
import { BridgeFlags, type AttributeObservation, type CachedFlag } from '../../flags/flag.js';

const flag: CachedFlag = {
  key: 'feature',
  state: 'on-with-rule',
  valueType: 'boolean',
  offValue: false,
  onValue: true,
  rule: {
    branches: [
      { conditions: [{ attribute: 'plan', operator: 'eq', values: ['enterprise'] }], returnValue: true },
    ],
    otherwiseValue: false,
    rolloutPct: 100,
  },
};

describe('BridgeFlags — onAttributeObserved (TBP-178)', () => {
  it('fires once per (key, value) when per-call attributes are supplied', () => {
    const onAttributeObserved = vi.fn();
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setHooks({ onAttributeObserved });

    b.flag('feature', false, { attributes: { plan: 'enterprise' } });
    b.flag('feature', false, { attributes: { plan: 'enterprise' } });

    expect(onAttributeObserved).toHaveBeenCalledTimes(1);
    const ev = onAttributeObserved.mock.calls[0][0] as AttributeObservation;
    expect(ev.key).toBe('plan');
    expect(ev.sampleValue).toBe('enterprise');
    expect(ev.observedType).toBe('string');
    expect(typeof ev.timestamp).toBe('number');
  });

  it('fires again when the sample value changes for the same key', () => {
    const onAttributeObserved = vi.fn();
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setHooks({ onAttributeObserved });

    b.flag('feature', false, { attributes: { plan: 'enterprise' } });
    b.flag('feature', false, { attributes: { plan: 'pro' } });
    b.flag('feature', false, { attributes: { plan: 'pro' } });

    expect(onAttributeObserved).toHaveBeenCalledTimes(2);
    expect((onAttributeObserved.mock.calls[0][0] as AttributeObservation).sampleValue).toBe('enterprise');
    expect((onAttributeObserved.mock.calls[1][0] as AttributeObservation).sampleValue).toBe('pro');
  });

  it('fires per distinct attribute key in the same call', () => {
    const onAttributeObserved = vi.fn();
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setHooks({ onAttributeObserved });

    b.flag('feature', false, {
      attributes: { plan: 'pro', country: 'SE', beta: true },
    });

    expect(onAttributeObserved).toHaveBeenCalledTimes(3);
    const keys = onAttributeObserved.mock.calls.map((c) => (c[0] as AttributeObservation).key).sort();
    expect(keys).toEqual(['beta', 'country', 'plan']);
  });

  it('infers observedType from the sample value', () => {
    const onAttributeObserved = vi.fn();
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setHooks({ onAttributeObserved });

    b.flag('feature', false, {
      attributes: { s: 'x', n: 42, bool: true, obj: { nested: 1 } },
    });

    const byKey = Object.fromEntries(
      onAttributeObserved.mock.calls.map((c) => {
        const ev = c[0] as AttributeObservation;
        return [ev.key, ev.observedType];
      }),
    );
    expect(byKey).toEqual({ s: 'string', n: 'number', bool: 'boolean', obj: 'json' });
  });

  it('does not fire when no per-call attributes are supplied', () => {
    const onAttributeObserved = vi.fn();
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setContext({ identity: 'u', attributes: { plan: 'enterprise' } });
    b.setHooks({ onAttributeObserved });

    b.flag('feature', false); // no per-call context
    b.flag('feature', false, { identity: 'u' }); // identity only, no attributes

    expect(onAttributeObserved).not.toHaveBeenCalled();
  });

  it('hook errors do not break eval', () => {
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setHooks({
      onAttributeObserved: () => {
        throw new Error('boom');
      },
    });

    expect(() =>
      b.flag('feature', false, { attributes: { plan: 'enterprise' } }),
    ).not.toThrow();
    expect(b.flag('feature', false, { attributes: { plan: 'enterprise' } })).toBe(true);
  });

  it('ignores empty-string attribute keys', () => {
    const onAttributeObserved = vi.fn();
    const b = new BridgeFlags();
    b.hydrate([flag]);
    b.setHooks({ onAttributeObserved });

    b.flag('feature', false, { attributes: { '': 'ignored', plan: 'pro' } });

    expect(onAttributeObserved).toHaveBeenCalledTimes(1);
    expect((onAttributeObserved.mock.calls[0][0] as AttributeObservation).key).toBe('plan');
  });
});
