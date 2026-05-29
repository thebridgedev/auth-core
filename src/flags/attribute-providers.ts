// AttributeProvider plugin model for Bridge Feature Flags (TBP-173).
//
// AttributeProvider is THE canonical mechanism for feeding attributes into
// flag evaluation. Every framework SDK wires the bridge-managed providers
// (`AuthAttributeProvider`, `BillingAttributeProvider`) automatically on
// bootstrap so `user.role`, `tenant.plan`, billing entitlements etc. flow in
// without app code. Apps push their own state into eval by implementing
// `AttributeProvider` and `register()`ing the instance on the registry — that
// is the canonical pattern for any attribute backed by app state (cohort,
// route segment, current workspace, anything reactive).
//
// Per-call attributes (via `setContext` or the `<FeatureFlag context>` /
// `useFlag(key, default, context)` prop) are the *override* path — for
// transient, one-off, or per-instance values, and to override a provider
// value at a specific call site. Collision rule (locked decision #20):
// dev-supplied attributes WIN over provider-supplied attributes on key
// overlap. The admin UI surfaces the collision so it's debuggable (TBP-178).

import type { BridgeFlags } from './flag.js';
import type { BridgeSubscription } from '../billing/bridge-subscription.js';
import type { QuotaStore } from '../billing/quota-store.js';
import type { EntitlementsStore } from '../billing/entitlements-store.js';

/**
 * A provider contributes a set of attributes for the current user/session.
 * `provide()` is called on every flag eval; implementations should be cheap
 * and synchronous (or fast async). Provider errors fall back to empty
 * attributes — never break the eval.
 */
