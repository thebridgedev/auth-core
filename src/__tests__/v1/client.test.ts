import { afterEach, describe, expect, it } from 'vitest';
import { clientOn, issuerWithPeople, PASSWORD, urlOf } from './helpers.js';

describe('createBridge: a failed start is tried again, never kept', () => {
  it('rejects ready with the reason, and a later call starts it', async () => {
    const { fake } = issuerWithPeople();
    let down = true;
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
      down && urlOf(input).endsWith('/.well-known/openid-configuration') ? Promise.reject(new TypeError('offline')) : fake.fetch(input, init)) as typeof fetch;
    const client = clientOn(fake, { fetch: fetchFn });
    const started: string[] = [];
    client.on('ready', ({ issuer }) => started.push(issuer));
    await expect(client.ready).rejects.toMatchObject({ kind: 'network' });
    expect(client.session.get().status).toBe('loading');
    expect(client.flags.enabled('anything')).toBe(false);
    down = false;
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
    expect(started).toEqual([fake.issuer]);
    expect(client.session.get().status).toBe('signed-in');
    client.destroy();
  });

  it('a call made while Bridge is still unreachable fails with the reason instead of hanging', async () => {
    const { fake } = issuerWithPeople();
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).endsWith('/.well-known/openid-configuration') ? Promise.resolve(new Response(null, { status: 503 })) : fake.fetch(input, init)) as typeof fetch;
    const client = clientOn(fake, { fetch: fetchFn });
    await expect(client.ready).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(client.me.get()).rejects.toMatchObject({ kind: 'unavailable' });
    client.destroy();
  });
});

describe('bridge.fetch: the token goes only where it belongs', () => {
  const pageLocation = { href: 'https://app.test/dashboard', origin: 'https://app.test' };
  afterEach(() => {
    delete (globalThis as { location?: unknown }).location;
  });

  async function signedInClient(tokenOrigins?: string[]) {
    const { fake } = issuerWithPeople();
    const sent: { url: string; authorization: string | null }[] = [];
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), pageLocation.href);
      if (url.origin !== 'https://bridge.test') {
        sent.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });
        return Promise.resolve(Response.json({ ok: true }));
      }
      return fake.fetch(input, init);
    }) as typeof fetch;
    const client = clientOn(fake, { fetch: fetchFn, ...(tokenOrigins === undefined ? {} : { tokenOrigins }) });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    return { client, sent };
  }

  it("sends it to the page's own origin", async () => {
    (globalThis as { location?: unknown }).location = pageLocation;
    const { client, sent } = await signedInClient();
    await client.fetch('/api/invoices');
    expect(sent).toEqual([{ url: 'https://app.test/api/invoices', authorization: expect.stringMatching(/^Bearer /) }]);
  });

  it('sends it to an origin listed in tokenOrigins', async () => {
    const { client, sent } = await signedInClient(['https://api.app.test']);
    await client.fetch('https://api.app.test/invoices');
    expect(sent[0]?.authorization).toMatch(/^Bearer /);
  });

  it('refuses any other host, before anything is sent', async () => {
    (globalThis as { location?: unknown }).location = pageLocation;
    const { client, sent } = await signedInClient(['https://api.app.test']);
    await expect(client.fetch('https://evil.test/collect')).rejects.toMatchObject({ kind: 'misconfigured', message: expect.stringMatching(/evil\.test/) });
    await expect(client.fetch('https://api.app.test.evil.test/x')).rejects.toMatchObject({ kind: 'misconfigured' });
    expect(sent).toEqual([]);
  });

  it('refuses a tokenOrigins entry that is not https', () => {
    const { fake } = issuerWithPeople();
    expect(() => clientOn(fake, { tokenOrigins: ['http://api.app.test'] })).toThrow(/https origins/);
  });
});

describe("flags: never another person's or workspace's results", () => {
  it('a screen reading flags while the workspace changes sees fallbacks, not the old workspace\'s results', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ reports: true });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD, workspace: 'ws-acme' });
    await client.flags.load();
    expect(client.flags.enabled('reports')).toBe(true);
    const seen: boolean[] = [];
    client.session.subscribe((session) => {
      if (session.status === 'signed-in' && session.workspace?.id === 'ws-globex') seen.push(client.flags.enabled('reports'));
    });
    await client.workspaces.switch('ws-globex');
    expect(seen[0]).toBe(false);
    await client.flags.load();
    expect(client.flags.enabled('reports')).toBe(true);
  });

  it('drops the results when the same person signs in again: a new session is a new context', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ reports: true });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    let during: boolean | null = null;
    const stop = client.session.subscribe((session) => {
      if (session.status === 'signed-in') during = client.flags.enabled('reports');
    });
    during = null;
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    stop();
    expect(during).toBe(false);
  });
});

describe('Live: the token goes only over wss', () => {
  it('polls instead of opening a socket at a ws:// address, and says why', async () => {
    const { fake } = issuerWithPeople();
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).endsWith('/connection')
        ? Promise.resolve(Response.json({ kind: 'appsync-events', endpoint: 'ws://live.bridge.test/event/realtime', host: 'live-http.bridge.test', region: 'x' }))
        : fake.fetch(input, init)) as typeof fetch;
    const client = clientOn(fake, { fetch: fetchFn, live: { websocket: fake.websocket as never, pollMs: 10 } });
    const errors: unknown[] = [];
    client.on('error', (error) => errors.push(error));
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    for (let tries = 0; client.live.status.get() !== 'polling' && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.live.status.get()).toBe('polling');
    expect(fake.sockets).toHaveLength(0);
    expect(errors.some((error) => /must be wss/.test(String((error as Error).message)))).toBe(true);
    client.destroy();
  });
});
