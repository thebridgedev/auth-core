import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_CONTEXT_HEADER,
  deserializeContext,
  serializeContext,
  serverInstanceId,
  __resetServerInstanceId,
} from '../../flags/propagation.js';
import { BridgeFlags } from '../../flags/flag.js';

afterEach(() => {
  __resetServerInstanceId();
});

describe('BRIDGE_CONTEXT_HEADER', () => {
  it('is the canonical header name', () => {
    expect(BRIDGE_CONTEXT_HEADER).toBe('x-bridge-context');
  });
});

describe('serializeContext / deserializeContext (TBP-171)', () => {
  it('round-trips identity + attributes', () => {
    const ctx = { identity: 'u-1', attributes: { country: 'DE', plan: 'pro' } };
    const wire = serializeContext(ctx);
    const back = deserializeContext(wire);
    expect(back).toEqual(ctx);
  });

  it('omits identity when not set', () => {
    const ctx = { attributes: { country: 'DE' } };
    const back = deserializeContext(serializeContext(ctx));
    expect(back?.identity).toBeUndefined();
    expect(back?.attributes).toEqual({ country: 'DE' });
  });

  it('omits empty attributes from the wire (keep it small)', () => {
    const wire = serializeContext({ identity: 'u-1', attributes: {} });
    const json = JSON.parse(base64UrlDecode(wire));
    expect(json).toEqual({ v: 1, i: 'u-1' });
    // round-trip still returns an empty attributes object
    const back = deserializeContext(wire);
    expect(back?.attributes).toEqual({});
  });

  it('handles non-ASCII attributes (UTF-8 safe)', () => {
    const ctx = { identity: 'u-1', attributes: { city: 'São Paulo', emoji: '🚀' } };
    const back = deserializeContext(serializeContext(ctx));
    expect(back).toEqual(ctx);
  });

  it('returns undefined for missing / empty / non-string input', () => {
    expect(deserializeContext(undefined)).toBeUndefined();
    expect(deserializeContext(null)).toBeUndefined();
    expect(deserializeContext('')).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    expect(deserializeContext('not-base64!!')).toBeUndefined();
    // valid base64 of "not json"
    expect(deserializeContext(toBase64Url('not json'))).toBeUndefined();
  });

  it('returns undefined for an unsupported wire version', () => {
    const wire = toBase64Url(JSON.stringify({ v: 999, i: 'u-1' }));
    expect(deserializeContext(wire)).toBeUndefined();
  });

  it('uses base64url (no =, no +, no /)', () => {
    const wire = serializeContext({
      identity: 'u-1',
      attributes: { large: 'x'.repeat(200) },
    });
    expect(wire).not.toContain('=');
    expect(wire).not.toContain('+');
    expect(wire).not.toContain('/');
  });
});

describe('serverInstanceId (TBP-172)', () => {
  it('is stable across multiple calls', () => {
    const a = serverInstanceId();
    const b = serverInstanceId();
    expect(a).toBe(b);
  });

  it('has the srv_ prefix', () => {
    expect(serverInstanceId()).toMatch(/^srv_/);
  });

  it('differs across resets (process-scoped, refreshable in tests)', () => {
    const first = serverInstanceId();
    __resetServerInstanceId();
    const second = serverInstanceId();
    expect(first).not.toBe(second);
  });
});

describe('BridgeFlags backend mode + serverInstanceId integration', () => {
  it('mode defaults to frontend', () => {
    expect(new BridgeFlags().getMode()).toBe('frontend');
  });

  it('mode can be set to backend via constructor', () => {
    expect(new BridgeFlags({ mode: 'backend' }).getMode()).toBe('backend');
  });

  it('backend mode + on-with-rule + no identity → returns default + warns once', () => {
    const b = new BridgeFlags({ mode: 'backend' });
    b.upsert({
      key: 'system_flag',
      state: 'on-with-rule',
      valueType: 'boolean',
      offValue: false,
      onValue: true,
      rule: {
        branches: [{ conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }], returnValue: true }],
        otherwiseValue: false,
        rolloutPct: 100,
      },
    });
    const warn = (globalThis as any).console?.warn;
    (globalThis as any).console = { warn: () => undefined };
    const result = b.flag('system_flag', 'safe-default' as any);
    (globalThis as any).console = { warn };
    expect(result.value).toBe('safe-default');
  });

  it('backend mode allows on / off evals without identity (no rule)', () => {
    const b = new BridgeFlags({ mode: 'backend' });
    b.upsert({
      key: 'sys',
      state: 'on',
      valueType: 'boolean',
      offValue: false,
      onValue: true,
    });
    expect(b.flag('sys', false).value).toBe(true);
  });

  it('backend mode + per-call identity → evaluates the rule', () => {
    const b = new BridgeFlags({ mode: 'backend' });
    b.upsert({
      key: 'sys',
      state: 'on-with-rule',
      valueType: 'string',
      offValue: 'off',
      onValue: 'on',
      rule: {
        branches: [{ conditions: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }], returnValue: 'pro-feature' }],
        otherwiseValue: 'free-feature',
        rolloutPct: 100,
      },
    });
    expect(
      b.flag('sys', 'default', { identity: 'system-actor', attributes: { plan: 'pro' } }).value,
    ).toBe('pro-feature');
  });

  it('setServerInstanceId / getServerInstanceId round-trip', () => {
    const b = new BridgeFlags();
    expect(b.getServerInstanceId()).toBeUndefined();
    b.setServerInstanceId('srv_abc123');
    expect(b.getServerInstanceId()).toBe('srv_abc123');
  });

  it('setServerInstanceId rejects empty / non-string', () => {
    const b = new BridgeFlags();
    b.setServerInstanceId('');
    expect(b.getServerInstanceId()).toBeUndefined();
  });
});

// Helpers local to this test file (mirror propagation.ts base64url)
function toBase64Url(input: string): string {
  let b64: string;
  const g: any = globalThis as any;
  if (typeof g.btoa === 'function') {
    b64 = g.btoa(unescape(encodeURIComponent(input)));
  } else {
    b64 = Buffer.from(input, 'utf-8').toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const g: any = globalThis as any;
  if (typeof g.atob === 'function') return decodeURIComponent(escape(g.atob(padded)));
  return Buffer.from(padded, 'base64').toString('utf-8');
}