export interface AttributeProvider {
  /** Stable name for logging + collision messaging. */
  readonly name: string;
  /** Whether the keys this provider supplies count as bridge-managed (`bridge:`) or custom (`custom:`). */
  readonly namespace?: 'bridge' | 'custom';
  /**
   * Return the attributes this provider currently supplies. May return a
   * Promise; for hot paths, implementations should cache and return sync.
   */
  provide(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Registry attached to a BridgeFlags instance. Framework SDKs (bridge-svelte's
 * Bridge.init) wire this up during bootstrap.
 */
export class AttributeProviderRegistry {
  private providers: AttributeProvider[] = [];

  /** Register a provider. Idempotent on `name` — re-registering with the same name replaces. */
  register(provider: AttributeProvider): void {
    if (!provider.name) {
      throw new Error('AttributeProvider must have a non-empty name');
    }
    this.providers = this.providers.filter((p) => p.name !== provider.name);
    this.providers.push(provider);
  }

  /** Remove a provider by name. */
  unregister(name: string): void {
    this.providers = this.providers.filter((p) => p.name !== name);
  }

  /** Number of providers currently registered. */
  size(): number {
    return this.providers.length;
  }

  /** List provider names. */
  names(): string[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * Collect attributes from every registered provider, merged in registration
   * order. Later providers' keys overwrite earlier ones; this is INTERNAL
   * merge order — dev-supplied attributes always win at the call boundary
   * (handled in `applyTo`).
   *
   * Provider failures are isolated — one provider throwing doesn't block the
   * rest. The failing provider contributes an empty attribute set for that call.
   */
  async collect(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const provider of this.providers) {
      try {
        const attrs = await provider.provide();
        Object.assign(out, attrs ?? {});
      } catch {
        // Silently skip a failing provider for this eval.
      }
    }
    return out;
  }

  /**
   * Sync variant of `collect()` — used by `BridgeFlags.flag()` on the hot eval
   * path (FF 2.0 evaluates inline on every flag check, so the merge must be
   * sync). Async providers are SKIPPED for this eval; they should self-cache
   * their result and return sync values once warmed.
   *
   * Same isolation guarantee as `collect()`: one throwing provider doesn't
   * block the rest.
   */
  collectSync(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const provider of this.providers) {
      try {
        const attrs = provider.provide();
        if (attrs instanceof Promise) {
          // Async providers can't participate in the sync hot path. They run
          // through `collect()`/`applyTo()` on demand instead.
          continue;
        }
        Object.assign(out, attrs ?? {});
      } catch {
        // Silently skip a failing provider for this eval.
      }
    }
    return out;
  }

  /**
   * Apply provider attributes to a BridgeFlags instance's global context.
   * Should be called on a sensible cadence by the framework SDK — typically:
   *   - once at bootstrap
   *   - when auth state changes (logout/login, role change)
   *   - on a periodic refresh if attributes drift
   *
   * Dev-supplied attributes are preserved on collision (locked decision #20).
   */
  async applyTo(bridge: BridgeFlags): Promise<void> {
    const providerAttrs = await this.collect();
    const current = bridge.getContext().attributes;
    // Provider attrs first, dev-supplied attrs second (dev wins on collision)
    bridge.setContext(
      {
        identity: bridge.getContext().identity,
        attributes: { ...providerAttrs, ...current },
      },
      false,
    );
  }
}

// ── Stub providers for Bridge auth + billing ────────────────────────────────
//
// Concrete implementations live in their respective ecosystems:
//   AuthAttributeProvider    → bridge-svelte / bridge-react / etc. read from Bridge auth state
//   BillingAttributeProvider → bridge-* read from Bridge billing subscriptions
//
// auth-core ships these as TYPE definitions + a stub implementation that
// returns empty attributes. Apps that wire up Bridge auth/billing replace the
// stubs with real implementations.

/**
 * Shape of the JWT claims that AuthAttributeProvider reads. Every field is
 * optional — the provider emits an attribute only when the corresponding
 * claim is present.
 */
export interface AuthJwtClaims {
  /** Subject — the user's id. */
  sub?: string;
  role?: string;
  email?: string;
  /** Tenant id. */
  tid?: string;
  /** Tenant plan (mirrored into `tenant.plan`). Authoritative source for
   * `bridge:billing.plan` is the BillingAttributeProvider — keep them in sync. */
  plan?: string;
  /** Privilege list (or a single comma-joined string). */
  privileges?: string[] | string;
  /** Catch-all so unknown claims don't break the type. */
  [k: string]: unknown;
}

/**
 * Configuration for `AuthAttributeProvider`. The framework SDK supplies a
 * sync getter that returns the current decoded JWT claims (or `undefined`
 * when logged out). Sync read is critical: FF 2.0 evaluates inline.
 */
export interface AuthProviderConfig {
  getClaims: () => AuthJwtClaims | undefined;
}

/**
 * Canonical auth-derived attribute source. Reads decoded JWT claims through
 * a sync callback the framework SDK provides, and flattens them into the
 * eval namespace:
 *   - `user.id`        ← `sub`
 *   - `user.role`      ← `role`
 *   - `user.email`     ← `email`
 *   - `tenant.id`      ← `tid`
 *   - `tenant.plan`    ← `plan`
 *   - `privileges`     ← `privileges` (array or string)
 *
 * Construct with no config for the empty stub (every workspace gets the
 * provider in its registry by default; unconfigured ones contribute nothing).
 */
export class AuthAttributeProvider implements AttributeProvider {
  readonly name = 'bridge:auth';
  readonly namespace = 'bridge' as const;

  private readonly config: AuthProviderConfig;

  constructor(config?: AuthProviderConfig) {
    this.config = config ?? { getClaims: () => undefined };
  }

