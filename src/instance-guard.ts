/**
 * Duplicate-copy detection.
 *
 * Two copies of this package in one bundle (two versions, or one version
 * reached through two paths) still run, but quietly worse: `instanceof
 * BridgeError` is false for the other copy's errors, and each copy's clients
 * coordinate their tabs and refreshes only among themselves. A framework
 * plugin declares this package as a peer dependency so the package manager
 * installs one copy; this guard is the last line for a bundler that still
 * produces two.
 *
 * It warns, once per process, and never throws: refusing to start would turn
 * a working app into a dead one.
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
        'With two copies, `instanceof BridgeError` fails for the other copy\'s errors, and\n' +
        'clients from different copies do not coordinate refreshes across tabs.\n' +
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
