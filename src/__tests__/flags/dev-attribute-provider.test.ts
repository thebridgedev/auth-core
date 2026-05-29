// Phase 5 (TBP-328/329/330/335) — DevAttributeProvider unit tests.
//
// Verifies the contract behind `bridge.attributes.set/bind/bindMany/get`:
//   - set/bind/bindMany contribute keys to the merged provide() map
//   - bind getters re-run on each provide() call (live values)
//   - bindMany getters merge their map; reserved keys silently dropped
//   - reserved-namespace keys at set/bind time → console.warn + write rejected
//   - unset / clearBulk / clear behave as documented
//   - isObserved() flips with the observed: false flag
//   - subscribe() fires immediately with current snapshot, again on writes

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevAttributeProvider } from '../../flags/dev-attribute-provider.js';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('DevAttributeProvider.set (Phase 5, TBP-328)', () => {
  it('contributes a static key/value to provide()', () => {
    const p = new DevAttributeProvider();
    p.set('cohort', 'experiment-A');
    expect(p.provide()).toEqual({ cohort: 'experiment-A' });
  });

  it('replaces the value when set is called twice on the same key', () => {
    const p = new DevAttributeProvider();
    p.set('k', 1);
    p.set('k', 2);
    expect(p.provide()).toEqual({ k: 2 });
  });

  it('accepts non-string values (numbers, booleans, objects)', () => {
    const p = new DevAttributeProvider();
    p.set('n', 42);
    p.set('b', true);
    p.set('o', { nested: 'value' });
    expect(p.provide()).toEqual({ n: 42, b: true, o: { nested: 'value' } });
  });
});

describe('DevAttributeProvider.bind (Phase 5, TBP-328)', () => {
  it('re-invokes the getter on every provide() call', () => {
    const p = new DevAttributeProvider();
    let n = 0;
    p.bind('counter', () => ++n);
    expect(p.provide()).toEqual({ counter: 1 });
    expect(p.provide()).toEqual({ counter: 2 });
    expect(p.provide()).toEqual({ counter: 3 });
  });

  it('a throwing getter is isolated — other keys still flow through', () => {
    const p = new DevAttributeProvider();
    p.bind('ok', () => 'value');
    p.bind('bad', () => {
      throw new Error('boom');
    });
    expect(p.provide()).toEqual({ ok: 'value' });
  });

  it('bind() over an existing set() replaces the entry', () => {
    const p = new DevAttributeProvider();
    p.set('mode', 'static');
    p.bind('mode', () => 'live');
    expect(p.provide()).toEqual({ mode: 'live' });
  });
});

describe('DevAttributeProvider.bindMany (Phase 5, TBP-328)', () => {
  it('merges the returned map into provide()', () => {
    const p = new DevAttributeProvider();
    p.bindMany(() => ({ a: 1, b: 2 }));
    expect(p.provide()).toEqual({ a: 1, b: 2 });
  });

  it('individual set()/bind() values WIN over bulk on key collision', () => {
    const p = new DevAttributeProvider();
    p.bindMany(() => ({ a: 'from-bulk', b: 'from-bulk' }));
    p.set('a', 'from-set');
    p.bind('b', () => 'from-bind');
    expect(p.provide()).toEqual({ a: 'from-set', b: 'from-bind' });
  });

  it('silently drops reserved-prefix keys returned by the bulk getter', () => {
    const p = new DevAttributeProvider();
    p.bindMany(() => ({ ok: 1, 'bridge:reserved': 'nope' } as any));
    expect(p.provide()).toEqual({ ok: 1 });
  });

  it('a throwing bulk getter is isolated — others + direct entries still flow', () => {
    const p = new DevAttributeProvider();
    p.bind('direct', () => 'D');
    p.bindMany(() => {
      throw new Error('boom');
    });
    p.bindMany(() => ({ healthy: true }));
    expect(p.provide()).toEqual({ direct: 'D', healthy: true });
  });

  it('returns empty when bulk getter returns null/undefined/non-object', () => {
    const p = new DevAttributeProvider();
    p.bindMany(() => null as any);
    p.bindMany(() => undefined as any);
    p.bindMany(() => 'not-an-object' as any);
    expect(p.provide()).toEqual({});
  });
});

