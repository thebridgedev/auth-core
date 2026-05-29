import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeFlags } from '../../flags/flag.js';
import {
  AttributeProviderRegistry,
  BillingAttributeProvider,
  type BillingSnapshot,
} from '../../flags/attribute-providers.js';

describe('BillingAttributeProvider — identity', () => {
  it('has the correct name + namespace', () => {
    const p = new BillingAttributeProvider();
    expect(p.name).toBe('bridge:billing');
    expect(p.namespace).toBe('bridge');
  });

  it('instantiates without config (returns empty attrs, no crash)', async () => {
    const p = new BillingAttributeProvider();
    expect(await p.provide()).toEqual({});
  });
});

describe('BillingAttributeProvider — undefined / empty snapshots', () => {
  it('returns {} when getBillingSnapshot returns undefined', async () => {
    const p = new BillingAttributeProvider({ getBillingSnapshot: () => undefined });
    expect(await p.provide()).toEqual({});
  });

  it('returns {} when getBillingSnapshot returns an empty object', async () => {
    const p = new BillingAttributeProvider({ getBillingSnapshot: () => ({}) });
    expect(await p.provide()).toEqual({});
  });

  it('returns {} when async getBillingSnapshot resolves to undefined', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: async () => undefined,
    });
    expect(await p.provide()).toEqual({});
  });
});

describe('BillingAttributeProvider — scalar fields', () => {
  it('passes plan through under bridge:billing.plan', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ plan: 'PRO' }),
    });
    expect(await p.provide()).toEqual({ 'bridge:billing.plan': 'PRO' });
  });

  it('passes trial=true through', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ trial: true }),
    });
    expect(await p.provide()).toEqual({ 'bridge:billing.trial': true });
  });

  it('passes trial=false through (not just truthy)', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ trial: false }),
    });
    expect(await p.provide()).toEqual({ 'bridge:billing.trial': false });
  });

  it('emits plan + trial together', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ plan: 'TEAM', trial: false }),
    });
    expect(await p.provide()).toEqual({
      'bridge:billing.plan': 'TEAM',
      'bridge:billing.trial': false,
    });
  });

  it('skips plan when not a string', async () => {
    const p = new BillingAttributeProvider({
      // @ts-expect-error — intentional bad shape
      getBillingSnapshot: () => ({ plan: 42 }),
    });
    expect(await p.provide()).toEqual({});
  });

  it('skips trial when not a boolean', async () => {
    const p = new BillingAttributeProvider({
      // @ts-expect-error — intentional bad shape
      getBillingSnapshot: () => ({ trial: 'yes' }),
    });
    expect(await p.provide()).toEqual({});
  });
});

describe('BillingAttributeProvider — quota', () => {
  it('emits used + limit + percent_used when both numeric', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({
        quota: { api_calls: { used: 1500, limit: 2000 } },
      }),
    });
    expect(await p.provide()).toEqual({
      'bridge:billing.quota.api_calls.used': 1500,
      'bridge:billing.quota.api_calls.limit': 2000,
      'bridge:billing.quota.api_calls.percent_used': 75,
    });
  });

  it('uses Math.floor for percent_used (not round)', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({
        quota: { api_calls: { used: 999, limit: 1000 } },
      }),
    });
    const attrs = await p.provide();
    expect(attrs['bridge:billing.quota.api_calls.percent_used']).toBe(99);
  });

  it('handles 0 / limit cleanly (percent_used = 0)', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({
        quota: { api_calls: { used: 0, limit: 1000 } },
      }),
    });
    const attrs = await p.provide();
    expect(attrs['bridge:billing.quota.api_calls.percent_used']).toBe(0);
  });

  it('omits percent_used when limit is missing (unlimited)', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({
        quota: { api_calls: { used: 1500 } },
      }),
    });
    expect(await p.provide()).toEqual({
      'bridge:billing.quota.api_calls.used': 1500,
    });
  });

  it('omits percent_used when limit is 0 (would divide by zero)', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({
        quota: { api_calls: { used: 1500, limit: 0 } },
      }),
    });
    const attrs = await p.provide();
    expect(attrs['bridge:billing.quota.api_calls.used']).toBe(1500);
    expect(attrs['bridge:billing.quota.api_calls.limit']).toBe(0);
    expect(attrs['bridge:billing.quota.api_calls.percent_used']).toBeUndefined();
  });

  it('emits multiple resources independently', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({
        quota: {
          api_calls: { used: 1500, limit: 2000 },
          storage_gb: { used: 5, limit: 10 },
        },
      }),
    });
    expect(await p.provide()).toEqual({
      'bridge:billing.quota.api_calls.used': 1500,
      'bridge:billing.quota.api_calls.limit': 2000,
      'bridge:billing.quota.api_calls.percent_used': 75,
      'bridge:billing.quota.storage_gb.used': 5,
      'bridge:billing.quota.storage_gb.limit': 10,
      'bridge:billing.quota.storage_gb.percent_used': 50,
    });
  });

  it('skips non-object quota values', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () =>
        ({
          // @ts-expect-error — intentional bad shape
          quota: { weird: null, also_weird: 7 },
        }) as BillingSnapshot,
    });
    expect(await p.provide()).toEqual({});
  });
});

describe('BillingAttributeProvider — limit (plan caps)', () => {
  it('emits numeric limits under bridge:billing.limit.<name>', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ limit: { seats: 10, projects: 5 } }),
    });
    expect(await p.provide()).toEqual({
      'bridge:billing.limit.seats': 10,
      'bridge:billing.limit.projects': 5,
    });
  });

  it('emits string limits', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ limit: { region: 'eu-west-1' } }),
    });
    expect(await p.provide()).toEqual({
      'bridge:billing.limit.region': 'eu-west-1',
    });
  });

  it('skips limit values that are neither number nor string', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () =>
        ({
          // @ts-expect-error — intentional bad shape
          limit: { seats: 10, weird: { nested: true } },
        }) as BillingSnapshot,
    });
    expect(await p.provide()).toEqual({ 'bridge:billing.limit.seats': 10 });
  });
});

