// Billing 2.0 US-19 (TBP-270) — Durable storage factory.
//
// Auto-selects the correct backend for the current runtime:
//   - browser → IndexedDBStorage
//   - Node    → NodeFsStorage (loaded lazily — see edge-safety note)
//   - else    → InMemoryStorage (SSR / edge fallback)
//
// Edge-safety (TBP — Node-builtin edge-runtime fix): node-fs-storage.js loads
// the Node fs/path/os builtins. Bundlers targeting the browser or an edge
// runtime (Next.js middleware, Vite) choke on those builtins as soon as the
// module is STATICALLY reachable from the package root — even when the builtin
// import inside it is itself dynamic. We therefore never import NodeFsStorage
// statically here: the Node branch returns a thin lazy proxy
// (LazyNodeFsStorage) that imports the real impl on first method call. In a
// real Node process this is transparent (all DurableStorage methods are async
// already); in a browser/edge bundle the Node module simply never enters the
// static graph. IndexedDBStorage is safe to import statically — it only touches
// the indexedDB global inside method bodies, no Node builtins.

import {
  isBrowserEnv,
  isNodeEnv,
  type DurableStorage,
  type DurableStorageOptions,
  type QueuedEvent,
} from './durable-storage.js';
import { IndexedDBStorage } from './indexeddb-storage.js';
import { InMemoryStorage } from './noop-storage.js';

export {
  type DurableStorage,
  type DurableStorageOptions,
  type QueuedEvent,
  DEFAULT_MAX_SIZE,
  isBrowserEnv,
  isNodeEnv,
} from './durable-storage.js';
export { IndexedDBStorage } from './indexeddb-storage.js';
export { InMemoryStorage } from './noop-storage.js';

/**
 * Lazy Node filesystem storage. Defers loading node-fs-storage.js (and thus
 * its Node-builtin imports) until the first storage operation, so the concrete
 * Node impl is reachable only via a dynamic import and never via the static
 * module graph. Keeps `createDurableStorage()` synchronous (it's called from
 * the `UsageReporter` constructor) while all real I/O stays async.
 */
class LazyNodeFsStorage implements DurableStorage {
  private readonly real: Promise<DurableStorage>;

  constructor(opts: DurableStorageOptions) {
    this.real = import('./node-fs-storage.js').then(
      (m) => new m.NodeFsStorage(opts),
    );
  }

  async enqueue(event: QueuedEvent): Promise<void> {
    return (await this.real).enqueue(event);
  }
  async peek(limit: number): Promise<QueuedEvent[]> {
    return (await this.real).peek(limit);
  }
  async remove(keys: string[]): Promise<void> {
    return (await this.real).remove(keys);
  }
  async markRetry(key: string, error: string): Promise<void> {
    return (await this.real).markRetry(key, error);
  }
  async size(): Promise<number> {
    return (await this.real).size();
  }
  async close(): Promise<void> {
    return (await this.real).close?.();
  }
}

export function createDurableStorage(opts: DurableStorageOptions = {}): DurableStorage {
  if (isBrowserEnv()) return new IndexedDBStorage(opts);
  if (isNodeEnv()) return new LazyNodeFsStorage(opts);
  return new InMemoryStorage(opts);
}
