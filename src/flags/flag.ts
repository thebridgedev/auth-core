// bridge.flag(key, default) — the canonical SDK call (TBP-160).
//
// One method, one signature. The TypeScript return type matches the default
// value's type (boolean / string / number / structured), so callers don't
// need a separate cast.
//
// Local-first evaluation:
//   1. Look up the flag in the in-memory cache
//   2. If absent → return the developer's `defaultValue` (and emit a
//      "discovered" hook so the SDK can register the key with bridge-api)
//   3. If present → evaluate locally against the dev-supplied context
//   4. Always emit an `onEval` hook so the SDK can batch eval telemetry
//
// Hooks are pluggable so this module stays platform-agnostic. The actual
// wiring (HTTP batcher, fetch client, etc.) is the SDK integration's job
// — see TBP-157 / TBP-156 for the implementations.

import {
  evaluateRule,
  type EvalContext,
  type EvalResult,
  type Rule,
  type FlagState,
} from './evaluator.js';
import {
  AttributeProviderRegistry,
  type AttributeProvider,
} from './attribute-providers.js';

// ── Attribute type declarations (TBP-174) ───────────────────────────────────

/**
 * The attribute types the SDK and admin UI both understand. `semver` is a
 * commonly-needed string subtype that powers `app_version > 4.12` style rules;
 * runtime evaluation treats it as a string with regex-friendly comparators.
 */
export type DeclaredAttributeType = 'string' | 'number' | 'boolean' | 'date' | 'semver' | 'json';

export interface AttributeDeclaration {
  name: string;
  type: DeclaredAttributeType;
  /** Unix-ms when this declaration was made. */
  timestamp: number;
}

// ── Cached flag shape ───────────────────────────────────────────────────────

export type FlagValueType = 'boolean' | 'string' | 'number' | 'json';

export interface CachedFlag {
  key: string;
  state: FlagState;
  valueType: FlagValueType;
  offValue: unknown;
  onValue: unknown;
  rule?: Rule;
}

// ── Telemetry hooks ─────────────────────────────────────────────────────────

export interface EvalTelemetry {
  flag: string;
  value: unknown;
  variantIndex: number;
  identity?: string;
  /** Unix-ms when this eval happened. */
  timestamp: number;
  /** Optional opaque fingerprint of the call site (TBP-156). */
  callSiteFingerprint?: string;
}

export interface DiscoveryTelemetry {
  flag: string;
  defaultValue: unknown;
  observedType: FlagValueType;
  timestamp: number;
}

export interface AttributeObservation {
  /** Attribute key as the dev supplied it (e.g. 'country', 'myapp:foo'). */
  key: string;
  /** The sample value observed for the key in this eval. */
  sampleValue: unknown;
  /** Inferred type — fed into discovery so the admin UI gets a sensible picker. */
  observedType: FlagValueType;
  timestamp: number;
}

export interface BridgeFlagsHooks {
  /** Called on every successful eval. Should not throw. */
  onEval?: (ev: EvalTelemetry) => void;
  /** Called the first time the SDK sees an unknown flag key. */
  onDiscover?: (ev: DiscoveryTelemetry) => void;
  /**
   * Called once per distinct (key, sampleValue) seen in `bridge.flag()`
   * per-call `context.attributes`. The batcher relays this to
   * `/v1/flags/discover` with `kind: 'attribute'` so the admin UI's attribute
   * catalog shows what dev code actually supplies.
   */
  onAttributeObserved?: (ev: AttributeObservation) => void;
  /**
   * @deprecated Use per-call `bridge.flag(key, default, { attributes: {...} })`
   * instead — per-call observations now feed the admin attribute catalog
   * automatically via `onAttributeObserved`. `declareAttributes()` will be
   * removed in a future minor release.
   */
  onAttributeDeclaration?: (decl: AttributeDeclaration) => void;
}

// ── Eval result ─────────────────────────────────────────────────────────────

/**
 * The result of a flag evaluation. `passed` is true when a targeting rule (or
 * global on) resolved this flag to its on-value; false when the flag is off,
 * no rule matched, or the flag isn't in the cache yet. `value` is always the
 * Bridge-decided value — the on-value when passed, the off/default value when not.
 */
export interface FlagEvalResult<T> {
  passed: boolean;
  value: T;
}

