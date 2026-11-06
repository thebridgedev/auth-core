import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { clientOn, flush, issuerWithPeople, PASSWORD, tokenCalls, twoTabs } from './helpers.js';

async function signedIn(client: ReturnType<typeof clientOn>, email = 'alice@acme.test') {
  await client.ready;
  const step = await client.signIn.start({ email, password: PASSWORD });
  if (!step.done) await step.choose(step.workspaces[0]!.id);
}

describe('session: tokens and refresh rotation', () => {
  it('starts signed out when nothing is stored', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    expect(client.session.get().status).toBe('loading');
    await client.ready;
    expect(client.session.get()).toEqual({ status: 'signed-out', reason: 'never-signed-in' });
  });

  it('signs in, and knows who and which workspace from the tokens', async () => {
    const { fake, alice } = issuerWithPeople();
    const client = clientOn(fake);
    const events: string[] = [];
    client.on('signed-in', () => events.push('signed-in'));
    await signedIn(client);
    expect(client.session.get()).toEqual({ status: 'signed-in', user: { id: alice.id, email: 'alice@acme.test', emailVerified: true }, workspace: { id: 'ws-acme', standing: 'active' } });
    expect(events).toEqual(['signed-in']);
  });

  it('keeps the access token in memory only, and the refresh token under the issuer', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await signedIn(client);
    const stored = JSON.parse((await storage.get(`bridge:${fake.issuer}:session`)) as string) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['idToken', 'refreshToken', 'workspace']);
    expect(JSON.stringify(stored)).not.toContain(await client.token());
  });

  it('restores a stored session on reload with one refresh, which rotates the refresh token', async () => {
    const { fake, alice } = issuerWithPeople();
    const storage = memoryStorage();
    await signedIn(clientOn(fake, { storage }));
    const before = JSON.parse((await storage.get(`bridge:${fake.issuer}:session`)) as string).refreshToken;
    const reloaded = clientOn(fake, { storage });
    await reloaded.ready;
    expect(reloaded.session.get()).toMatchObject({ status: 'signed-in', user: { id: alice.id } });
    expect(tokenCalls(fake, 'refresh_token')).toHaveLength(1);
    expect(JSON.parse((await storage.get(`bridge:${fake.issuer}:session`)) as string).refreshToken).not.toBe(before);
  });

  it('refreshes before a call only when the access token is close to expiring', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { fake } = issuerWithPeople();
      const client = clientOn(fake);
      await signedIn(client);
      await client.token();
      expect(tokenCalls(fake, 'refresh_token')).toHaveLength(0);
      // Five-minute tokens: with under a minute left, the next call refreshes first.
      vi.setSystemTime(Date.now() + 241_000);
      await client.token();
      expect(tokenCalls(fake, 'refresh_token')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes one refresh for calls made at once', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    await signedIn(clientOn(fake, { storage }));
    const reloaded = clientOn(fake, { storage, loadFlags: false });
    await Promise.all([reloaded.ready, reloaded.token(), reloaded.token(), reloaded.me.get()]);
    expect(tokenCalls(fake, 'refresh_token')).toHaveLength(1);
  });

  it('signs out with session-ended when Bridge says the session ended', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await signedIn(client);
    const reasons: string[] = [];
    client.on('signed-out', ({ reason }) => reasons.push(reason));
    for (const session of fake.sessions()) fake.endSession(session.id);
    await expect(client.workspaces.switch('ws-acme')).rejects.toMatchObject({ kind: 'signed-out' });
    expect(client.session.get()).toEqual({ status: 'signed-out', reason: 'session-ended' });
    expect(reasons).toEqual(['session-ended']);
    expect(await storage.get(`bridge:${fake.issuer}:session`)).toBeNull();
  });

  it('keeps the session when Bridge cannot be reached, and says why', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    await signedIn(clientOn(fake, { storage }));
    let offline = false;
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => (offline ? Promise.reject(new TypeError('offline')) : fake.fetch(input, init))) as typeof fetch;
    const client = clientOn(fake, { storage, fetch: fetchFn, loadFlags: false });
    const errors: unknown[] = [];
    client.on('error', (error) => errors.push(error));
    offline = false;
    await client.ready;
    offline = true;
    await expect(client.workspaces.switch('ws-acme')).rejects.toMatchObject({ kind: 'network' });
    expect(client.session.get().status).toBe('signed-in');
    expect(await storage.get(`bridge:${fake.issuer}:session`)).not.toBeNull();
  });

  it('restores as signed in from what is stored while offline at startup', async () => {
    const { fake, alice } = issuerWithPeople();
    const storage = memoryStorage();
    await signedIn(clientOn(fake, { storage }));
    let calls = 0;
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => (++calls > 1 ? Promise.reject(new TypeError('offline')) : fake.fetch(input, init))) as typeof fetch;
    const client = clientOn(fake, { storage, fetch: fetchFn, loadFlags: false });
    await client.ready;
    expect(client.session.get()).toEqual({ status: 'signed-in', user: { id: alice.id, email: 'alice@acme.test', emailVerified: true }, workspace: { id: 'ws-acme', standing: 'active' } });
  });

  it('signs out at Bridge, so the session ends there, and forgets it here', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await signedIn(client);
    await client.signOut();
    expect(fake.requests.some((request) => request.path === '/v2/identity-access/sign-out' && request.headers['authorization']?.startsWith('Bearer '))).toBe(true);
    expect(fake.sessions().every((session) => session.ended)).toBe(true);
    expect(client.session.get()).toEqual({ status: 'signed-out', reason: 'signed-out' });
    expect(await storage.get(`bridge:${fake.issuer}:session`)).toBeNull();
  });

  it('revokes the refresh token when there is no access token to sign out with', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    await signedIn(clientOn(fake, { storage }));
    const failing = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.endsWith('/token') ? Promise.reject(new TypeError('offline')) : fake.fetch(input, init);
    }) as typeof fetch;
    const client = clientOn(fake, { storage, fetch: failing, loadFlags: false });
    await client.ready;
    await client.signOut();
    expect(fake.requests.some((request) => request.path.endsWith('/revoke') && (request.body as { token_type_hint?: string }).token_type_hint === 'refresh_token')).toBe(true);
    expect(fake.sessions().every((session) => session.ended)).toBe(true);
  });

  it('never signs out twice: signing out while signed out does nothing', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.ready;
    await client.signOut();
    expect(client.session.get()).toEqual({ status: 'signed-out', reason: 'signed-out' });
  });
});

