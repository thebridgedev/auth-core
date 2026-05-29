// Anonymous identity + `identify` for Bridge Feature Flags (TBP-168, TBP-169).
//
// Frontends usually want a stable anonymous identifier for users who haven't
// logged in, so flag evaluation has *something* to bucket on (especially for
// percentage rollouts). This module:
//
//   1. Defines a pluggable IdentityStorage interface so framework SDKs can
//      back it with localStorage / sessionStorage / cookies / memory.
//   2. Generates a UUID v4 on first init and persists it.
//   3. Provides `identify(userId)` to upgrade the anon → known state.
//
// auth-core itself is platform-agnostic; the framework SDKs (bridge-svelte,
// bridge-react, bridge-nextjs) supply the browser-storage implementations.
// auth-core ships `MemoryIdentityStorage` for tests / SSR.

import type { BridgeFlags } from './flag.js';

/** How aggressively the anon ID is persisted. */
export type AnonymousTrackingMode = 'persistent' | 'session' | 'none';

/**
 * Pluggable storage for the anonymous identity. Framework SDKs implement
 * this against the right platform API.
 */
export interface IdentityStorage {
  /** Persistence flavor — informational only; storage choice itself enforces it. */
  readonly mode: AnonymousTrackingMode;
  /** Read the stored anon ID, or undefined if not set. */
  read(): string | undefined;
  /** Write the anon ID. */
  write(id: string): void;
  /** Drop the anon ID (e.g. on logout). */
  clear(): void;
}

/** In-memory storage. Used for SSR, tests, or when `tracking: 'none'`. */
export class MemoryIdentityStorage implements IdentityStorage {
  readonly mode: AnonymousTrackingMode;
  private value: string | undefined;

  constructor(mode: AnonymousTrackingMode = 'none') {
    this.mode = mode;
  }

  read(): string | undefined {
    return this.value;
  }
  write(id: string): void {
    this.value = id;
  }
  clear(): void {
    this.value = undefined;
  }
}

/** RFC4122-shaped UUID v4. Uses `crypto.randomUUID` when available, falls back to Math.random. */
export function generateAnonymousId(): string {
  // Prefer Web Crypto / Node 20+ crypto.randomUUID
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return `anon_${g.crypto.randomUUID()}`;
  }
  // Fallback: Math.random-based v4 (acceptable for anon IDs — they're not security tokens)
  const hex = (n: number) => Math.floor(Math.random() * (1 << (n * 4))).toString(16).padStart(n, '0');
  return `anon_${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/**
 * Identity manager bundled with a `BridgeFlags` instance. Created via the
 * factory below — framework SDKs call `attachIdentity(bridge, storage)`
 * during bootstrap so anonymous ID auto-populates the eval context.
 */
export class BridgeIdentity {
  /** Fires when the identity transitions from anonymous → known (TBP-169). */
  private onIdentifyHook?: (args: { anonymousId?: string; userId: string }) => void;
  /** True once `identify()` has been called (or a non-anonymous identity was loaded). */
  private knownUserId?: string;

  constructor(
    private readonly bridge: BridgeFlags,
    private readonly storage: IdentityStorage,
  ) {}

  /** Read the current anonymous ID, generating + persisting on first call. */
  ensureAnonymousId(): string {
    const existing = this.storage.read();
    if (existing) return existing;
    const fresh = generateAnonymousId();
    this.storage.write(fresh);
    return fresh;
  }

  /**
   * Push the anonymous ID into the BridgeFlags global eval context. Idempotent.
   * No-op if a known userId is already set.
   */
  hydrateAnonymous(): string {
    if (this.knownUserId) return this.knownUserId;
    const anonId = this.ensureAnonymousId();
    this.bridge.setContext({ identity: anonId, attributes: {} }, true);
    return anonId;
  }

  /**
   * Promote the SDK from anonymous to known. Updates the global identity in
   * `BridgeFlags` and fires the `onIdentify` hook so the server can link
   * anon-id telemetry to the known user's history.
   */
  identify(userId: string): void {
    if (!userId) throw new Error('identify(userId): userId must be a non-empty string');
    const previousAnon = this.knownUserId ? undefined : this.storage.read();
    this.knownUserId = userId;
    this.bridge.setContext({ identity: userId, attributes: {} }, true);
    if (this.onIdentifyHook) {
      try {
        this.onIdentifyHook({ anonymousId: previousAnon, userId });
      } catch {
        // Hook errors must not break identify().
      }
    }
  }

  /**
   * Drop the known identity and revert to anonymous. Used on logout. The
   * anonymous ID itself is preserved unless `dropAnonymous` is also passed.
   */
  logout(options: { dropAnonymous?: boolean } = {}): void {
    this.knownUserId = undefined;
    if (options.dropAnonymous) this.storage.clear();
    this.hydrateAnonymous();
  }

  /** Register a one-time hook fired on identify(). Used by the SDK telemetry batcher. */
  setOnIdentify(hook: (args: { anonymousId?: string; userId: string }) => void): void {
    this.onIdentifyHook = hook;
  }

  /** True when `identify()` has set a known user. */
  isKnown(): boolean {
    return !!this.knownUserId;
  }

  /** Read the current effective identity (known userId or anonymous ID). */
  current(): string | undefined {
    if (this.knownUserId) return this.knownUserId;
    return this.storage.read();
  }
}

/**
 * Factory: attach an anonymous-aware identity manager to a `BridgeFlags`
 * instance. Pass a storage implementation appropriate for the platform.
 */
export function attachIdentity(bridge: BridgeFlags, storage: IdentityStorage): BridgeIdentity {
  const identity = new BridgeIdentity(bridge, storage);
  // Eagerly populate context.identity so anonymous evals work from boot.
  identity.hydrateAnonymous();
  return identity;
}
