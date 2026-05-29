// Billing 2.0 US-19 (TBP-270) — Filesystem-backed `DurableStorage` (Node).
//
// Stores the queue as JSON Lines (`.jsonl`) under a configurable directory
// (default `~/.bridge/usage-queue/queue.jsonl`).
//
// Design choices (v1):
//   - Append-only writes for `enqueue` (cheap, durable).
//   - `remove` rewrites the whole file without the removed keys. Acceptable
//     for v1 — the queue rarely exceeds a few KB in practice. If it ever
//     gets large enough that rewrites hurt, we can switch to SQLite (better-
//     sqlite3) or a tombstone scheme.
//   - `peek` reads + parses the file each call. Same v1 trade-off.
//   - Concurrency safety inside a single process: an in-memory promise chain
//     serializes all writes. We do NOT attempt multi-process locking — bridge
//     SDK consumers run a single process per app instance.
//
// Tree-shake isolation: this file uses `node:fs/promises` and `node:path` via
// `await import()` so bundlers that target the browser can statically prove
// the module never executes the imports. The IndexedDB sibling never reaches
// into this file's graph.

import {
  DEFAULT_MAX_SIZE,
  isNodeEnv,
  type DurableStorage,
  type DurableStorageOptions,
  type QueuedEvent,
} from './durable-storage.js';

type FsModule = typeof import('node:fs/promises');
type PathModule = typeof import('node:path');
type OsModule = typeof import('node:os');

export class NodeFsStorage implements DurableStorage {
  private maxSize: number;
  private dirPromise?: Promise<string>;
  private writeChain: Promise<unknown> = Promise.resolve();
  private fsP?: Promise<FsModule>;
  private pathP?: Promise<PathModule>;
  private osP?: Promise<OsModule>;
  private readonly explicitDir?: string;

  constructor(opts: DurableStorageOptions = {}) {
    if (!isNodeEnv()) {
      throw new Error(
        '[bridge-usage] NodeFsStorage requires a Node environment (process.versions.node).',
      );
    }
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    this.explicitDir = opts.nodeDir;
  }

  async enqueue(event: QueuedEvent): Promise<void> {
    await this._serialize(async () => {
      const { fs, file } = await this._files();
      const line = JSON.stringify(event) + '\n';
      await fs.appendFile(file, line, 'utf8');
      await this._enforceMaxSizeLocked();
    });
  }

  async peek(limit: number): Promise<QueuedEvent[]> {
    if (limit <= 0) return [];
    const events = await this._readAll();
    return events.sort((a, b) => a.enqueuedAt - b.enqueuedAt).slice(0, limit);
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const dropSet = new Set(keys);
    await this._serialize(async () => {
      const { fs, file } = await this._files();
      const events = await this._readAll();
      const kept = events.filter((e) => !dropSet.has(e.idempotencyKey));
      const body = kept.map((e) => JSON.stringify(e)).join('\n');
      await fs.writeFile(file, body.length > 0 ? body + '\n' : '', 'utf8');
    });
  }

  async markRetry(key: string, error: string): Promise<void> {
    await this._serialize(async () => {
      const { fs, file } = await this._files();
      const events = await this._readAll();
      let touched = false;
      for (const e of events) {
        if (e.idempotencyKey === key) {
          e.retryCount = (e.retryCount ?? 0) + 1;
          e.lastError = error;
          touched = true;
        }
      }
      if (!touched) return;
      const body = events.map((e) => JSON.stringify(e)).join('\n');
      await fs.writeFile(file, body.length > 0 ? body + '\n' : '', 'utf8');
    });
  }

  async size(): Promise<number> {
    const events = await this._readAll();
    return events.length;
  }

  configure(opts: { maxSize?: number }): void {
    if (typeof opts.maxSize === 'number' && opts.maxSize > 0) {
      this.maxSize = opts.maxSize;
    }
  }

  async close(): Promise<void> {
    // No persistent handles to close — we open/close on each call.
    await this.writeChain.catch(() => undefined);
  }

  // --- internals ---

  private _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    // Keep the chain rejection-tolerant so one failure doesn't poison the queue.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async _readAll(): Promise<QueuedEvent[]> {
    const { fs, file } = await this._files();
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    if (!raw) return [];
    const out: QueuedEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as QueuedEvent;
        if (
          parsed &&
          typeof parsed.idempotencyKey === 'string' &&
          typeof parsed.metric === 'string'
        ) {
          out.push(parsed);
        }
      } catch {
        // Skip malformed lines — better to lose one event than block the queue.
      }
    }
    return out;
  }

  private async _enforceMaxSizeLocked(): Promise<void> {
    const events = await this._readAll();
    if (events.length <= this.maxSize) return;
    const sorted = events.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const kept = sorted.slice(sorted.length - this.maxSize);
    const { fs, file } = await this._files();
    const body = kept.map((e) => JSON.stringify(e)).join('\n');
    await fs.writeFile(file, body.length > 0 ? body + '\n' : '', 'utf8');
    // eslint-disable-next-line no-console
    console.warn(
      `[bridge-usage] queue at max-size (${this.maxSize}); dropping oldest event`,
    );
  }

  private async _files(): Promise<{ fs: FsModule; file: string }> {
    const fs = await this._fs();
    const dir = await this._dir();
    const path = await this._path();
    return { fs, file: path.join(dir, 'queue.jsonl') };
  }

  private _fs(): Promise<FsModule> {
    if (!this.fsP) this.fsP = import('node:fs/promises');
    return this.fsP;
  }

  private _path(): Promise<PathModule> {
    if (!this.pathP) this.pathP = import('node:path');
    return this.pathP;
  }

  private _os(): Promise<OsModule> {
    if (!this.osP) this.osP = import('node:os');
    return this.osP;
  }

  private _dir(): Promise<string> {
    if (!this.dirPromise) {
      this.dirPromise = (async () => {
        const fs = await this._fs();
        const path = await this._path();
        const os = await this._os();
        const dir = this.explicitDir ?? path.join(os.homedir(), '.bridge', 'usage-queue');
        await fs.mkdir(dir, { recursive: true });
        return dir;
      })();
    }
    return this.dirPromise;
  }
}
