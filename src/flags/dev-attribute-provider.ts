// Phase 5 (TBP-288/328/329/330) — dev-managed AttributeProvider.
//
// Backs the `bridge.attributes` surface in framework SDKs (bridge-svelte etc.).
// Three contribution modes — all coexist in one provider instance:
//
//   set(key, value)        → static one-shot value
//   bind(key, getter)      → live; getter is called on every flag eval
//   bindMany(getter)       → bulk; getter returns Record<string, unknown>
//
// Reserved namespace: keys starting with `bridge:` (and the legacy aliases
// `app:`, `tenant:`, `user:` reserved for bridge-managed attribute scopes)
// are REJECTED at write time with a clear console.warn — they don't end up
// in the provider map. Reads via get() return only the dev-contributed keys.

const RESERVED_PREFIXES = ['bridge:'] as const;

export type AttributeGetter = () => unknown;
export type AttributeBulkGetter = () => Record<string, unknown> | undefined | null;

export interface SetOptions {
  /**
   * When false, this attribute's reads do NOT participate in
   * `onAttributeObserved` telemetry. Default true.
   *
   * Useful for high-frequency keys (e.g. cursor position, scroll offset)
   * where the dev needs the value in flag evals but doesn't need the
   * telemetry overhead.
   */
  observed?: boolean;
}

interface BoundEntry {
  kind: 'static' | 'bound' | 'bulk';
  key?: string;                       // present for 'static' and 'bound'
  value?: unknown;                    // present for 'static'
  getter?: AttributeGetter;           // present for 'bound'
  bulkGetter?: AttributeBulkGetter;   // present for 'bulk'
  observed: boolean;
}

function isReserved(key: string): boolean {
  for (const p of RESERVED_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

function warnReserved(key: string, context: string): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    // eslint-disable-next-line no-console
    console.warn(
      `[bridge.attributes.${context}] key "${key}" is in the reserved \`bridge:\` namespace — write rejected. ` +
      `Use a custom prefix (e.g. \`app.${key.split(':')[1] ?? key}\`) instead.`,
    );
  }
}

/**
 * Dev-managed AttributeProvider — the single backend for the `bridge.attributes`
 * surface. One instance is created per SDK init and registered with the
 * AttributeProviderRegistry. The order of registration determines whose
 * keys win on collision via `collectSync` merge order (per-call attrs >
 * setContext > providers — locked decision #20). Dev's provider is registered
 * LAST so its keys beat the framework providers.
 */
export class DevAttributeProvider {
  readonly name = 'dev';
  readonly namespace: 'custom' = 'custom';

  // Single map keyed by attribute key for `static` + `bound` entries.
  // Bulk entries are kept in a parallel list (no single key).
  private readonly _entries = new Map<string, BoundEntry>();
  private readonly _bulkEntries: BoundEntry[] = [];

  // Subscriptions for the Svelte store contract (TBP-328 AC: "subscribable").
  private readonly _subscribers = new Set<(map: Record<string, unknown>) => void>();

  /** Static one-shot value. `opts.observed` defaults to true. */
  set(key: string, value: unknown, opts?: SetOptions): void {
    if (isReserved(key)) {
      warnReserved(key, 'set');
      return;
    }
    this._entries.set(key, {
      kind: 'static',
      key,
      value,
      observed: opts?.observed ?? true,
    });
    this._notify();
  }

  /** Live-bound: getter re-invoked on every flag eval. */
  bind(key: string, getter: AttributeGetter, opts?: SetOptions): void {
    if (isReserved(key)) {
      warnReserved(key, 'bind');
      return;
    }
    this._entries.set(key, {
      kind: 'bound',
      key,
      getter,
      observed: opts?.observed ?? true,
    });
    this._notify();
  }

  /**
   * Bulk getter returning `Record<string, unknown>`. Reserved keys inside
   * the returned map are silently dropped (a `console.warn` fires once per
   * reserved key per session to surface the typo).
   */
  bindMany(getter: AttributeBulkGetter, opts?: SetOptions): void {
    this._bulkEntries.push({
      kind: 'bulk',
      bulkGetter: getter,
      observed: opts?.observed ?? true,
    });
    this._notify();
  }

  /** Remove a key (static or bound). Bulk getters are removed via `clearBulk()`. */
  unset(key: string): void {
    if (this._entries.delete(key)) this._notify();
  }

  /** Remove every bulk getter. */
  clearBulk(): void {
    if (this._bulkEntries.length === 0) return;
    this._bulkEntries.length = 0;
    this._notify();
  }

  /** Remove every entry (test/teardown). */
  clear(): void {
    this._entries.clear();
    this._bulkEntries.length = 0;
    this._notify();
  }

  /**
   * AttributeProvider contract — invoked synchronously on the FF 2.0 hot
   * eval path. Returns the merged attribute map.
   *
   * Merge order within the dev provider: bulk getters first (so individual
   * `set`/`bind` calls win over a bulk that happens to repeat a key).
   * Getter exceptions are isolated — one throwing key doesn't break the rest.
   */
  provide(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const entry of this._bulkEntries) {
      try {
        const m = entry.bulkGetter!();
        if (m && typeof m === 'object') {
          for (const [k, v] of Object.entries(m)) {
            if (isReserved(k)) continue;
            out[k] = v;
          }
        }
      } catch {
        // Skip a throwing bulk getter for this eval.
      }
    }
    for (const entry of this._entries.values()) {
      try {
        if (entry.kind === 'static') {
          out[entry.key!] = entry.value;
        } else if (entry.kind === 'bound') {
          out[entry.key!] = entry.getter!();
        }
      } catch {
        // Skip a throwing getter; other keys still flow through.
      }
    }
    return out;
  }

  /** Read-side convenience used by the public `bridge.attributes.get()`. */
  get(): Record<string, unknown> {
    return this.provide();
  }

  /**
   * Whether the key opts out of `onAttributeObserved` telemetry. Looked up
   * by the framework SDK at observation time; bulk-supplied keys default to
   * the bulk entry's `observed` flag (or true).
   */
  isObserved(key: string): boolean {
    const direct = this._entries.get(key);
    if (direct) return direct.observed;
    // Bulk entries don't track per-key observation; use the most-recently
    // added bulk entry's flag if any, else default true.
    if (this._bulkEntries.length > 0) {
      return this._bulkEntries[this._bulkEntries.length - 1].observed;
    }
    return true;
  }

  /** Svelte store contract — subscribe to attribute-map snapshots. */
  subscribe(fn: (map: Record<string, unknown>) => void): () => void {
    this._subscribers.add(fn);
    try {
      fn(this.provide());
    } catch {
      // ignore subscriber errors
    }
    return () => {
      this._subscribers.delete(fn);
    };
  }

  private _notify(): void {
    if (this._subscribers.size === 0) return;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = this.provide();
    } catch {
      return;
    }
    for (const fn of this._subscribers) {
      try {
        fn(snapshot);
      } catch {
        // ignore subscriber errors
      }
    }
  }
}

/** Exposed for tests in other packages that want to validate the reserved set. */
export const __TEST_RESERVED_PREFIXES: readonly string[] = RESERVED_PREFIXES;
