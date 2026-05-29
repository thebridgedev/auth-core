import { describe, expect, it, vi } from 'vitest';
import { BridgeFlags } from '../../flags/flag.js';
import {
  BridgeIdentity,
  MemoryIdentityStorage,
  attachIdentity,
  generateAnonymousId,
} from '../../flags/identity.js';

describe('generateAnonymousId', () => {
  it('produces unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateAnonymousId());
    expect(ids.size).toBe(100);
  });

  it('prefixes with anon_', () => {
    expect(generateAnonymousId()).toMatch(/^anon_/);
  });
});

describe('MemoryIdentityStorage', () => {
  it('default mode is "none"', () => {
    expect(new MemoryIdentityStorage().mode).toBe('none');
  });

  it('write+read round-trips', () => {
    const s = new MemoryIdentityStorage('persistent');
    expect(s.read()).toBeUndefined();
    s.write('anon_xyz');
    expect(s.read()).toBe('anon_xyz');
  });

  it('clear drops the stored ID', () => {
    const s = new MemoryIdentityStorage();
    s.write('anon_xyz');
    s.clear();
    expect(s.read()).toBeUndefined();
  });
});

describe('BridgeIdentity — anonymous flow (TBP-168)', () => {
  it('ensureAnonymousId generates + persists on first call', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    const identity = new BridgeIdentity(bridge, storage);

    expect(storage.read()).toBeUndefined();
    const id = identity.ensureAnonymousId();
    expect(id).toMatch(/^anon_/);
    expect(storage.read()).toBe(id);
  });

  it('ensureAnonymousId returns existing ID on subsequent calls', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    storage.write('anon_preexisting');
    const identity = new BridgeIdentity(bridge, storage);

    expect(identity.ensureAnonymousId()).toBe('anon_preexisting');
  });

  it('hydrateAnonymous populates the BridgeFlags context.identity', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    const identity = new BridgeIdentity(bridge, storage);

    const id = identity.hydrateAnonymous();
    expect(bridge.getContext().identity).toBe(id);
  });

  it('attachIdentity factory auto-hydrates the context', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    attachIdentity(bridge, storage);
    expect(bridge.getContext().identity).toMatch(/^anon_/);
  });
});

describe('BridgeIdentity — identify (TBP-169)', () => {
  it('identify replaces context.identity with the userId', () => {
    const bridge = new BridgeFlags();
    const identity = new BridgeIdentity(bridge, new MemoryIdentityStorage());
    identity.hydrateAnonymous();
    identity.identify('user-42');
    expect(bridge.getContext().identity).toBe('user-42');
  });

  it('identify fires the onIdentify hook with anonymousId + userId', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    const identity = new BridgeIdentity(bridge, storage);
    identity.hydrateAnonymous();
    const anonId = storage.read();

    const onIdentify = vi.fn();
    identity.setOnIdentify(onIdentify);
    identity.identify('user-42');

    expect(onIdentify).toHaveBeenCalledTimes(1);
    expect(onIdentify.mock.calls[0][0]).toEqual({ anonymousId: anonId, userId: 'user-42' });
  });

  it('hook errors do not break identify', () => {
    const bridge = new BridgeFlags();
    const identity = new BridgeIdentity(bridge, new MemoryIdentityStorage());
    identity.setOnIdentify(() => {
      throw new Error('boom');
    });
    expect(() => identity.identify('user-42')).not.toThrow();
    expect(bridge.getContext().identity).toBe('user-42');
  });

  it('identify rejects empty userId', () => {
    const bridge = new BridgeFlags();
    const identity = new BridgeIdentity(bridge, new MemoryIdentityStorage());
    expect(() => identity.identify('')).toThrow(/userId/);
  });

  it('isKnown is false before identify, true after', () => {
    const bridge = new BridgeFlags();
    const identity = new BridgeIdentity(bridge, new MemoryIdentityStorage());
    expect(identity.isKnown()).toBe(false);
    identity.identify('u-1');
    expect(identity.isKnown()).toBe(true);
  });

  it('current returns userId when known, anonymous ID otherwise', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    const identity = new BridgeIdentity(bridge, storage);
    identity.hydrateAnonymous();
    const anonId = identity.current();
    expect(anonId).toMatch(/^anon_/);
    identity.identify('u-1');
    expect(identity.current()).toBe('u-1');
  });
});

describe('BridgeIdentity — logout', () => {
  it('logout reverts to anonymous and re-uses the persisted anon ID', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    const identity = new BridgeIdentity(bridge, storage);
    identity.hydrateAnonymous();
    const anonId = storage.read();
    identity.identify('user-42');
    identity.logout();
    expect(identity.isKnown()).toBe(false);
    expect(bridge.getContext().identity).toBe(anonId);
  });

  it('logout({ dropAnonymous: true }) generates a fresh anon ID', () => {
    const bridge = new BridgeFlags();
    const storage = new MemoryIdentityStorage();
    const identity = new BridgeIdentity(bridge, storage);
    identity.hydrateAnonymous();
    const firstAnon = storage.read();
    identity.identify('user-42');
    identity.logout({ dropAnonymous: true });
    const newAnon = storage.read();
    expect(newAnon).not.toBe(firstAnon);
    expect(newAnon).toMatch(/^anon_/);
  });
});