describe('session: one refresher across tabs', () => {
  it('lets one tab refresh and hands the new access token to the other', async () => {
    const { fake } = issuerWithPeople();
    const tabs = twoTabs(fake, { loadFlags: false });
    await signedIn(tabs.first);
    await flush();
    expect(tabs.second.session.get().status).toBe('signed-in');
    const before = tokenCalls(fake, 'refresh_token').length;
    await tabs.second.token();
    expect(tokenCalls(fake, 'refresh_token').length).toBe(before);
  });

  it('never spends one refresh token twice when both tabs refresh at once', async () => {
    const { fake } = issuerWithPeople();
    const tabs = twoTabs(fake, { loadFlags: false });
    await signedIn(tabs.first);
    const third = tabs.another();
    const fourth = tabs.another();
    await Promise.all([third.ready, fourth.ready]);
    const spent = tokenCalls(fake, 'refresh_token').map((request) => (request.body as { refresh_token: string }).refresh_token);
    expect(new Set(spent).size).toBe(spent.length);
    expect(third.session.get().status).toBe('signed-in');
    expect(fourth.session.get().status).toBe('signed-in');
    expect(fake.sessions().every((session) => !session.ended)).toBe(true);
  });

  it('a refresh token reused after the grace ends the session, in every tab', async () => {
    let now = Date.now();
    const { fake } = issuerWithPeople({ now: () => now });
    const tabs = twoTabs(fake, { loadFlags: false });
    await signedIn(tabs.first);
    const copied = JSON.parse((await tabs.storage.get(`bridge:${fake.issuer}:session`)) as string).refreshToken as string;
    await tabs.first.workspaces.switch('ws-acme');
    now += 31_000;
    // Someone else spends the copied token after the grace: Bridge ends the session.
    const reused = await fake.fetch(`${fake.issuer.replace('/identity-access/', '/v2/identity-access/')}/token`, { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: copied }) });
    expect(reused.status).toBe(400);
    await expect(tabs.first.workspaces.switch('ws-acme')).rejects.toMatchObject({ kind: 'signed-out' });
    await flush();
    expect(tabs.first.session.get()).toEqual({ status: 'signed-out', reason: 'session-ended' });
    expect(tabs.second.session.get()).toEqual({ status: 'signed-out', reason: 'session-ended' });
  });

  it('signs every tab out when one signs out', async () => {
    const { fake } = issuerWithPeople();
    const tabs = twoTabs(fake, { loadFlags: false });
    await signedIn(tabs.first);
    await tabs.second.ready;
    await flush();
    await tabs.second.signOut();
    await flush();
    expect(tabs.first.session.get()).toEqual({ status: 'signed-out', reason: 'signed-out' });
  });

  it('follows a workspace switch made in another tab', async () => {
    const { fake } = issuerWithPeople();
    const tabs = twoTabs(fake, { loadFlags: false });
    await signedIn(tabs.first, 'bob@acme.test');
    await flush();
    const changed: (string | null)[] = [];
    tabs.second.on('workspace-changed', ({ workspace }) => changed.push(workspace?.id ?? null));
    const target = tabs.first.session.get().status === 'signed-in' && (tabs.first.session.get() as { workspace: { id: string } }).workspace.id === 'ws-acme' ? 'ws-globex' : 'ws-acme';
    await tabs.first.workspaces.switch(target);
    await flush();
    expect(changed).toEqual([target]);
    expect(tabs.second.session.get()).toMatchObject({ workspace: { id: target } });
  });

  it("raises session-stale instead, when told not to follow another tab's switch", async () => {
    const { fake } = issuerWithPeople();
    const tabs = twoTabs(fake, { loadFlags: false, otherTabWorkspace: 'stale' });
    await signedIn(tabs.first, 'bob@acme.test');
    await flush();
    const stale: (string | null)[] = [];
    tabs.second.on('session-stale', ({ workspace }) => stale.push(workspace));
    await tabs.first.workspaces.switch('ws-globex');
    await flush();
    expect(stale).toEqual(['ws-globex']);
    expect(tabs.second.session.get()).toMatchObject({ workspace: { id: 'ws-acme' } });
  });
});