// ── Core API ────────────────────────────────────────────────────────────────

/**
 * BridgeFlags — the SDK-side flag cache + eval entry point. Most apps see
 * exactly one instance, wired up at bootstrap time. Tests construct their
 * own instances directly.
 */
/**
 * Runtime mode for the SDK. Backends (Node servers) opt into `'backend'` to
 * disable auto-anonymous identity — per locked decision #27, backend evals
 * with no identity refuse to bucket rolled-out rules and return the safe
 * default. Frontends use `'frontend'` (the default).
 */
export type BridgeFlagsMode = 'frontend' | 'backend';

/**
 * Minimal shape of the SDK's usage reporter — kept narrow so `BridgeFlags`
 * doesn't depend on the full `UsageReporter` class. Framework wrappers pass
 * `bridge.usage` (which has the same `report(metric, value?)` signature).
 */
export interface FlagUsageReporterLike {
  report(metric: string, value?: number): void;
}

export class BridgeFlags {
  private cache = new Map<string, CachedFlag>();
  private context: EvalContext = { attributes: {} };
  private hooks: BridgeFlagsHooks = {};
  private discoveredKeys = new Set<string>();
  /** Per-runtime dedup for attribute observations: `${key}::${canonicalValue}`. */
  private observedAttributeKeys = new Set<string>();
  private attributeDeclarations = new Map<string, DeclaredAttributeType>();
  private mode: BridgeFlagsMode = 'frontend';
  private serverInstanceIdValue?: string;
  private missingIdentityWarned = new Set<string>();
  /** Billing 2.0 US-10 (TBP-262): self-report `bridge.flag_evaluations` per eval. */
  private usageReporter?: FlagUsageReporterLike;
  /**
   * Phase 1 / US-13 (TBP-293, TBP-294) — AttributeProvider registry consulted
   * on every flag eval. Bridge-managed providers (`bridge:auth`,
   * `bridge:billing`) are auto-registered by framework SDKs; apps register
   * their own providers via `registerAttributeProvider()`.
   */
  private readonly registry: AttributeProviderRegistry = new AttributeProviderRegistry();

  constructor(options: { mode?: BridgeFlagsMode; usageReporter?: FlagUsageReporterLike } = {}) {
    if (options.mode) this.mode = options.mode;
    if (options.usageReporter) this.usageReporter = options.usageReporter;
  }

  /**
   * Register an `AttributeProvider`. Idempotent on `provider.name` —
   * re-registering with the same name replaces the previous instance.
   * Provider attributes flow into every `flag()` eval automatically.
   * Dev-supplied attrs (via `setContext` / per-call `context`) win on
   * collision (locked decision #20).
   */
  registerAttributeProvider(provider: AttributeProvider): void {
    this.registry.register(provider);
  }

  /** Remove a previously-registered provider by name. No-op if not present. */
  unregisterAttributeProvider(name: string): void {
    this.registry.unregister(name);
  }

  /**
   * Expose the registry for advanced callers (e.g. async `applyTo()` refreshes
   * driven by framework auth events). Most consumers should prefer
   * `registerAttributeProvider` / `unregisterAttributeProvider`.
   */
  getAttributeProviderRegistry(): AttributeProviderRegistry {
    return this.registry;
  }

  /**
   * Wire a usage reporter post-construction. The flag-eval path will call
   * `reporter.report('bridge.flag_evaluations', 1)` on every successful eval
   * (i.e. when a cached flag is present and evaluated). Discovery-only paths
   * — first-sight unknown flag → default — do NOT count.
   */
  setUsageReporter(reporter: FlagUsageReporterLike | undefined): void {
    this.usageReporter = reporter;
  }

  /** Read the active runtime mode. */
  getMode(): BridgeFlagsMode {
    return this.mode;
  }

  /**
   * Set a stable server-instance identity (TBP-172). When set, backend flags
   * that explicitly opt into system-level targeting can bucket on this value
   * (e.g. canary a feature to one specific instance). Most evals continue to
   * use the per-call/per-context identity.
   */
  setServerInstanceId(id: string): void {
    if (typeof id !== 'string' || id.length === 0) return;
    this.serverInstanceIdValue = id;
  }

  /** Read the configured server-instance id, or undefined when not set. */
  getServerInstanceId(): string | undefined {
    return this.serverInstanceIdValue;
  }

