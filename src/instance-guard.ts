/**
 * Duplicate-instance detection for bridge-auth-core.
 *
 * WHY THIS EXISTS
 *
 * This package is NOT safe to load twice in one process or one bundle. It keeps
 * real state at module scope, and a second copy gets its own private copy of all
 * of it:
 *
 *   billing/use-bridge.ts   `_singleton`, `_quotaStore`, `_entitlementsStore`,
 *                           `_attachedRt`, `_devHandlers`
 *   billing/lock-signal.ts  `handler`
 *   flags/propagation.ts    `_serverInstanceId`
 *
 * The billing lock is the sharpest edge. `lock-signal.ts` exists specifically to
 * decouple the HTTP layer from the billing singleton: `http.ts` calls
 * `emitBillingLock()`, and `useBridge()` registers the receiver via
 * `setBillingLockHandler()`. Split across two copies, the app registers its
 * handler on copy A while the request that trips the lock emits on copy B — so
 * `handler` is null and **the lock never fires**. A workspace gets locked for
 * non-payment and the UI carries on as if nothing happened. Nothing errors.
 *
 * `_attachedRt` is the other one: two copies means two WebSocket connections and
 * two divergent flag caches, which is the shape of TBP-517.
 *
 * HOW DUPLICATES HAPPEN
 *
 * Every framework plugin used to declare this package as an exact-pinned regular
 * dependency. An app on `bridge-react@0.4.0` (pinning auth-core `0.4.0`) that
 * also pinned auth-core `0.4.4` itself got both, nested. The package manager is
 * behaving correctly; the dependency declaration was wrong. The plugins now
 * declare it as a `peerDependency` with a range, which makes the resolver pick
 * ONE — and turns a genuinely incompatible pin into a loud peer conflict instead
 * of a silent second copy.
 *
 * A peer dependency cannot catch everything, though: a bundler fed two different
 * physical paths (mixed ESM/CJS resolution, a monorepo symlink, an aliased copy)
 * still produces two module instances from one installed version. That is what
 * this guard is for. It is the last line, not the first.
 *
 * The check is deliberately a WARNING, never a throw. Refusing to start would
 * turn a degraded-but-working app into a dead one, and this code runs in
 * production browsers.
 */

/** Registry key. A string-keyed Symbol so every copy resolves the same symbol. */
const REGISTRY_KEY = Symbol.for('@nebulr-group/bridge-auth-core.instances');

interface InstanceRecord {
  count: number;
  warned: boolean;
}

/** SSR-safe global. `globalThis` is defined in every supported runtime. */
function registry(): InstanceRecord {
  const g = globalThis as unknown as Record<symbol, InstanceRecord | undefined>;
  let rec = g[REGISTRY_KEY];
  if (!rec) {
    rec = { count: 0, warned: false };
    g[REGISTRY_KEY] = rec;
  }
  return rec;
}

/**
 * Records this copy and warns — once per process — if it is not the first.
 *
 * Called at import time from the package entry point.
 *
 * Deliberately does NOT report which versions loaded. Getting the version into
 * the bundle means either importing package.json (which changes the emitted
 * dist layout) or a hand-maintained constant that silently drifts on release.
 * `npm ls` already answers "which versions" precisely, so the message points
 * there instead of carrying a copy that can go stale.
 *
 * @returns the number of copies now registered (1 = healthy)
 */
export function registerInstance(): number {
  let rec: InstanceRecord;
  try {
    rec = registry();
  } catch {
    // A runtime with a frozen/exotic globalThis. Detection is a nicety; never
    // let it be the reason the SDK fails to load.
    return 1;
  }

  rec.count += 1;

  if (rec.count > 1 && !rec.warned) {
    rec.warned = true;
    // eslint-disable-next-line no-console
    (globalThis as { console?: Console }).console?.warn?.(
      `[bridge-auth-core] Loaded ${rec.count} copies of this package.\n` +
        'This package keeps state at module scope, so a second copy silently breaks:\n' +
        '  - the billing lock (registered on one copy, emitted on the other — it never fires)\n' +
        '  - realtime (two WebSocket connections)\n' +
        '  - the feature-flag cache (two divergent copies)\n' +
        'Install ONE version: make sure every @nebulr-group/bridge-* plugin resolves the\n' +
        'same @nebulr-group/bridge-auth-core. `npm ls @nebulr-group/bridge-auth-core` shows\n' +
        'the tree; a deduped install has exactly one entry.',
    );
  }

  return rec.count;
}

/** How many copies have registered. Exposed for diagnostics and tests. */
export function loadedInstanceCount(): number {
  try {
    return registry().count;
  } catch {
    return 1;
  }
}

/** Test-only: clear the registry so cases do not leak into each other. */
export function __resetInstanceRegistryForTests(): void {
  const g = globalThis as unknown as Record<symbol, InstanceRecord | undefined>;
  g[REGISTRY_KEY] = { count: 0, warned: false };
}
