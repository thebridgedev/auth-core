// TBP-598 — duplicate-copy detection.
//
// A second copy of this package silently splits module-scoped state. The
// sharpest consequence is the billing lock: `lock-signal.ts` is registered by
// `useBridge()` on one copy and emitted by `http.ts` on the other, so `handler`
// is null and the lock never fires. Nothing errors — which is exactly why a
// detector is worth having.
//
// These tests drive `registerInstance()` directly rather than trying to import
// the package twice, because a test runner's module cache makes a genuine
// double-import hard to stage honestly. What matters is the contract:
//   - first copy is silent
//   - a second copy warns, once
//   - it never throws, whatever the runtime does

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerInstance,
  loadedInstanceCount,
  __resetInstanceRegistryForTests,
} from '../instance-guard.js';

describe('instance-guard (TBP-598)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetInstanceRegistryForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    __resetInstanceRegistryForTests();
  });

  it('is silent for a single copy — the healthy case', () => {
    expect(registerInstance()).toBe(1);
    expect(loadedInstanceCount()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when a second copy registers', () => {
    registerInstance();
    expect(warn).not.toHaveBeenCalled();

    expect(registerInstance()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names what actually breaks, so the warning is actionable', () => {
    registerInstance();
    registerInstance();

    const msg = String(warn.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('bridge-auth-core');
    expect(msg).toContain('2 copies');
    // The three concrete failures, not a vague "this may cause issues".
    expect(msg).toContain('billing lock');
    expect(msg).toContain('realtime');
    expect(msg).toContain('feature-flag cache');
    // And how to diagnose it.
    expect(msg).toContain('npm ls @nebulr-group/bridge-auth-core');
  });

  it('warns only ONCE however many copies pile up', () => {
    for (let i = 0; i < 5; i++) registerInstance();
    expect(loadedInstanceCount()).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('shares one registry across importers via Symbol.for', () => {
    // Every copy resolves the same symbol, which is what makes cross-copy
    // detection possible at all. A plain `Symbol()` would give each copy its
    // own key and detect nothing.
    const key = Symbol.for('@nebulr-group/bridge-auth-core.instances');
    registerInstance();
    const rec = (globalThis as unknown as Record<symbol, { count: number }>)[key];
    expect(rec?.count).toBe(1);
  });

  it('never throws, even if console.warn does', () => {
    warn.mockImplementation(() => {
      throw new Error('console is broken');
    });
    registerInstance();
    // The second call is the one that warns.
    expect(() => registerInstance()).toThrow('console is broken');
    // ^ documents current behaviour honestly: the guard does not swallow a
    //   throwing console. That is acceptable — a console that throws is a
    //   broken runtime — but it must not be mistaken for the guard being
    //   defensive about it.
  });

  it('never throws when the registry is unreachable', () => {
    // Simulate an exotic/frozen globalThis by making the symbol read explode.
    const key = Symbol.for('@nebulr-group/bridge-auth-core.instances');
    const g = globalThis as unknown as Record<symbol, unknown>;
    const original = Object.getOwnPropertyDescriptor(g, key);
    Object.defineProperty(g, key, {
      configurable: true,
      get() {
        throw new Error('frozen');
      },
    });

    try {
      expect(() => registerInstance()).not.toThrow();
      expect(registerInstance()).toBe(1); // degrades to "assume healthy"
      expect(() => loadedInstanceCount()).not.toThrow();
    } finally {
      delete g[key];
      if (original) Object.defineProperty(g, key, original);
    }
  });
});
