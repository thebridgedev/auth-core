import { describe, expect, it } from 'vitest';
import { BridgeFlags } from '../../flags/flag.js';
import {
  AttributeProviderRegistry,
  AuthAttributeProvider,
  BillingAttributeProvider,
  type AttributeProvider,
} from '../../flags/attribute-providers.js';

const mkProvider = (
  name: string,
  attrs: Record<string, unknown>,
  namespace: 'bridge' | 'custom' = 'custom',
): AttributeProvider => ({
  name,
  namespace,
  provide: () => attrs,
});

describe('AttributeProviderRegistry — basics', () => {
  it('starts empty', () => {
    const r = new AttributeProviderRegistry();
    expect(r.size()).toBe(0);
    expect(r.names()).toEqual([]);
  });

  it('register adds a provider', () => {
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('a', { x: 1 }));
    expect(r.size()).toBe(1);
    expect(r.names()).toEqual(['a']);
  });

  it('register is idempotent on name (replaces)', () => {
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('a', { x: 1 }));
    r.register(mkProvider('a', { x: 2 }));
    expect(r.size()).toBe(1);
  });

  it('unregister removes by name', () => {
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('a', {}));
    r.register(mkProvider('b', {}));
    r.unregister('a');
    expect(r.names()).toEqual(['b']);
  });

  it('rejects providers without a name', () => {
    const r = new AttributeProviderRegistry();
    expect(() => r.register({ name: '', provide: () => ({}) })).toThrow();
  });
});

describe('AttributeProviderRegistry — collect', () => {
  it('merges attributes from every provider', async () => {
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('a', { country: 'DE' }));
    r.register(mkProvider('b', { plan: 'pro' }));
    expect(await r.collect()).toEqual({ country: 'DE', plan: 'pro' });
  });

  it('later providers win on key collision (internal merge order)', async () => {
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('first', { plan: 'free' }));
    r.register(mkProvider('second', { plan: 'pro' }));
    expect(await r.collect()).toEqual({ plan: 'pro' });
  });

  it('isolates provider failures', async () => {
    const r = new AttributeProviderRegistry();
    r.register({
      name: 'broken',
      provide: () => {
        throw new Error('boom');
      },
    });
    r.register(mkProvider('working', { country: 'DE' }));
    expect(await r.collect()).toEqual({ country: 'DE' });
  });

  it('handles async providers', async () => {
    const r = new AttributeProviderRegistry();
    r.register({
      name: 'async',
      provide: async () => ({ async_attr: 'yes' }),
    });
    expect(await r.collect()).toEqual({ async_attr: 'yes' });
  });
});

describe('AttributeProviderRegistry — applyTo (dev wins on collision)', () => {
  it('applies provider attributes to BridgeFlags context', async () => {
    const bridge = new BridgeFlags();
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('auth', { role: 'admin' }, 'bridge'));
    await r.applyTo(bridge);
    expect(bridge.getContext().attributes.role).toBe('admin');
  });

  it('preserves dev-supplied attributes on collision (locked decision #20)', async () => {
    const bridge = new BridgeFlags();
    bridge.setContext({ attributes: { role: 'dev-set' } });
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('auth', { role: 'provider-set' }, 'bridge'));
    await r.applyTo(bridge);
    expect(bridge.getContext().attributes.role).toBe('dev-set');
  });

  it('merges non-overlapping provider + dev attributes', async () => {
    const bridge = new BridgeFlags();
    bridge.setContext({ attributes: { custom_attr: 'dev-only' } });
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('auth', { role: 'admin' }, 'bridge'));
    await r.applyTo(bridge);
    expect(bridge.getContext().attributes).toEqual({
      custom_attr: 'dev-only',
      role: 'admin',
    });
  });

  it('preserves identity across applyTo', async () => {
    const bridge = new BridgeFlags();
    bridge.setContext({ identity: 'u-1', attributes: {} });
    const r = new AttributeProviderRegistry();
    r.register(mkProvider('auth', { role: 'admin' }, 'bridge'));
    await r.applyTo(bridge);
    expect(bridge.getContext().identity).toBe('u-1');
  });
});

describe('Stub providers', () => {
  it('AuthAttributeProvider has correct name + namespace', () => {
    const p = new AuthAttributeProvider();
    expect(p.name).toBe('bridge:auth');
    expect(p.namespace).toBe('bridge');
    expect(p.provide()).toEqual({});
  });

  it('BillingAttributeProvider has correct name + namespace', () => {
    const p = new BillingAttributeProvider();
    expect(p.name).toBe('bridge:billing');
    expect(p.namespace).toBe('bridge');
    expect(p.provide()).toEqual({});
  });

  it('subclasses can override provide', async () => {
    class FakeAuth extends AuthAttributeProvider {
      override provide() {
        return { role: 'owner', plan: 'enterprise' };
      }
    }
    const bridge = new BridgeFlags();
    const r = new AttributeProviderRegistry();
    r.register(new FakeAuth());
    await r.applyTo(bridge);
    expect(bridge.getContext().attributes).toEqual({
      role: 'owner',
      plan: 'enterprise',
    });
  });
});
