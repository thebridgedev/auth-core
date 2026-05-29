import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeFlags } from '../../flags/flag.js';
import { TelemetryBatcher } from '../../flags/telemetry.js';

const captureFetch = () => {
  const calls: Array<{ url: string; init: any }> = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 202 });
  });
  (global as any).fetch = spy;
  return { spy, calls };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (global as any).fetch;
});

describe('BridgeFlags.declareAttributes (TBP-174)', () => {
  it('stores the declaration', () => {
    const b = new BridgeFlags();
    b.declareAttributes({ app_version: 'semver', is_internal: 'boolean' });
    expect(b.getAttributeDeclarations()).toEqual({
      app_version: 'semver',
      is_internal: 'boolean',
    });
  });

  it('fires onAttributeDeclaration hook for each new declaration', () => {
    const b = new BridgeFlags();
    const onAttributeDeclaration = vi.fn();
    b.setHooks({ onAttributeDeclaration });
    b.declareAttributes({ country: 'string', age: 'number' });
    expect(onAttributeDeclaration).toHaveBeenCalledTimes(2);
    expect(onAttributeDeclaration.mock.calls.map((c) => c[0].name).sort()).toEqual(['age', 'country']);
  });

  it('no-op when re-declaring the same key with the same type', () => {
    const b = new BridgeFlags();
    const onAttributeDeclaration = vi.fn();
    b.setHooks({ onAttributeDeclaration });
    b.declareAttributes({ country: 'string' });
    b.declareAttributes({ country: 'string' });
    expect(onAttributeDeclaration).toHaveBeenCalledTimes(1);
  });

  it('re-fires when the same key is re-declared with a different type', () => {
    const b = new BridgeFlags();
    const onAttributeDeclaration = vi.fn();
    b.setHooks({ onAttributeDeclaration });
    b.declareAttributes({ country: 'string' });
    b.declareAttributes({ country: 'json' });
    expect(onAttributeDeclaration).toHaveBeenCalledTimes(2);
    expect(b.getAttributeDeclarations().country).toBe('json');
  });

  it('hook errors do not break declareAttributes', () => {
    const b = new BridgeFlags();
    b.setHooks({
      onAttributeDeclaration: () => {
        throw new Error('boom');
      },
    });
    expect(() => b.declareAttributes({ a: 'string' })).not.toThrow();
    expect(b.getAttributeDeclarations()).toEqual({ a: 'string' });
  });

  it('ignores empty-string keys', () => {
    const b = new BridgeFlags();
    b.declareAttributes({ '': 'string', valid: 'number' });
    expect(b.getAttributeDeclarations()).toEqual({ valid: 'number' });
  });
});

describe('TelemetryBatcher — attribute declarations (TBP-174)', () => {
  const CONFIG = {
    apiBaseUrl: 'https://api.test.local',
    apiKey: 'test-key',
    flushIntervalMs: 1000,
  };

  it('records declarations + flushes them to /v1/flags/discover with kind: attribute', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    b.attach(bridge);
    bridge.declareAttributes({ app_version: 'semver', is_admin: 'boolean' });
    expect(b.stats().attributeDeclQueue).toBe(2);
    await b.flush();
    const discoverCall = calls.find((c) => c.url.endsWith('/v1/flags/discover'));
    expect(discoverCall).toBeDefined();
    const body = JSON.parse(discoverCall!.init.body);
    const kinds = body.events.map((e: any) => e.kind);
    expect(kinds.every((k: string) => k === 'attribute')).toBe(true);
    const types = body.events.reduce((acc: any, e: any) => ({ ...acc, [e.key]: e.observedType }), {});
    expect(types).toEqual({ app_version: 'semver', is_admin: 'boolean' });
  });

  it('size-based flush triggers when attribute queue grows past threshold', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher({ ...CONFIG, flushAtSize: 3 });
    const bridge = new BridgeFlags();
    b.attach(bridge);
    bridge.declareAttributes({ a: 'string', b: 'number', c: 'boolean', d: 'date' });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