  /** Replace or merge the eval context. */
  setContext(ctx: EvalContext, merge = false): void {
    if (merge) {
      this.context = {
        identity: ctx.identity ?? this.context.identity,
        attributes: { ...this.context.attributes, ...ctx.attributes },
      };
    } else {
      this.context = ctx;
    }
  }

  /** Return a defensive shallow copy of the current eval context. */
  getContext(): EvalContext {
    return { identity: this.context.identity, attributes: { ...this.context.attributes } };
  }

  /** Replace the cache from a bulk hydrate (e.g. response from bridge-api). */
  hydrate(flags: CachedFlag[]): void {
    this.cache.clear();
    for (const f of flags) {
      this.cache.set(f.key, f);
    }
  }

  /** Replace or insert a single flag (used by live updates). */
  upsert(flag: CachedFlag): void {
    this.cache.set(flag.key, flag);
  }

  /** Remove a flag from the cache. */
  remove(key: string): void {
    this.cache.delete(key);
  }

  /** Register telemetry hooks. Replaces any previous hooks. */
  setHooks(hooks: BridgeFlagsHooks): void {
    this.hooks = hooks;
  }

  /**
   * Read a flag value. Returns `defaultValue` when the flag isn't known yet.
   * TypeScript infers `T` from `defaultValue`, so callers don't write casts.
   *
   * An optional per-call `context` overrides the SDK's global context for
   * just this eval. Attributes deep-merge — per-call wins on overlap, global
   * keys not in the override are preserved.
   */
  flag<T>(key: string, defaultValue: T, context?: Partial<EvalContext>): FlagEvalResult<T> {
    const cached = this.cache.get(key);
    const now = Date.now();
    const observedType = inferType(defaultValue);

    // Phase 1 / US-13 — merge AttributeProvider-supplied attrs into the eval
    // context on every call. Precedence (locked decision #20):
    //   providers (lowest)  <  setContext globals  <  per-call context (highest)
    // Sync-only here: `collectSync()` skips any async provider for this eval
    // (those refresh via `applyTo()` on auth/billing change events).
    const providerAttrs =
      this.registry.size() > 0 ? this.registry.collectSync() : undefined;

    let effectiveCtx: EvalContext;
    if (!context && !providerAttrs) {
      effectiveCtx = this.context;
    } else {
      effectiveCtx = {
        identity: context?.identity ?? this.context.identity,
        attributes: {
          ...(providerAttrs ?? {}),
          ...this.context.attributes,
          ...(context?.attributes ?? {}),
        },
      };
    }

    // Observe per-call attribute keys so the admin UI's attribute catalog
    // surfaces what dev code actually supplies (powers TBP-178 collision
    // detection + custom attribute autocomplete). Dedup per (key, value) in
    // this runtime to keep the batcher quiet.
    if (context?.attributes) {
      for (const [attrKey, attrVal] of Object.entries(context.attributes)) {
        if (!attrKey) continue;
        const dedupKey = `${attrKey}::${canonicalSampleKey(attrVal)}`;
        if (this.observedAttributeKeys.has(dedupKey)) continue;
        this.observedAttributeKeys.add(dedupKey);
        this.safeHook(() =>
          this.hooks.onAttributeObserved?.({
            key: attrKey,
            sampleValue: attrVal,
            observedType: inferType(attrVal),
            timestamp: now,
          }),
        );
      }
    }

    // Backend mode (TBP-170): refuse to evaluate user-level rules without an
    // identity. Returns the developer's `defaultValue` rather than guessing
    // with anonymous bucketing. Warn once per flag per runtime.
    if (this.mode === 'backend' && !effectiveCtx.identity && cached?.state === 'on-with-rule') {
      if (!this.missingIdentityWarned.has(key)) {
        this.missingIdentityWarned.add(key);
        try {
          // eslint-disable-next-line no-console
          (globalThis as any).console?.warn?.(
            `[bridge.flag] '${key}': backend eval requires an explicit identity; returning default. ` +
              `Pass context.identity per call, or use a server-instance id for system-level flags.`,
          );
        } catch {
          // ignore console errors
        }
      }
      return { passed: false, value: defaultValue };
    }

    if (!cached) {
      // First sight — emit a discovery event so the server creates the
      // record. Dedupe per (key) in this runtime; server is the authority.
      if (!this.discoveredKeys.has(key)) {
        this.discoveredKeys.add(key);
        this.safeHook(() =>
          this.hooks.onDiscover?.({
            flag: key,
            defaultValue,
            observedType,
            timestamp: now,
          }),
        );
      }
      return { passed: false, value: defaultValue };
    }

    const result = this.evaluateCached(cached, effectiveCtx);
    const value = result.value === undefined ? defaultValue : (result.value as T);

    this.safeHook(() =>
      this.hooks.onEval?.({
        flag: key,
        value,
        variantIndex: result.variantIndex,
        identity: effectiveCtx.identity,
        timestamp: now,
      }),
    );

    // Billing 2.0 US-10 (TBP-262): SDK-side flag_evaluations self-report.
    // Fire-and-forget; the reporter handles batching + errors. One call per
    // eval — there's no batched flag API, so no multiplier needed.
    if (this.usageReporter) {
      this.safeHook(() => this.usageReporter?.report('bridge.flag_evaluations', 1));
    }

    // Fail-safe type check: if the cached value doesn't match the dev's
    // declared default type, fall back to the default. Protects the app
    // from admin-side type mistakes (TBP-159 validation should catch most
    // of these at save time; this is the last-mile safety net).
    if (!typeMatches(value, observedType)) {
      return { passed: false, value: defaultValue };
    }
    return { passed: result.matched, value };
  }