  provide(): Record<string, unknown> {
    let claims: AuthJwtClaims | undefined;
    try {
      claims = this.config.getClaims();
    } catch {
      return {};
    }
    if (!claims || typeof claims !== 'object') return {};

    const out: Record<string, unknown> = {};
    if (typeof claims.sub === 'string' && claims.sub.length > 0) {
      out['user.id'] = claims.sub;
    }
    if (typeof claims.role === 'string') {
      out['user.role'] = claims.role;
    }
    if (typeof claims.email === 'string') {
      out['user.email'] = claims.email;
    }
    if (typeof claims.tid === 'string') {
      out['tenant.id'] = claims.tid;
    }
    if (typeof claims.plan === 'string') {
      out['tenant.plan'] = claims.plan;
    }
    if (Array.isArray(claims.privileges)) {
      out['privileges'] = claims.privileges;
    } else if (typeof claims.privileges === 'string') {
      out['privileges'] = claims.privileges;
    }
    return out;
  }
}

// ── BillingAttributeProvider (TBP-202 / US-13 TBP-265) ─────────────────────
//
// Surfaces the current user/tenant's billing snapshot as namespaced attributes
// so admins can write rules like:
//   `bridge:billing.plan eq "PRO"`
//   `bridge:billing.trial eq true`
//   `bridge:billing.subscription.status eq "active"`
//   `bridge:billing.quota.ai_completions.percent_used gt 0.8`
//   `bridge:billing.entitlement.app_active eq true`
//
// Two wiring modes coexist:
//
//   1. US-13 store mode (canonical) — `bindStores({ subscription, quotas,
//      entitlements })` injects the three Phase A/B `useBridge()` stores.
//      `provide()` reads them synchronously on every eval and flattens the
//      live state. Sync read is critical: FF 2.0 evaluates inline on every
//      flag check.
//
//   2. Legacy `getBillingSnapshot` callback (pre-US-13) — preserved so
//      standalone-FF apps that wired this before US-13 keep working. Store-
//      derived keys win on collision.
//
// Push-driven freshness: the bridge-api side fires `user.state_changed`
// (reason: `attributes_changed`) on the per-user channel after billing
// transitions (status change, plan change, entitlement diff, quota threshold).
// The FF 2.0 RealtimeClient hook handles that by refreshing tokens and
// invoking `notifyAllFlagsChanged()`, which re-runs every eval — and since
// `provide()` reads stores live, the new values flow through automatically.
// No additional re-eval plumbing needed in this file.

/**
 * A snapshot of the current billing state. All fields optional — apps can
 * surface only what they have. `quota` exposes `{used, limit}` per resource;
 * the provider auto-derives `percent_used` when both fields are numeric and
 * `limit > 0`. `limit` exposes scalar plan caps (seats, max_projects, etc).
 */
export interface BillingSnapshot {
  /** Current plan tier (e.g. 'FREE' | 'TEAM' | 'PRO'). */
  plan?: string;
  /** True when the tenant is on a time-limited trial. */
  trial?: boolean;
  /** Metered usage per resource. */
  quota?: Record<string, { used?: number; limit?: number }>;
  /** Plan-defined scalar caps. */
  limit?: Record<string, number | string>;
}

/**
 * Configuration for `BillingAttributeProvider`. The dev supplies a callable
 * that returns the current snapshot — sync or async. Returning `undefined`
 * means "no billing data right now" → the provider contributes no attributes.
 */
export interface BillingProviderConfig {
  getBillingSnapshot: () =>
    | BillingSnapshot
    | Promise<BillingSnapshot | undefined>
    | undefined;
}

/**
 * Billing 2.0 US-13 — store-backed wiring for the BillingAttributeProvider.
 *
 * Framework wrappers pass the three Phase A/B stores from `useBridge()`. The
 * provider reads them synchronously on every flag eval and flattens the live
 * state into the `bridge:billing.*` namespace:
 *   - subscription:  `plan`, `trial`, `subscription.status`
 *   - quotas:        `quota.<metric>.{used,limit,remaining,percent_used}`
 *   - entitlements:  `entitlement.<name>` (incl. `entitlement.app_active`)
 *
 * All store reads are O(stores in cache). `provide()` MUST stay sync — the FF
 * 2.0 eval path calls it inline on every flag check. No HTTP, no awaits.
 */
export interface BillingProviderStores {
  /** `useBridge().subscription` — reactive container for canonical sub state. */
  subscription?: BridgeSubscription;
  /** `useBridge().quotas` — per-metric snapshot cache. */
  quotas?: QuotaStore;
  /** `useBridge().entitlementsStore` — fail-closed boolean map. */
  entitlements?: EntitlementsStore;
}

const BILLING_NS_PREFIX = 'bridge:billing.';

export class BillingAttributeProvider implements AttributeProvider {
  readonly name = 'bridge:billing';
  readonly namespace = 'bridge' as const;

