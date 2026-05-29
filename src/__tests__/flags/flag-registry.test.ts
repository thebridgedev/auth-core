// TBP-299 / Phase 1 — AttributeProviderRegistry wired into BridgeFlags.flag().
// Verifies the new eval-time merge path (TBP-293, TBP-294, TBP-295) and the
// locked collision rule (#20): dev-supplied attrs > setContext globals >
// provider attrs.

import { describe, expect, it } from 'vitest';
import { BridgeFlags, type CachedFlag } from '../../flags/flag.js';
import {
  AuthAttributeProvider,
  type AttributeProvider,
} from '../../flags/attribute-providers.js';

const ruleFlag = (
  attribute: string,
  values: unknown[],
  onValue: unknown,
  offValue: unknown,
): CachedFlag => ({
  key: 'test_flag',
  state: 'on-with-rule',
  valueType: typeof onValue === 'boolean' ? 'boolean' : 'string',
  offValue,
  onValue,
  rule: {
    branches: [
      {
        conditions: [{ attribute, operator: 'in', values: values as any }],
        returnValue: onValue as any,
      },
    ],
    otherwiseValue: offValue as any,
    rolloutPct: 100,
  },
});

const provider = (
  name: string,
  attrs: Record<string, unknown> | (() => Record<string, unknown>),
): AttributeProvider => ({
  name,
  namespace: 'custom',
  provide: () => (typeof attrs === 'function' ? attrs() : attrs),
});

describe('BridgeFlags — registerAttributeProvider', () => {
  it('exposes the registry via getAttributeProviderRegistry', () => {
    const b = new BridgeFlags();
    expect(b.getAttributeProviderRegistry().size()).toBe(0);
    b.registerAttributeProvider(provider('p1', { foo: 1 }));
    expect(b.getAttributeProviderRegistry().size()).toBe(1);
    expect(b.getAttributeProviderRegistry().names()).toEqual(['p1']);
  });

  it('is idempotent on name — re-registering replaces the previous instance', () => {
    const b = new BridgeFlags();
    b.registerAttributeProvider(provider('same', { a: 1 }));
    b.registerAttributeProvider(provider('same', { a: 2 }));
    expect(b.getAttributeProviderRegistry().size()).toBe(1);
  });

  it('unregister removes by name', () => {
    const b = new BridgeFlags();
    b.registerAttributeProvider(provider('p1', { a: 1 }));
    b.registerAttributeProvider(provider('p2', { b: 2 }));
    b.unregisterAttributeProvider('p1');
    expect(b.getAttributeProviderRegistry().names()).toEqual(['p2']);
  });
});

describe('BridgeFlags.flag() — provider attribute merge', () => {
  it('merges provider attrs into the eval context on every call', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    b.registerAttributeProvider(provider('geo', { country: 'DE' }));
    expect(b.flag('test_flag', 'us-pricing').value).toBe('eu-pricing');
  });

  it('does NOT merge providers when none are registered (zero overhead)', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    b.setContext({ identity: 'u-1', attributes: { country: 'DE' } });
    expect(b.flag('test_flag', 'us-pricing').value).toBe('eu-pricing');
  });

  it('re-evaluates with fresh provider output each call (live state)', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    let current = 'GB';
    b.registerAttributeProvider(provider('geo', () => ({ country: current })));
    expect(b.flag('test_flag', 'us-pricing').value).toBe('us-pricing');
    current = 'DE';
    expect(b.flag('test_flag', 'us-pricing').value).toBe('eu-pricing');
  });

  it('setContext globals override provider attrs on collision', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    b.registerAttributeProvider(provider('geo', { country: 'GB' }));
    b.setContext({ identity: 'u-1', attributes: { country: 'DE' } });
    expect(b.flag('test_flag', 'us-pricing').value).toBe('eu-pricing');
  });

  it('per-call context.attributes overrides both providers AND globals', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    b.registerAttributeProvider(provider('geo', { country: 'GB' }));
    b.setContext({ identity: 'u-1', attributes: { country: 'GB' } });
    expect(
      b.flag('test_flag', 'us-pricing', { attributes: { country: 'DE' } }).value,
    ).toBe('eu-pricing');
  });

  it('a throwing provider does not break eval — other providers still apply', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    const noisy: AttributeProvider = {
      name: 'broken',
      provide: () => {
        throw new Error('boom');
      },
    };
    b.registerAttributeProvider(noisy);
    b.registerAttributeProvider(provider('geo', { country: 'DE' }));
    expect(b.flag('test_flag', 'us-pricing').value).toBe('eu-pricing');
  });

  it('an async provider is SKIPPED on the sync hot path (no eval breakage)', () => {
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('country', ['DE'], 'eu-pricing', 'us-pricing')]);
    const asyncP: AttributeProvider = {
      name: 'lazy',
      provide: () => Promise.resolve({ country: 'DE' }),
    };
    b.registerAttributeProvider(asyncP);
    // No sync attrs reached the eval context → rule fails → off value.
    expect(b.flag('test_flag', 'us-pricing').value).toBe('us-pricing');
  });
});

describe('AuthAttributeProvider', () => {
  it('returns empty when no claims', () => {
    const p = new AuthAttributeProvider({ getClaims: () => undefined });
    expect(p.provide()).toEqual({});
  });

  it('flattens the JWT claims into the canonical attribute keys', () => {
    const p = new AuthAttributeProvider({
      getClaims: () => ({
        sub: 'u-1',
        role: 'OWNER',
        email: 'a@b.com',
        tid: 'tenant-1',
        plan: 'PRO',
        privileges: ['BILLING_READ'],
      }),
    });
    expect(p.provide()).toEqual({
      'user.id': 'u-1',
      'user.role': 'OWNER',
      'user.email': 'a@b.com',
      'tenant.id': 'tenant-1',
      'tenant.plan': 'PRO',
      privileges: ['BILLING_READ'],
    });
  });

  it('accepts a string-form privileges claim too', () => {
    const p = new AuthAttributeProvider({
      getClaims: () => ({ privileges: 'A,B' }),
    });
    expect(p.provide()).toEqual({ privileges: 'A,B' });
  });

  it('omits keys when claim is missing or wrong-typed', () => {
    const p = new AuthAttributeProvider({
      getClaims: () => ({ sub: 'u-1', role: 42 as unknown as string }),
    });
    expect(p.provide()).toEqual({ 'user.id': 'u-1' });
  });

  it('degrades silently when getClaims throws', () => {
    const p = new AuthAttributeProvider({
      getClaims: () => {
        throw new Error('boom');
      },
    });
    expect(p.provide()).toEqual({});
  });

  it('integrates into BridgeFlags — role rule flips with claims', () => {
    let claims: any = { sub: 'u-1', role: 'OWNER' };
    const b = new BridgeFlags();
    b.hydrate([ruleFlag('user.role', ['OWNER'], 'admin-ui', 'user-ui')]);
    b.registerAttributeProvider(
      new AuthAttributeProvider({ getClaims: () => claims }),
    );
    expect(b.flag('test_flag', 'user-ui').value).toBe('admin-ui');
    claims = { sub: 'u-1', role: 'MEMBER' };
    expect(b.flag('test_flag', 'user-ui').value).toBe('user-ui');
    claims = undefined;
    expect(b.flag('test_flag', 'user-ui').value).toBe('user-ui');
  });
});
