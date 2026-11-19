import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { FlagSet } from '../../flags.js';
import { MANY_CHANGED, type LiveNotice } from '../../live.js';
import { clientOn, flush, issuerWithPeople, PASSWORD } from './helpers.js';

const evaluations = (fake: ReturnType<typeof issuerWithPeople>['fake']) => fake.requests.filter((request) => request.path.endsWith('/ofrep/v1/evaluate/flags'));

describe('flags: results only, over OFREP', () => {
  it('loads the signed-in person\'s results in one call, with their token and no rules', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ reports: true, theme: 'dark', seats: 5 });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    expect(client.flags.enabled('reports')).toBe(true);
    expect(client.flags.get('theme', 'light')).toBe('dark');
    expect(client.flags.get('seats', 0)).toBe(5);
    const last = evaluations(fake).at(-1)!;
    expect(last.path).toBe('/v2/flags/ofrep/v1/evaluate/flags');
    expect(last.headers['authorization']).toMatch(/^Bearer /);
    expect(last.body).toEqual({ context: {} });
  });

  it('fails closed: a missing flag, or one of another type, gives the fallback', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ theme: 'dark' });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    expect(client.flags.enabled('nope')).toBe(false);
    expect(client.flags.get('theme', false)).toBe(false);
    expect(client.flags.reason('nope').reason).toBe('FLAG_NOT_FOUND');
  });

  it('says why, and which plan feature would turn it on', () => {
    const set = new FlagSet(new Map([['reports', { key: 'reports', value: false, reason: 'TARGETING_MATCH', metadata: { why: 'plan feature reports is not held', entitlement: 'reports' } }]]));
    expect(set.reason('reports')).toEqual({ reason: 'TARGETING_MATCH', why: 'plan feature reports is not held', entitlement: 'reports' });
    const failed = new FlagSet(new Map([['x', { key: 'x', errorCode: 'PARSE_ERROR', errorDetails: 'bad' }]]));
    expect(failed.get('x', 'fallback')).toBe('fallback');
    expect(failed.reason('x')).toEqual({ reason: 'ERROR', why: 'bad', entitlement: null });
  });

  it('revalidates with the ETag: an unchanged answer is a 304 and keeps the results', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ reports: true });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    await client.flags.load();
    const signedInLoads = evaluations(fake).filter((request) => request.headers['authorization'] !== undefined);
    expect(signedInLoads[0]!.headers['if-none-match']).toBeUndefined();
    expect(signedInLoads.at(-1)!.headers['if-none-match']).toBe('"r2:' + fake.person('alice@acme.test')!.id + ':ws-acme"');
    expect(client.flags.enabled('reports')).toBe(true);
  });

  it('gives a visitor the app\'s public flags, with an anonymous id that stays', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({}, { banner: true });
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await client.ready;
    expect(client.flags.enabled('banner')).toBe(true);
    const visitor = evaluations(fake).at(-1)!;
    expect(visitor.path).toBe(`/v2/flags/apps/${fake.appId}/ofrep/v1/evaluate/flags`);
    expect(visitor.headers['authorization']).toBeUndefined();
    const id = (visitor.body as { context: { targetingKey: string } }).context.targetingKey;
    const again = clientOn(fake, { storage });
    await again.ready;
    expect((evaluations(fake).at(-1)!.body as { context: { targetingKey: string } }).context.targetingKey).toBe(id);
  });

  it('drops the results of the last person when the session changes', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ reports: true });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    await client.signOut();
    expect(client.flags.enabled('reports')).toBe(false);
  });

  it('sends hints as context, never as who the person is', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.setHints({ country: 'SE' });
    expect(evaluations(fake).at(-1)!.body).toEqual({ context: { country: 'SE' } });
  });

  it('keeps the results it has when a reload fails, and reports the error', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ reports: true });
    let failing = false;
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return failing && url.endsWith('/evaluate/flags') ? Promise.resolve(new Response(null, { status: 503 })) : fake.fetch(input, init);
    }) as typeof fetch;
    const client = clientOn(fake, { fetch: fetchFn });
    const errors: unknown[] = [];
    client.on('error', (error) => errors.push(error));
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    failing = true;
    await client.flags.load();
    expect(client.flags.enabled('reports')).toBe(true);
    expect(client.flags.status.get()).toBe('error');
    expect(errors).toHaveLength(1);
  });
});