  private readonly config: BillingProviderConfig;
  private stores: BillingProviderStores = {};
  private warnedOnce = false;

  /**
   * Construct with an explicit config that supplies the billing snapshot.
   * No config → treated as an empty provider (returns `{}` on every call)
   * so accidentally instantiating without wiring doesn't crash.
   */
  constructor(config?: BillingProviderConfig) {
    this.config = config ?? { getBillingSnapshot: () => undefined };
  }

  /**
   * Billing 2.0 US-13 — wire the three reactive stores from `useBridge()` so
   * `provide()` can flatten live billing state synchronously on every flag
   * eval. Idempotent: re-binding replaces the previous store references. Any
   * subset of stores may be supplied — missing stores simply contribute no
   * keys to the flattened map (eg. unattached subscription → no `plan` key).
   *
   * Framework wrappers (bridge-svelte's `Bridge.init`) call this once after
   * `useBridge()` has been bootstrapped, then `register()` the provider on
   * the FF 2.0 AttributeProviderRegistry.
   */
  bindStores(stores: BillingProviderStores): void {
    this.stores = { ...stores };
  }

  /**
   * Flatten the live billing state into the `bridge:billing.*` namespace.
   *
   * Two sources are merged:
   *   1. US-13 store path: reads the three `useBridge()` stores synchronously
   *      and emits canonical `plan`, `trial`, `subscription.status`,
   *      `quota.<metric>.*`, and `entitlement.<name>` keys.
   *   2. Legacy `getBillingSnapshot` callback path (pre-US-13): preserved so
   *      standalone-FF apps that wired the provider before US-13 keep
   *      working. Store-derived keys win on collision (newer = canonical).
   *
   * The store path is sync, no HTTP, no awaits — safe in the FF 2.0 hot eval
   * path. The legacy path may be async; when it is, the merged result is a
   * Promise (consumers awaiting `provide()` already handle this).
   *
   * Failures in any branch degrade silently to whatever was successfully
   * collected — never throws, never breaks the eval.
   */
  provide():
    | Record<string, unknown>
    | Promise<Record<string, unknown>> {
    // US-13 — store-backed path. Synchronous, no HTTP. Reads the live state
    // of the three Phase A/B stores (subscription, quotas, entitlements) and
    // flattens into the `bridge:billing.*` namespace. Safe to call before any
    // store is wired — missing stores simply contribute no keys.
    const storeAttrs = this.flattenStores();

    // Legacy path — the `getBillingSnapshot` callback config. Preserved so
    // standalone-FF apps that wired the provider before US-13 keep working.
    let result: ReturnType<BillingProviderConfig['getBillingSnapshot']>;
    try {
      result = this.config.getBillingSnapshot();
    } catch (err) {
      this.warnOnce(err);
      return storeAttrs;
    }

    if (result instanceof Promise) {
      // Async legacy snapshot — merge async; store attrs are returned now and
      // also re-emitted under the resolved promise. Provider attrs from the
      // store path win on collision (newer = US-13 canonical).
      return result.then(
        (snap) => ({ ...this.flatten(snap), ...storeAttrs }),
        (err) => {
          this.warnOnce(err);
          return storeAttrs;
        },
      );
    }
    // Sync legacy snapshot (or undefined) — merge sync. Store attrs win.
    const legacyAttrs = this.flatten(result);
    return { ...legacyAttrs, ...storeAttrs };
  }