describe('BillingAttributeProvider — full snapshot', () => {
  it('flattens plan + trial + quota + limit into the namespaced flat map', async () => {
    const snapshot: BillingSnapshot = {
      plan: 'PRO',
      trial: false,
      quota: {
        api_calls: { used: 800, limit: 1000 },
        seats_used: { used: 7 },
      },
      limit: { seats: 10, max_projects: 25 },
    };
    const p = new BillingAttributeProvider({ getBillingSnapshot: () => snapshot });
    expect(await p.provide()).toEqual({
      'bridge:billing.plan': 'PRO',
      'bridge:billing.trial': false,
      'bridge:billing.quota.api_calls.used': 800,
      'bridge:billing.quota.api_calls.limit': 1000,
      'bridge:billing.quota.api_calls.percent_used': 80,
      'bridge:billing.quota.seats_used.used': 7,
      'bridge:billing.limit.seats': 10,
      'bridge:billing.limit.max_projects': 25,
    });
  });
});

describe('BillingAttributeProvider — async snapshots', () => {
  it('awaits async getBillingSnapshot and flattens the result', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: async () => ({ plan: 'PRO', trial: true }),
    });
    const result = p.provide();
    // Async path returns a Promise
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({
      'bridge:billing.plan': 'PRO',
      'bridge:billing.trial': true,
    });
  });

  it('returns synchronously when the getter is synchronous', () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => ({ plan: 'FREE' }),
    });
    const result = p.provide();
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ 'bridge:billing.plan': 'FREE' });
  });
});

describe('BillingAttributeProvider — fail-safe behavior', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns {} when sync getBillingSnapshot throws', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => {
        throw new Error('billing service offline');
      },
    });
    expect(await p.provide()).toEqual({});
  });

  it('returns {} when async getBillingSnapshot rejects', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: async () => {
        throw new Error('billing service offline');
      },
    });
    expect(await p.provide()).toEqual({});
  });

  it('warns at most once across repeated failures', async () => {
    const p = new BillingAttributeProvider({
      getBillingSnapshot: () => {
        throw new Error('boom');
      },
    });
    await p.provide();
    await p.provide();
    await p.provide();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not break registry.collect() when the provider throws', async () => {
    const reg = new AttributeProviderRegistry();
    reg.register(
      new BillingAttributeProvider({
        getBillingSnapshot: () => {
          throw new Error('boom');
        },
      }),
    );
    reg.register({
      name: 'sibling',
      provide: () => ({ country: 'DE' }),
    });
    expect(await reg.collect()).toEqual({ country: 'DE' });
  });
});

describe('BillingAttributeProvider — registry integration', () => {
  it('registers + collect produces the flat namespaced map', async () => {
    const reg = new AttributeProviderRegistry();
    reg.register(
      new BillingAttributeProvider({
        getBillingSnapshot: () => ({
          plan: 'PRO',
          quota: { api_calls: { used: 500, limit: 1000 } },
        }),
      }),
    );
    expect(await reg.collect()).toEqual({
      'bridge:billing.plan': 'PRO',
      'bridge:billing.quota.api_calls.used': 500,
      'bridge:billing.quota.api_calls.limit': 1000,
      'bridge:billing.quota.api_calls.percent_used': 50,
    });
  });

  it('applies billing attributes to BridgeFlags context', async () => {
    const bridge = new BridgeFlags();
    const reg = new AttributeProviderRegistry();
    reg.register(
      new BillingAttributeProvider({
        getBillingSnapshot: () => ({ plan: 'TEAM', trial: true }),
      }),
    );
    await reg.applyTo(bridge);
    const attrs = bridge.getContext().attributes;
    expect(attrs['bridge:billing.plan']).toBe('TEAM');
    expect(attrs['bridge:billing.trial']).toBe(true);
  });

  it('dev-supplied attributes win on collision (locked decision #20)', async () => {
    const bridge = new BridgeFlags();
    // Dev manually overrides the billing plan in their own context
    bridge.setContext({
      attributes: { 'bridge:billing.plan': 'OVERRIDE' },
    });
    const reg = new AttributeProviderRegistry();
    reg.register(
      new BillingAttributeProvider({
        getBillingSnapshot: () => ({ plan: 'PRO' }),
      }),
    );
    await reg.applyTo(bridge);
    expect(bridge.getContext().attributes['bridge:billing.plan']).toBe('OVERRIDE');
  });

  it('non-overlapping dev attributes coexist with billing attributes', async () => {
    const bridge = new BridgeFlags();
    bridge.setContext({
      attributes: { country: 'DE', 'bridge:billing.plan': 'OVERRIDE' },
    });
    const reg = new AttributeProviderRegistry();
    reg.register(
      new BillingAttributeProvider({
        getBillingSnapshot: () => ({
          plan: 'PRO',
          quota: { api_calls: { used: 100, limit: 200 } },
        }),
      }),
    );
    await reg.applyTo(bridge);
    const attrs = bridge.getContext().attributes;
    // Dev wins on plan
    expect(attrs['bridge:billing.plan']).toBe('OVERRIDE');
    // Dev's custom attribute preserved
    expect(attrs.country).toBe('DE');
    // Provider-only attributes flow through
    expect(attrs['bridge:billing.quota.api_calls.used']).toBe(100);
    expect(attrs['bridge:billing.quota.api_calls.percent_used']).toBe(50);
  });
});
