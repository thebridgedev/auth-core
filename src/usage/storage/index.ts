// Billing 2.0 US-19 (TBP-270) — Durable storage factory.
//
// Auto-selects the correct backend for the current runtime:
//   - browser → IndexedDBStorage
//   - Node    → NodeFsStorage
//   - else    → InMemoryStorage (SSR / edge fallback)
//
// Tree-shake note: this file imports BOTH browser and Node impls, but each
// impl encapsulates its env-specific code (Node uses dynamic `import()` for
// `node:fs/promises`, browser uses `indexedDB` only inside method bodies).
// Static analysis can prove the unreachable branches dead in production
// bundles.

import {
  isBrowserEnv,
  isNodeEnv,
  type DurableStorage,
  type DurableStorageOptions,
} from './durable-storage.js';
import { IndexedDBStorage } from './indexeddb-storage.js';
import { NodeFsStorage } from './node-fs-storage.js';
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
export { NodeFsStorage } from './node-fs-storage.js';
export { InMemoryStorage } from './noop-storage.js';

export function createDurableStorage(opts: DurableStorageOptions = {}): DurableStorage {
  if (isBrowserEnv()) return new IndexedDBStorage(opts);
  if (isNodeEnv()) return new NodeFsStorage(opts);
  return new InMemoryStorage(opts);
}
