import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeServer, type Actor, type BridgeServerOptions, type QueuedUsageReport, type UsageQueueStore } from '../../server/index.js';
import { fileUsageQueue } from '../../server/node.js';

/**
 * Usage that waits to be reported survives a crash or a restart, and still counts once: a report keeps the id it was
 * counted with, and Bridge counts each id once.
 */

const ORIGIN = 'https://bridge.test';
const ISSUER = `${ORIGIN}/identity-access/apps/app-1`;
const DAY = 86_400_000;

const actor: Actor = { kind: 'person', id: 'usr-1', personId: 'usr-1', workspaceId: 'ws-1', sessionId: 'ses-1', appId: 'app-1', standing: 'active' };

/** A Bridge that counts each report id once, as it does, and can be told to fail or refuse. */
function fakeBridge() {
  const counted = new Map<string, number>();
  const sent: string[][] = [];
  const bridge = {
    counted,
    sent,
    mode: 'ok' as 'ok' | 'down' | 'refuse',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: ISSUER,
          token_endpoint: `${ORIGIN}/v2/identity-access/apps/app-1/token`,
          authorization_challenge_endpoint: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`,
          bridge_app: 'app-1',
          bridge_api_version: 2,
          bridge_endpoints: { '2': { sign_in: `${ORIGIN}/v2/identity-access/apps/app-1/sign-in`, token: `${ORIGIN}/v2/identity-access/apps/app-1/token`, accounts: `${ORIGIN}/v2/accounts`, billing: `${ORIGIN}/v2/billing` } },
        });
      }
      if (request.url === `${ORIGIN}/v2/billing/usage`) {
        if (bridge.mode === 'down') return new Response(null, { status: 503 });
        if (bridge.mode === 'refuse') return new Response(JSON.stringify({ title: 'Bad', status: 400, detail: 'no' }), { status: 400, headers: { 'content-type': 'application/json' } });
        const { reports } = (await request.json()) as { reports: { id: string; quantity: number }[] };
        sent.push(reports.map((report) => report.id));
        for (const report of reports) if (!counted.has(report.id)) counted.set(report.id, report.quantity);
        return Response.json({ counted: reports.length });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  return bridge;
}

/** A store in memory that outlives the server using it, as a file does. */
function memoryStore(held: QueuedUsageReport[] = []) {
  const calls: string[] = [];
  const store: UsageQueueStore & { held: QueuedUsageReport[]; calls: string[]; failAdds?: boolean; dropRemoves?: boolean } = {
    held,
    calls,
    load: () => [...held],
    add(reports) {
      if (store.failAdds === true) throw new Error('disk full');
      calls.push(`add ${reports.map((report) => report.id).join(',')}`);
      held.push(...reports);
    },
    remove(ids) {
      calls.push(`remove ${ids.join(',')}`);
      // A crash between Bridge taking a batch and the store hearing of it: nothing is removed.
      if (store.dropRemoves === true) return;
      for (const id of ids) {
        const at = held.findIndex((report) => report.id === id);
        if (at !== -1) held.splice(at, 1);
      }
    },
  };
  return store;
}

function serverOn(bridge: ReturnType<typeof fakeBridge>, store: UsageQueueStore | undefined, extra: Partial<BridgeServerOptions> = {}) {
  const logs: string[] = [];
  const server = createBridgeServer({
    issuer: ISSUER,
    fetch: bridge.fetch,
    appKey: 'app-key-1',
    usageFlushMs: 60_000,
    ...(store === undefined ? {} : { usageStore: store }),
    log: (message) => logs.push(message),
    ...extra,
  });
  return { server, logs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
/** Sends what waits, and gives the store's own calls (made in order, after the send) the moment they need. */
async function flushed(server: { usage: { flush(): Promise<void> } }): Promise<void> {
  await server.usage.flush();
  await settle();
}

describe('usage queue: reports survive a crash', () => {
  it('keeps what could not be sent, and a new process sends it with the same ids', async () => {
    const bridge = fakeBridge();
    const store = memoryStore();
    bridge.mode = 'down';
    const first = serverOn(bridge, store);
    first.server.usage.count(actor, 'api.calls', 2, { id: 'r-1' });
    first.server.usage.count(actor, 'exports', 1, { id: 'r-2' });
    await flushed(first.server);
    expect(first.server.usage.pending()).toBe(2);
    expect(store.held.map((report) => report.id)).toEqual(['r-1', 'r-2']);
    // The process dies here: no close(), no flush.
    bridge.mode = 'ok';
    const second = serverOn(bridge, store);
    await flushed(second.server);
    expect(bridge.sent).toEqual([['r-1', 'r-2']]);
    expect([...bridge.counted]).toEqual([['r-1', 2], ['r-2', 1]]);
    expect(store.held).toEqual([]);
    expect(second.server.usage.pending()).toBe(0);
    await second.server.close();
  });

  it('counts once when the crash came after Bridge took a batch and before the store heard of it', async () => {
    const bridge = fakeBridge();
    const store = memoryStore();
    store.dropRemoves = true;
    const first = serverOn(bridge, store);
    first.server.usage.count(actor, 'api.calls', 5, { id: 'r-1' });
    await flushed(first.server);
    expect(bridge.counted.get('r-1')).toBe(5);
    expect(store.held.map((report) => report.id)).toEqual(['r-1']);
    const second = serverOn(bridge, store);
    await flushed(second.server);
    // Sent again under the same id, and counted once.
    expect(bridge.sent).toEqual([['r-1'], ['r-1']]);
    expect(bridge.counted.size).toBe(1);
    expect(bridge.counted.get('r-1')).toBe(5);
    await second.server.close();
  });

  it('sends the reports from before the start ahead of the new ones', async () => {
    const bridge = fakeBridge();
    const store = memoryStore([{ id: 'old-1', metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date().toISOString() }]);
    const { server } = serverOn(bridge, store);
    server.usage.count(actor, 'api.calls', 1, { id: 'new-1' });
    await flushed(server);
    expect(bridge.sent).toEqual([['old-1', 'new-1']]);
    expect(store.held).toEqual([]);
    await server.close();
  });

  it('keeps a batch Bridge could not take, forgets one it refused for good', async () => {
    const bridge = fakeBridge();
    const store = memoryStore();
    const { server, logs } = serverOn(bridge, store);
    bridge.mode = 'down';
    server.usage.count(actor, 'api.calls', 1, { id: 'r-1' });
    await flushed(server);
    expect(store.held).toHaveLength(1);
    bridge.mode = 'refuse';
    await flushed(server);
    expect(store.held).toEqual([]);
    expect(logs.some((line) => line.includes('refused'))).toBe(true);
    await server.close();
  });

  it('keeps only the newest level of a gauge, in memory and in the store', async () => {
    const bridge = fakeBridge();
    const store = memoryStore();
    const { server } = serverOn(bridge, store);
    bridge.mode = 'down';
    server.usage.set(actor, 'projects', 3, { id: 'lvl-1' });
    server.usage.set(actor, 'projects', 5, { id: 'lvl-2' });
    await flushed(server);
    expect(store.held.map((report) => report.id)).toEqual(['lvl-2']);
    await server.close();
  });

  it('keeps only the newest of several levels it finds in the store', async () => {
    const bridge = fakeBridge();
    const time = new Date().toISOString();
    const store = memoryStore([
      { id: 'lvl-1', metric: 'projects', quantity: 3, workspace: 'ws-1', time, level: true },
      { id: 'lvl-2', metric: 'projects', quantity: 5, workspace: 'ws-1', time, level: true },
    ]);
    const { server } = serverOn(bridge, store);
    await flushed(server);
    expect(bridge.sent).toEqual([['lvl-2']]);
    expect(store.held).toEqual([]);
    await server.close();
  });

  it('drops what waited past Bridge\'s one-time ids, and what is not a report, and says so', async () => {
    const bridge = fakeBridge();
    const now = Date.now();
    const store = memoryStore([
      { id: 'ancient', metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date(now - 31 * DAY).toISOString() },
      { id: 'fresh', metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date(now - 29 * DAY).toISOString() },
      { id: 'bad-metric', metric: 'Not A Metric', quantity: 1, workspace: 'ws-1', time: new Date(now).toISOString() },
      { id: 'bad-quantity', metric: 'api.calls', quantity: -4, workspace: 'ws-1', time: new Date(now).toISOString() },
      { id: 'bad-time', metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: 'yesterday' },
    ]);
    const { server, logs } = serverOn(bridge, store);
    await flushed(server);
    expect(bridge.sent).toEqual([['fresh']]);
    expect(store.held).toEqual([]);
    expect(logs.some((line) => line.includes('not kept'))).toBe(true);
    await server.close();
  });

  it('never waits longer than 34 days, whatever is asked', async () => {
    const bridge = fakeBridge();
    const store = memoryStore([{ id: 'old', metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date(Date.now() - 34.5 * DAY).toISOString() }]);
    const { server } = serverOn(bridge, store, { maxQueuedAgeMs: 100 * DAY });
    await flushed(server);
    expect(bridge.sent).toEqual([]);
    await server.close();
  });

  it('a report that waits past the age while the process runs is dropped, not sent', async () => {
    const bridge = fakeBridge();
    const store = memoryStore();
    const { server, logs } = serverOn(bridge, store, { maxQueuedAgeMs: 5 });
    server.usage.count(actor, 'api.calls', 1, { id: 'r-1' });
    await settle();
    await flushed(server);
    expect(bridge.sent).toEqual([]);
    expect(store.held).toEqual([]);
    expect(logs.some((line) => line.includes('waited too long'))).toBe(true);
    await server.close();
  });

  it('forgets the oldest report a full queue drops, in the store too', async () => {
    const bridge = fakeBridge();
    bridge.mode = 'down';
    const store = memoryStore();
    const { server } = serverOn(bridge, store, { maxQueuedReports: 2 });
    for (const id of ['r-1', 'r-2', 'r-3']) server.usage.count(actor, 'api.calls', 1, { id });
    await flushed(server);
    expect(store.held.map((report) => report.id)).toEqual(['r-2', 'r-3']);
    await server.close();
  });

  it('counts on, and says so, when the store cannot keep a report or be read', async () => {
    const bridge = fakeBridge();
    const store = memoryStore();
    store.failAdds = true;
    const { server, logs } = serverOn(bridge, store);
    server.usage.count(actor, 'api.calls', 1, { id: 'r-1' });
    await flushed(server);
    expect(bridge.counted.get('r-1')).toBe(1);
    expect(logs.some((line) => line.includes('could not keep reports'))).toBe(true);
    await server.close();
    const broken = serverOn(bridge, { load: () => Promise.reject(new Error('unreadable')), add: () => undefined, remove: () => undefined });
    broken.server.usage.count(actor, 'api.calls', 1, { id: 'r-9' });
    await flushed(broken.server);
    expect(bridge.counted.get('r-9')).toBe(1);
    expect(broken.logs.some((line) => line.includes('could not be read'))).toBe(true);
    await broken.server.close();
  });

  it('without a store the queue is in memory, as before', async () => {
    const bridge = fakeBridge();
    const { server } = serverOn(bridge, undefined);
    server.usage.count(actor, 'api.calls', 1, { id: 'r-1' });
    await flushed(server);
    expect(bridge.sent).toEqual([['r-1']]);
    await server.close();
  });
});

describe('usage queue: the file', () => {
  const dirs: string[] = [];
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-usage-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps reports across a restart, and forgets what was sent', async () => {
    const dir = fresh();
    const bridge = fakeBridge();
    bridge.mode = 'down';
    const first = serverOn(bridge, fileUsageQueue({ dir }));
    first.server.usage.count(actor, 'api.calls', 4, { id: 'r-1' });
    first.server.usage.set(actor, 'projects', 9, { id: 'lvl-1' });
    await flushed(first.server);
    await settle();
    const file = join(dir, 'usage-queue.jsonl');
    expect(readFileSync(file, 'utf8')).toContain('"r-1"');
    bridge.mode = 'ok';
    const second = serverOn(bridge, fileUsageQueue({ dir }));
    await flushed(second.server);
    await second.server.close();
    expect(bridge.sent).toEqual([['r-1', 'lvl-1']]);
    const third = serverOn(bridge, fileUsageQueue({ dir }));
    await flushed(third.server);
    expect(bridge.sent).toHaveLength(1);
    // Read again, the journal is rewritten with only what waits: nothing.
    expect(readFileSync(file, 'utf8')).toBe('');
    await third.server.close();
  });

  it('ignores a last line the crash cut off, and keeps the file private', () => {
    const dir = fresh();
    const file = join(dir, 'usage-queue.jsonl');
    const report = { id: 'r-1', metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date().toISOString() };
    writeFileSync(file, `${JSON.stringify({ a: report })}\n{"a":{"id":"r-2","metr`, { mode: 0o644 });
    const store = fileUsageQueue({ dir });
    expect(store.load()).toEqual([report]);
    expect(statSync(file).mode & 0o077).toBe(0);
    // A later write is whole lines again.
    store.add([{ ...report, id: 'r-3' }]);
    expect(fileUsageQueue({ dir }).load().map((each) => each.id)).toEqual(['r-1', 'r-3']);
  });

  it('replays adds and removes in order, and rewrites the file with only what waits', () => {
    const dir = fresh();
    const file = join(dir, 'usage-queue.jsonl');
    const at = (id: string) => ({ id, metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date().toISOString() });
    const store = fileUsageQueue({ dir });
    store.load();
    store.add([at('a'), at('b'), at('c')]);
    store.remove(['b']);
    appendFileSync(file, '\n');
    const reopened = fileUsageQueue({ dir });
    expect(reopened.load().map((each) => each.id)).toEqual(['a', 'c']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('rewrites the file once enough lines are only history, so it never grows without end', () => {
    const dir = fresh();
    const file = join(dir, 'usage-queue.jsonl');
    const store = fileUsageQueue({ dir });
    store.load();
    for (let n = 0; n < 1200; n += 1) {
      const report = { id: `r-${String(n)}`, metric: 'api.calls', quantity: 1, workspace: 'ws-1', time: new Date().toISOString() };
      store.add([report]);
      store.remove([report.id]);
    }
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).length).toBeLessThan(1100);
    expect(fileUsageQueue({ dir }).load()).toEqual([]);
  });

  it('needs a directory', () => {
    expect(() => fileUsageQueue({ dir: '' })).toThrowError(/directory/);
  });
});