  /**
   * Internal — evaluate the cached flag against an eval context.
   */
  private evaluateCached(cached: CachedFlag, ctx: EvalContext): EvalResult {
    switch (cached.state) {
      case 'off':
        return { value: cached.offValue, variantIndex: -1, matched: false, excludedByRollout: false };
      case 'on':
        return { value: cached.onValue, variantIndex: 0, matched: true, excludedByRollout: false };
      case 'on-with-rule': {
        if (!cached.rule) {
          // Defensive: state says on-with-rule but no rule. Fall back to on.
          return { value: cached.onValue, variantIndex: -1, matched: false, excludedByRollout: false };
        }
        return evaluateRule(cached.rule, cached.key, ctx);
      }
      default:
        return { value: cached.offValue, variantIndex: -1, matched: false, excludedByRollout: false };
    }
  }

  /** Number of cached flags. Useful for debugging + tests. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Get a snapshot of cached flag keys. */
  cachedKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * @deprecated Per-call observations now power the admin attribute catalog
   * automatically — just pass attributes when you evaluate a flag:
   *   `bridge.flag('feat', false, { attributes: { plan: 'pro' } })`.
   * The SDK reports each `(key, sampleValue)` once via `onAttributeObserved`,
   * which the batcher relays to `/v1/flags/discover` with `kind: 'attribute'`.
   * `declareAttributes()` will be removed in a future minor release.
   */
  declareAttributes(declarations: Record<string, DeclaredAttributeType>): void {
    const now = Date.now();
    for (const [name, type] of Object.entries(declarations)) {
      if (typeof name !== 'string' || name.length === 0) continue;
      if (this.attributeDeclarations.get(name) === type) continue; // same as before; no-op
      this.attributeDeclarations.set(name, type);
      this.safeHook(() =>
        this.hooks.onAttributeDeclaration?.({ name, type, timestamp: now }),
      );
    }
  }

  /** Read the current attribute type declarations. Useful for tests + framework wrappers. */
  getAttributeDeclarations(): Record<string, DeclaredAttributeType> {
    return Object.fromEntries(this.attributeDeclarations.entries());
  }

  private safeHook(fn: () => void): void {
    try {
      fn();
    } catch {
      // Telemetry must never break eval. Silently swallow.
    }
  }
}

// ── Type inference helpers ──────────────────────────────────────────────────

function inferType(v: unknown): FlagValueType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  return 'json';
}

/** Stable string key for an attribute sample value — used for in-process dedup
 *  in `observedAttributeKeys`. Safe for primitives + JSON-serialisable values. */
function canonicalSampleKey(v: unknown): string {
  if (v === undefined) return '∅undef';
  if (v === null) return '∅null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '∅unserialisable';
  }
}

function typeMatches(v: unknown, expected: FlagValueType): boolean {
  if (v === undefined || v === null) return false;
  switch (expected) {
    case 'boolean':
      return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'json':
      return true;
  }
}