  /**
   * US-13 — read the three stores and emit the canonical `bridge:billing.*`
   * flat map. Sync, defensive: every store ref is optional and every read is
   * wrapped so a single misbehaving store can't break the eval path.
   *
   * Output key set per `BillingAttributeProvider`'s ticket contract:
   *   - `bridge:billing.plan`                    string (plan slug)
   *   - `bridge:billing.trial`                   boolean
   *   - `bridge:billing.subscription.status`     string
   *   - `bridge:billing.quota.<metric>.used`     number
   *   - `bridge:billing.quota.<metric>.limit`    number
   *   - `bridge:billing.quota.<metric>.remaining` number
   *   - `bridge:billing.quota.<metric>.percent_used` number (0..1+)
   *   - `bridge:billing.entitlement.<name>`      boolean (incl. `app_active`)
   *
   * Note: `bridge:billing.limit.<name>` (non-quota plan caps like seats) is
   * reserved for a future story — no live source today, so it's left empty.
   */
  private flattenStores(): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    // Subscription — plan slug, trial flag, status string.
    try {
      const sub = this.stores.subscription;
      if (sub) {
        const snap = sub.snapshot();
        const state = snap.state;
        if (state) {
          if (state.plan && typeof state.plan.slug === 'string') {
            out[`${BILLING_NS_PREFIX}plan`] = state.plan.slug;
          }
          if (typeof state.status === 'string') {
            out[`${BILLING_NS_PREFIX}subscription.status`] = state.status;
            out[`${BILLING_NS_PREFIX}trial`] = state.status === 'trial';
          }
        }
      }
    } catch (err) {
      this.warnOnce(err);
    }

    // Quotas — per-metric used / limit / remaining / percent_used.
    try {
      const quotas = this.stores.quotas;
      if (quotas) {
        const all = quotas.getAll();
        for (const [metric, snap] of all.entries()) {
          if (!snap) continue;
          const base = `${BILLING_NS_PREFIX}quota.${metric}`;
          if (typeof snap.used === 'number') out[`${base}.used`] = snap.used;
          if (typeof snap.limit === 'number') out[`${base}.limit`] = snap.limit;
          if (typeof snap.remaining === 'number') {
            out[`${base}.remaining`] = snap.remaining;
          }
          if (typeof snap.percent_used === 'number') {
            out[`${base}.percent_used`] = snap.percent_used;
          }
        }
      }
    } catch (err) {
      this.warnOnce(err);
    }

    // Entitlements — boolean per name (incl. `app_active`).
    try {
      const ent = this.stores.entitlements;
      if (ent && ent.isHydrated()) {
        const all = ent.all();
        for (const [name, value] of Object.entries(all)) {
          if (typeof value === 'boolean') {
            out[`${BILLING_NS_PREFIX}entitlement.${name}`] = value;
          }
        }
      }
    } catch (err) {
      this.warnOnce(err);
    }

    return out;
  }

  private flatten(snapshot: BillingSnapshot | undefined): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== 'object') return {};

    const out: Record<string, unknown> = {};

    if (typeof snapshot.plan === 'string') {
      out[`${BILLING_NS_PREFIX}plan`] = snapshot.plan;
    }
    if (typeof snapshot.trial === 'boolean') {
      out[`${BILLING_NS_PREFIX}trial`] = snapshot.trial;
    }

    if (snapshot.quota && typeof snapshot.quota === 'object') {
      for (const [resource, q] of Object.entries(snapshot.quota)) {
        if (!q || typeof q !== 'object') continue;
        const base = `${BILLING_NS_PREFIX}quota.${resource}`;
        const used = typeof q.used === 'number' ? q.used : undefined;
        const limit = typeof q.limit === 'number' ? q.limit : undefined;
        if (used !== undefined) out[`${base}.used`] = used;
        if (limit !== undefined) out[`${base}.limit`] = limit;
        if (used !== undefined && limit !== undefined && limit > 0) {
          out[`${base}.percent_used`] = Math.floor((used / limit) * 100);
        }
      }
    }

    if (snapshot.limit && typeof snapshot.limit === 'object') {
      for (const [name, value] of Object.entries(snapshot.limit)) {
        if (typeof value === 'number' || typeof value === 'string') {
          out[`${BILLING_NS_PREFIX}limit.${name}`] = value;
        }
      }
    }

    return out;
  }

  private warnOnce(err: unknown): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    try {
      // eslint-disable-next-line no-console
      (globalThis as any).console?.warn?.(
        `[BillingAttributeProvider] getBillingSnapshot threw; ` +
          `returning empty attributes. Error: ${(err as Error)?.message ?? String(err)}`,
      );
    } catch {
      // ignore console errors
    }
  }
}
