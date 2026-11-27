/// <reference types="node" />
/**
 * @nebulr-group/bridge-auth-core/server/node
 *
 * A file for the usage queue, so counted usage survives a crash or a restart
 * of a long-running Node server:
 *
 * ```ts
 * import { createBridgeServer } from '@nebulr-group/bridge-auth-core/server';
 * import { fileUsageQueue } from '@nebulr-group/bridge-auth-core/server/node';
 *
 * const bridge = createBridgeServer({
 *   issuer,
 *   appKey,
 *   usageStore: fileUsageQueue({ dir: '/var/lib/my-app/bridge-usage' }),
 * });
 * ```
 *
 * It is a journal: one line for each report kept and one for each batch
 * forgotten, appended as they happen, so a process that dies loses nothing it
 * had counted. A last line cut off by the crash is ignored. When the server
 * starts the journal is read, rewritten with only what still waits, and what
 * waits is sent with the ids it was counted with, so a report that went out just
 * before the crash and goes out again counts once.
 *
 * One process owns a directory: give each process of the app its own. It is
 * for a server that keeps its disk. On a platform whose disk does not outlive
 * the process (functions, containers without a volume) pass a `usageStore` of
 * your own that writes to something that does.
 *
 * And `bridgeMcpMiddleware`, the MCP guard for Node's `http` server and
 * Express-style apps (see the end of this file).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QueuedUsageReport, UsageQueueStore } from './index.js';
import type { McpCaller, McpGuard, McpRefusal } from './mcp.js';

export interface FileUsageQueueOptions {
  /** The directory that holds the queue. It is made when it does not exist. */
  readonly dir: string;
  /** The file's name inside it. @default 'usage-queue.jsonl' */
  readonly fileName?: string;
}

/** The journal is rewritten with only what waits once this many lines more than that have piled up. */
const COMPACT_AFTER = 1000;

/** A {@link UsageQueueStore} whose calls finish at once: the file is written before each returns. */
export interface FileUsageQueue extends UsageQueueStore {
  load(): readonly QueuedUsageReport[];
  add(reports: readonly QueuedUsageReport[]): void;
  remove(ids: readonly string[]): void;
}

export function fileUsageQueue(options: FileUsageQueueOptions): FileUsageQueue {
  if (typeof options.dir !== 'string' || options.dir === '') throw new Error('fileUsageQueue needs a directory: pass `dir`.');
  const file = join(options.dir, options.fileName ?? 'usage-queue.jsonl');
  const waiting = new Map<string, QueuedUsageReport>();
  let lines = 0;
  let loaded = false;

  /** Writes only what waits, whole or not at all: the new file is renamed over the old one. */
  function compact(): void {
    const temporary = `${file}.${String(process.pid)}.tmp`;
    const text = [...waiting.values()].map((report) => `${JSON.stringify({ a: report })}\n`).join('');
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
    lines = waiting.size;
  }

  function append(entries: readonly object[]): void {
    if (entries.length === 0) return;
    if (!loaded) load();
    appendFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    lines += entries.length;
    if (lines > waiting.size + COMPACT_AFTER) compact();
  }

  function load(): readonly QueuedUsageReport[] {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    waiting.clear();
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let entry: { a?: QueuedUsageReport; d?: unknown };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        // The line a crash cut off.
        continue;
      }
      if (entry.a !== undefined && entry.a !== null && typeof entry.a === 'object' && typeof entry.a.id === 'string') waiting.set(entry.a.id, entry.a);
      else if (Array.isArray(entry.d)) for (const id of entry.d) if (typeof id === 'string') waiting.delete(id);
    }
    loaded = true;
    compact();
    return [...waiting.values()];
  }

  return {
    load,
    add(reports) {
      if (!loaded) load();
      for (const report of reports) waiting.set(report.id, report);
      append(reports.map((report) => ({ a: report })));
    },
    remove(ids) {
      if (!loaded) load();
      const known = ids.filter((id) => waiting.has(id));
      for (const id of known) waiting.delete(id);
      append(known.length === 0 ? [] : [{ d: known }]);
    },
  };
}

/** A Node request the MCP middleware has let through: the caller is on it. */
export type McpIncomingMessage = IncomingMessage & { bridge?: { readonly caller: McpCaller }; auth?: McpAuthInfo };

/** The shape the official MCP SDK reads from `req.auth` and hands to tools as `extra.authInfo`. */
export interface McpAuthInfo {
  readonly token: string;
  readonly clientId: string;
  readonly scopes: string[];
  readonly expiresAt?: number;
  readonly resource?: URL;
  readonly extra: { readonly caller: McpCaller };
}

/** Writes a refusal (401 with `WWW-Authenticate`, or 503) to a Node response. */
export function writeMcpRefusal(res: ServerResponse, refusal: McpRefusal): void {
  res.statusCode = refusal.status;
  for (const [name, value] of Object.entries(refusal.headers)) res.setHeader(name, value);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  res.end(JSON.stringify(refusal.body));
}

/** Writes the endpoint's protected-resource metadata to a Node response. */
export function writeMcpMetadata(res: ServerResponse, guard: McpGuard, method = 'GET'): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(method.toUpperCase() === 'HEAD' ? undefined : JSON.stringify(guard.metadata()));
}

/**
 * The MCP guard as Node middleware, `(req, res, next)`, for Node's `http`
 * server and Express-style apps. Mount it in front of the MCP endpoint and of
 * the well-known paths (or app-wide):
 *
 * - a GET to one of `guard.metadataPaths` is answered with the metadata;
 * - a call without a valid token is answered 401 with `WWW-Authenticate`
 *   (503 while Bridge cannot be checked) and `next` is not called;
 * - otherwise `req.bridge.caller` is the caller, `req.auth` is set for the
 *   official MCP SDK (tools read it as `extra.authInfo.extra.caller`), and
 *   `next()` runs.
 */
export function bridgeMcpMiddleware(guard: McpGuard) {
  return async (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): Promise<void> => {
    try {
      if (guard.isMetadataRequest({ method: req.method, url: req.url })) {
        writeMcpMetadata(res, guard, req.method);
        return;
      }
      const answer = await guard.check(req);
      if (!answer.ok) {
        writeMcpRefusal(res, answer.refusal);
        return;
      }
      const caller = answer.caller;
      const request = req as McpIncomingMessage;
      request.bridge = Object.freeze({ caller });
      request.auth = Object.freeze({
        token: answer.token,
        clientId: caller.client.id ?? caller.appId,
        scopes: [...caller.scopes],
        ...(caller.expiresAt === null ? {} : { expiresAt: caller.expiresAt }),
        resource: new URL(guard.resource),
        extra: Object.freeze({ caller }),
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