describe('Live: notices over the socket, and history', () => {
  async function liveClient() {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake, { live: { websocket: fake.websocket as never } });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await until(() => client.live.status.get() === 'open');
    return { fake, client };
  }

  it('joins the channels Bridge names, with the token only in each subscribe frame', async () => {
    const { fake } = await liveClient();
    const socket = fake.sockets.at(-1)!;
    expect(socket.url).toBe('wss://live.bridge.test/event/realtime');
    const header = JSON.parse(Buffer.from(socket.protocols[1]!.slice('header-'.length), 'base64url').toString()) as Record<string, string>;
    expect(header).toEqual({ host: 'live-http.bridge.test', Authorization: 'anonymous' });
    const subscribes = socket.sent.filter((frame) => (frame as { type: string }).type === 'subscribe') as { channel: string; authorization: { Authorization: string } }[];
    expect(subscribes.map((frame) => frame.channel).sort()).toEqual([`/account/${fake.appId}/${fake.person('alice@acme.test')!.id}/1`, `/app/${fake.appId}`, `/workspace/${fake.appId}/ws-acme/1`].sort());
    for (const frame of subscribes) expect(frame.authorization.Authorization).toMatch(/^Bearer /);
  });

  it('delivers a notice, and fetches flags again when the flags changed', async () => {
    const { fake, client } = await liveClient();
    const heard: LiveNotice[] = [];
    client.live.on('*', (notice) => heard.push(notice));
    const before = evaluations(fake).length;
    fake.publish(`/app/${fake.appId}`, { type: 'flags.revision_changed', record: 'revisions/2' });
    await until(() => heard.length === 1 && evaluations(fake).length > before);
    expect(heard[0]).toMatchObject({ type: 'flags.revision_changed', record: 'revisions/2' });
  });

  it('follows a plan change: renews the token Bridge refuses after it, and asks again until the new results arrive', async () => {
    const { fake, client } = await liveClient();
    fake.setFlags({ reports: false });
    await client.flags.load();
    expect(client.flags.enabled('reports')).toBe(false);
    const before = evaluations(fake).length;
    const refreshes = () => fake.requests.filter((request) => request.path.endsWith('/token')).length;
    const renewalsBefore = refreshes();
    // Bridge saved the plan change: tokens issued before it are refused, and the results follow a moment after the notice.
    fake.refuseTokensSoFar();
    fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'billing.access_changed', record: 'payers/ws-acme', workspace: 'ws-acme' });
    setTimeout(() => fake.setFlags({ reports: true }), 300);
    await until(() => client.flags.enabled('reports'), 5_000);
    expect(refreshes()).toBeGreaterThan(renewalsBefore);
    // The first answer was the old one (a 304), so it asked again.
    expect(evaluations(fake).length - before).toBeGreaterThanOrEqual(3);
  });

  it('stops asking again once the answer after a plan change is new', async () => {
    const { fake, client } = await liveClient();
    await client.flags.load();
    const before = evaluations(fake).length;
    fake.setFlags({ reports: true });
    fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'billing.access_changed', record: 'payers/ws-acme', workspace: 'ws-acme' });
    await until(() => client.flags.enabled('reports'));
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(evaluations(fake).length - before).toBe(1);
  });

  it('joins again with a renewed token when its join is refused because the token predates a change', async () => {
    const { fake } = issuerWithPeople();
    // The change is saved between listing the person's channels and joining them, as a plan change can be.
    let refuseAfterListing = true;
    const fetchFn: typeof fake.fetch = async (input, init) => {
      const answer = await fake.fetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (refuseAfterListing && url.endsWith('/v2/live/channels')) {
        refuseAfterListing = false;
        fake.refuseTokensSoFar();
      }
      return answer;
    };
    const client = clientOn(fake, { fetch: fetchFn, live: { websocket: fake.websocket as never } });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    const heard: string[] = [];
    client.live.on('*', (notice) => heard.push(notice.type));
    await until(() => {
      fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'record.after' });
      return heard.includes('record.after');
    }, 5_000);
  });

  it('lists its channels again with a renewed token when the listing refuses a token that predates a change', async () => {
    const { fake, client } = await liveClient();
    fake.refuseTokensSoFar();
    // The socket drops: listing the channels again refuses the old token.
    const socket = fake.sockets.at(-1)!;
    socket.onclose?.();
    const heard: string[] = [];
    client.live.on('*', (notice) => heard.push(notice.type));
    await until(() => {
      if (fake.sockets.at(-1) !== socket) fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'record.after' });
      return heard.includes('record.after');
    }, 5_000);
  });

  it('fills a gap from history, in order and once', async () => {
    const { fake, client } = await liveClient();
    const heard: string[] = [];
    client.live.on('*', (notice) => heard.push(notice.type));
    const channel = `/workspace/${fake.appId}/ws-acme/1`;
    fake.publish(channel, { type: 'record.one' });
    await until(() => heard.length === 1);
    fake.publishSilently(channel, { type: 'record.two' });
    fake.publish(channel, { type: 'record.three' });
    await until(() => heard.length === 3);
    expect(heard).toEqual(['record.one', 'record.two', 'record.three']);
  });

  it('polls history when the issuer offers no socket yet', async () => {
    const { fake } = issuerWithPeople();
    fake.withoutLiveConnection();
    const client = clientOn(fake, { live: { websocket: fake.websocket as never, pollMs: 10 } });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await until(() => client.live.status.get() === 'polling');
    const heard: string[] = [];
    client.live.on('*', (notice) => heard.push(notice.type));
    fake.publishSilently(`/app/${fake.appId}`, { type: 'flags.revision_changed' });
    await until(() => heard.length === 1);
    expect(fake.sockets).toHaveLength(0);
    client.destroy();
  });

  it('tells screens to fetch again when history cannot fill a gap, and joins afresh', async () => {
    const { fake, client } = await liveClient();
    const heard: string[] = [];
    client.live.on('*', (notice) => heard.push(notice.type));
    const channel = `/workspace/${fake.appId}/ws-acme/1`;
    fake.publish(channel, { type: 'record.one' });
    await until(() => heard.length === 1);
    const listed = fake.requests.filter((request) => request.path === '/v2/live/channels').length;
    fake.publishSilently(channel, { type: 'record.lost' });
    fake.loseHistory(channel);
    fake.publish(channel, { type: 'record.three' });
    await until(() => heard.includes(MANY_CHANGED) && fake.requests.filter((request) => request.path === '/v2/live/channels').length > listed);
    expect(heard).not.toContain('record.lost');
    client.destroy();
  });

  it('treats a notice it cannot read as "something changed": screens and flags fetch again, nothing is dropped silently', async () => {
    const { fake, client } = await liveClient();
    const heard: string[] = [];
    client.live.on('*', (notice) => heard.push(notice.type));
    const channel = `/workspace/${fake.appId}/ws-acme/1`;
    fake.publish(channel, { type: 'record.one' });
    await until(() => heard.length === 1);
    const loads = evaluations(fake).length;
    fake.sendUnreadable(channel, { seq: 'two', shape: 'from a newer Bridge' });
    fake.sendUnreadable(channel, 'not json');
    await until(() => heard.filter((type) => type === MANY_CHANGED).length === 2 && evaluations(fake).length > loads);
    // The next readable notice is delivered as usual.
    fake.publish(channel, { type: 'record.two' });
    await until(() => heard.includes('record.two'));
    client.destroy();
  });

  it('stops for good on destroy', async () => {
    const { fake, client } = await liveClient();
    client.destroy();
    await flush();
    expect(client.live.status.get()).toBe('closed');
    expect(fake.sockets).toHaveLength(0);
  });
});

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
