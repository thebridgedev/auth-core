// Billing 2.0 US-19 (TBP-270) — IndexedDB-backed `DurableStorage` (browser).
//
// Single object store `usage_queue` keyed on `idempotencyKey`. Uses the raw
// IndexedDB API directly to avoid pulling `idb` (or any other dep) into
// auth-core's tree.
//
// Schema versioning: v1 — single store, key-path `idempotencyKey`. If we
// ever change shape we bump the DB version and add an `onupgradeneeded`
// migration. v1 is intentionally minimal.
//
// Concurrency: each call opens a fresh transaction. The DB handle is cached
// across calls (`_dbPromise`). IndexedDB itself serializes transactions.
//
// Tree-shake isolation: this file references `indexedDB` / `IDBDatabase`
// directly — bundlers MUST NOT include this in Node-only builds. The
// factory in `./index.ts` is the only consumer; `node-fs-storage.ts` lives
// in a sibling file so the two never share a module graph.

import {
  DEFAULT_MAX_SIZE,
  isBrowserEnv,
  type DurableStorage,
  type DurableStorageOptions,
  type QueuedEvent,
} from './durable-storage.js';

const DB_NAME = 'bridge-usage-queue';
const DB_VERSION = 1;
const STORE_NAME = 'usage_queue';

export class IndexedDBStorage implements DurableStorage {
  private _dbPromise?: Promise<IDBDatabase>;
  private maxSize: number;

  constructor(opts: DurableStorageOptions = {}) {
    if (!isBrowserEnv()) {
      throw new Error(
        '[bridge-usage] IndexedDBStorage requires a browser environment (window + indexedDB).',
      );
    }
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  }

  async enqueue(event: QueuedEvent): Promise<void> {
    const db = await this._db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // `put` upserts on the idempotencyKey — same key = same logical event.
      store.put(event);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('enqueue tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('enqueue tx aborted'));
    });
    await this._enforceMaxSize();
  }

  async peek(limit: number): Promise<QueuedEvent[]> {
    if (limit <= 0) return [];
    const db = await this._db();
    const events = await new Promise<QueuedEvent[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []) as QueuedEvent[]);
      req.onerror = () => reject(req.error ?? new Error('peek failed'));
    });
    return events.sort((a, b) => a.enqueuedAt - b.enqueuedAt).slice(0, limit);
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await this._db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const k of keys) store.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('remove tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('remove tx aborted'));
    });
  }

  async markRetry(key: string, error: string): Promise<void> {
    const db = await this._db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing = getReq.result as QueuedEvent | undefined;
        if (!existing) {
          resolve();
          return;
        }
        existing.retryCount = (existing.retryCount ?? 0) + 1;
        existing.lastError = error;
        store.put(existing);
      };
      getReq.onerror = () => reject(getReq.error ?? new Error('markRetry get failed'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('markRetry tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('markRetry tx aborted'));
    });
  }

  async size(): Promise<number> {
    const db = await this._db();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result ?? 0);
      req.onerror = () => reject(req.error ?? new Error('size failed'));
    });
  }

  configure(opts: { maxSize?: number }): void {
    if (typeof opts.maxSize === 'number' && opts.maxSize > 0) {
      this.maxSize = opts.maxSize;
    }
  }

  async close(): Promise<void> {
    if (!this._dbPromise) return;
    const db = await this._dbPromise;
    db.close();
    this._dbPromise = undefined;
  }

  private _db(): Promise<IDBDatabase> {
    if (!this._dbPromise) {
      this._dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'idempotencyKey' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
        req.onblocked = () =>
          reject(new Error('IndexedDB open blocked (another tab holds an older version)'));
      });
    }
    return this._dbPromise;
  }

  private async _enforceMaxSize(): Promise<void> {
    const currentSize = await this.size();
    if (currentSize <= this.maxSize) return;
    const overflow = currentSize - this.maxSize;
    // Read all, sort by enqueuedAt, drop the oldest N.
    const db = await this._db();
    const oldestKeys = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const all = ((req.result ?? []) as QueuedEvent[])
          .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
          .slice(0, overflow)
          .map((e) => e.idempotencyKey);
        resolve(all);
      };
      req.onerror = () => reject(req.error ?? new Error('enforceMaxSize getAll failed'));
    });
    if (oldestKeys.length === 0) return;
    await this.remove(oldestKeys);
    // eslint-disable-next-line no-console
    console.warn(
      `[bridge-usage] queue at max-size (${this.maxSize}); dropping oldest event`,
    );
  }
}
