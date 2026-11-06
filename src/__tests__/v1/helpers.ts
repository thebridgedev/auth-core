import { createBridge, type BridgeOptions } from '../../bridge.js';
import { memoryStorage, type BridgeStorage } from '../../core/storage.js';
import type { ChannelLike, LockManagerLike } from '../../session.js';
import { createFakeIssuer, type FakeIssuerOptions } from '../../testing/index.js';

export const PASSWORD = 'correct horse battery';

/** A fake issuer with one person in one workspace, and one in two. */
export function issuerWithPeople(options: FakeIssuerOptions = {}) {
  const fake = createFakeIssuer(options);
  const alice = fake.addPerson({ email: 'alice@acme.test', password: PASSWORD, firstName: 'Alice', workspaces: [{ id: 'ws-acme', name: 'Acme', role: 'OWNER' }] });
  const bob = fake.addPerson({
    email: 'bob@acme.test',
    password: PASSWORD,
    workspaces: [
      { id: 'ws-acme', name: 'Acme' },
      { id: 'ws-globex', name: 'Globex' },
    ],
  });
  return { fake, alice, bob };
}

/** A client on the fake issuer: memory storage, no timers, no other tabs, no Live unless asked. */
export function clientOn(fake: ReturnType<typeof createFakeIssuer>, options: Partial<BridgeOptions> = {}) {
  return createBridge({
    issuer: fake.issuer,
    fetch: fake.fetch,
    storage: memoryStorage(),
    autoRefresh: false,
    locks: null,
    tabChannel: null,
    live: false,
    ...options,
  });
}

/** Web Locks for tabs of one test: one holder at a time per name. */
export function sharedLocks(): LockManagerLike & { held: string[] } {
  const tails = new Map<string, Promise<unknown>>();
  const held: string[] = [];
  return {
    held,
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const before = tails.get(name) ?? Promise.resolve();
      const run = before.then(async () => {
        held.push(name);
        try {
          return await callback();
        } finally {
          held.splice(held.indexOf(name), 1);
        }
      });
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

/** A BroadcastChannel for tabs of one test: a message reaches every other channel of the same name. */
export function sharedChannels(): (name: string) => ChannelLike {
  const open = new Set<{ name: string; channel: ChannelLike }>();
  return (name) => {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage(message: unknown) {
        const copy = structuredClone(message);
        for (const other of open) if (other.channel !== channel && other.name === name) queueMicrotask(() => other.channel.onmessage?.({ data: copy }));
      },
      close() {
        for (const each of open) if (each.channel === channel) open.delete(each);
      },
    };
    open.add({ name, channel });
    return channel;
  };
}

/** Two tabs of one browser: shared storage, locks and channel. */
export function twoTabs(fake: ReturnType<typeof createFakeIssuer>, options: Partial<BridgeOptions> = {}) {
  const storage: BridgeStorage = memoryStorage();
  const locks = sharedLocks();
  const channel = sharedChannels();
  const tab = () => clientOn(fake, { storage, locks, tabChannel: channel, ...options });
  return { storage, locks, first: tab(), second: tab(), another: tab };
}

export function tokenCalls(fake: ReturnType<typeof createFakeIssuer>, grant?: string) {
  return fake.requests.filter((request) => request.path.endsWith('/token') && (grant === undefined || (request.body as { grant_type?: string }).grant_type === grant));
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The body a request was sent with, as an object. */
export function bodyOf(init?: RequestInit): Record<string, unknown> {
  try {
    return typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** A fetch that holds refresh grants until released, to put a refresh in flight. */
export function holdingRefreshes(fake: ReturnType<typeof createFakeIssuer>) {
  let hold = false;
  let release: () => void = () => undefined;
  let held = Promise.resolve();
  let waiting = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (hold && urlOf(input).endsWith('/token') && bodyOf(init)['grant_type'] === 'refresh_token') {
      waiting += 1;
      await held;
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    hold() {
      hold = true;
      held = new Promise<void>((resolve) => (release = resolve));
    },
    release() {
      hold = false;
      release();
    },
    get waiting() {
      return waiting;
    },
  };
}
