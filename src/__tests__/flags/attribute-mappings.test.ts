// TBP-757 — the claim and billing mappings are pure functions shared by the
// browser providers and the server SDKs, so one rule means the same thing on
// both sides. These pin the key names (TBP-748) and prove the providers go
// through the shared functions rather than a copy of them.

import { describe, expect, it } from 'vitest';
import {
  AuthAttributeProvider,
  BillingAttributeProvider,
  claimsToAttributes,
  flattenBillingSnapshot,
} from '../../flags/attribute-providers.js';
import * as rootExports from '../../index.js';
import * as flagExports from '../../flags/index.js';

describe('claimsToAttributes (TBP-757)', () => {
  it('maps the verified claims onto the unprefixed auth attribute names', () => {
    expect(
      claimsToAttributes({
        sub: 'u1',
        role: 'ADMIN',
        email: 'a@b.c',
        tid: 't1',
        plan: 'pro',
        privileges: ['USER_READ', 'BETA'],
      }),
    ).toEqual({
      'user.id': 'u1',
      'user.role': 'ADMIN',
      'user.email': 'a@b.c',
      'tenant.id': 't1',
      'tenant.plan': 'pro',
      privileges: ['USER_READ', 'BETA'],
    });
  });

  it('emits nothing for missing, empty or mistyped claims', () => {
    expect(claimsToAttributes(undefined)).toEqual({});
    expect(claimsToAttributes(null)).toEqual({});
    expect(claimsToAttributes({ sub: '', role: 3, tid: {}, privileges: 5 } as never)).toEqual({});
  });

  it('keeps a comma-joined privileges string as-is', () => {
    expect(claimsToAttributes({ privileges: 'A,B' })).toEqual({ privileges: 'A,B' });
  });

  it('is what AuthAttributeProvider returns for the same claims', () => {
    const claims = { sub: 'u1', role: 'MEMBER', tid: 't1', plan: 'free', privileges: ['X'] };
    const provided = new AuthAttributeProvider({ getClaims: () => claims }).provide();
    expect(provided).toEqual(claimsToAttributes(claims));
    expect(Object.keys(provided).length).toBeGreaterThan(0);
  });
});

describe('flattenBillingSnapshot (TBP-757)', () => {
  const input = {
    subscription: { plan: { slug: 'pro' }, status: 'trial' },
    entitlements: { export: true, sso: false, junk: 'yes' },
    quotas: { seats: { used: 3, limit: 10, remaining: 7, percent_used: 0.3 } },
  };

  it('flattens subscription, entitlements and quotas under bridge:billing.*', () => {
    expect(flattenBillingSnapshot(input)).toEqual({
      'bridge:billing.plan': 'pro',
      'bridge:billing.subscription.status': 'trial',
      'bridge:billing.trial': true,
      'bridge:billing.entitlement.export': true,
      'bridge:billing.entitlement.sso': false,
      'bridge:billing.quota.seats.used': 3,
      'bridge:billing.quota.seats.limit': 10,
      'bridge:billing.quota.seats.remaining': 7,
      'bridge:billing.quota.seats.percent_used': 0.3,
    });
  });

  it('accepts a Map of quotas (QuotaStore.getAll()) the same as an object', () => {
    expect(flattenBillingSnapshot({ quotas: new Map(Object.entries(input.quotas)) })).toEqual(
      flattenBillingSnapshot({ quotas: input.quotas }),
    );
  });

  it('returns nothing for an empty or missing snapshot', () => {
    expect(flattenBillingSnapshot(undefined)).toEqual({});
    expect(flattenBillingSnapshot({})).toEqual({});
    expect(flattenBillingSnapshot({ subscription: null, entitlements: null, quotas: null })).toEqual({});
  });

  it('is what BillingAttributeProvider returns for the same store state', () => {
    const provider = new BillingAttributeProvider();
    provider.bindStores({
      subscription: { snapshot: () => ({ state: input.subscription }) } as never,
      quotas: { getAll: () => new Map(Object.entries(input.quotas)) } as never,
      entitlements: { isHydrated: () => true, all: () => input.entitlements } as never,
    });
    const provided = provider.provide();
    expect(provided).toEqual(flattenBillingSnapshot(input));
    expect(Object.keys(provided as object).length).toBeGreaterThan(0);
  });
});

describe('exports (TBP-757)', () => {
  it('ships both mappings from the package root and the flags barrel', () => {
    expect(rootExports.claimsToAttributes).toBe(claimsToAttributes);
    expect(rootExports.flattenBillingSnapshot).toBe(flattenBillingSnapshot);
    expect(flagExports.claimsToAttributes).toBe(claimsToAttributes);
    expect(flagExports.flattenBillingSnapshot).toBe(flattenBillingSnapshot);
  });
});