describe('Reserved bridge: namespace (Phase 5, TBP-329)', () => {
  it('rejects set() of a bridge: key and warns', () => {
    const p = new DevAttributeProvider();
    p.set('bridge:plan', 'pro');
    expect(p.provide()).toEqual({});
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('reserved');
  });

  it('rejects bind() of a bridge: key and warns', () => {
    const p = new DevAttributeProvider();
    p.bind('bridge:role', () => 'owner');
    expect(p.provide()).toEqual({});
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does NOT reject custom-namespace keys like "app.foo" or "tenant.bar"', () => {
    const p = new DevAttributeProvider();
    p.set('app.cohort', 'A');
    p.set('tenant.tier', 'gold');
    expect(p.provide()).toEqual({ 'app.cohort': 'A', 'tenant.tier': 'gold' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('Observation opt-out (Phase 5, TBP-330)', () => {
  it('isObserved() defaults to true for set/bind', () => {
    const p = new DevAttributeProvider();
    p.set('a', 1);
    p.bind('b', () => 2);
    expect(p.isObserved('a')).toBe(true);
    expect(p.isObserved('b')).toBe(true);
  });

  it('set(..., { observed: false }) flips the flag', () => {
    const p = new DevAttributeProvider();
    p.set('x', 1, { observed: false });
    expect(p.isObserved('x')).toBe(false);
  });

  it('bind(..., { observed: false }) flips the flag', () => {
    const p = new DevAttributeProvider();
    p.bind('x', () => 1, { observed: false });
    expect(p.isObserved('x')).toBe(false);
  });

  it('unknown key defaults to true (bulk fallback)', () => {
    const p = new DevAttributeProvider();
    expect(p.isObserved('never-registered')).toBe(true);
  });
});

describe('unset / clearBulk / clear', () => {
  it('unset() removes a static or bound key', () => {
    const p = new DevAttributeProvider();
    p.set('a', 1);
    p.bind('b', () => 2);
    p.unset('a');
    p.unset('b');
    expect(p.provide()).toEqual({});
  });

  it('clearBulk() removes only bulk getters', () => {
    const p = new DevAttributeProvider();
    p.set('a', 1);
    p.bindMany(() => ({ b: 2 }));
    p.clearBulk();
    expect(p.provide()).toEqual({ a: 1 });
  });

  it('clear() removes everything', () => {
    const p = new DevAttributeProvider();
    p.set('a', 1);
    p.bind('b', () => 2);
    p.bindMany(() => ({ c: 3 }));
    p.clear();
    expect(p.provide()).toEqual({});
  });
});

describe('subscribe() — Svelte store contract', () => {
  it('fires immediately with the current snapshot', () => {
    const p = new DevAttributeProvider();
    p.set('a', 1);
    const seen: Record<string, unknown>[] = [];
    const unsub = p.subscribe((m) => seen.push(m));
    unsub();
    expect(seen).toEqual([{ a: 1 }]);
  });

  it('fires again on set/bind/bindMany/unset/clear', () => {
    const p = new DevAttributeProvider();
    const seen: Record<string, unknown>[] = [];
    const unsub = p.subscribe((m) => seen.push(m));
    p.set('a', 1);
    p.bind('b', () => 2);
    p.bindMany(() => ({ c: 3 }));
    p.unset('a');
    unsub();
    expect(seen).toHaveLength(5); // initial + 4 writes
    expect(seen[seen.length - 1]).toEqual({ b: 2, c: 3 });
  });
});

describe('get() === provide()', () => {
  it('is the public read alias for provide()', () => {
    const p = new DevAttributeProvider();
    p.set('a', 1);
    expect(p.get()).toEqual(p.provide());
  });
});
