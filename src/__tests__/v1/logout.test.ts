import { describe, expect, it, vi } from 'vitest';
import { matchesOrigin, ownDestination } from '../../logout.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** Signing out keeps people in the app, or exactly where the developer chooses. */

async function signedInClient(options: Parameters<typeof clientOn>[1] = {}, issuer: Parameters<typeof issuerWithPeople>[0] = {}) {
  const { fake } = issuerWithPeople(issuer);
  const went: string[] = [];
  const client = clientOn(fake, { navigate: (to) => void went.push(to), appOrigins: ['https://app.acme.test'], ...options });
  await client.ready;
  await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  return { fake, client, went };
}

describe('logout()', () => {
  it('goes to the app\'s own sign-in page by default', async () => {
    const { client, went } = await signedInClient();
    await expect(client.logout()).resolves.toEqual({ redirectTo: '/auth/login' });
    expect(went).toEqual(['/auth/login']);
    expect(client.session.get().status).toBe('signed-out');
  });

  it('goes to the page the app names as its signed-out page', async () => {
    const { client, went } = await signedInClient({ signedOutPage: '/welcome-back' });
    await client.logout();
    expect(went).toEqual(['/welcome-back']);
  });

  it('goes where the developer chose, on the page\'s own address or one of the app\'s addresses', async () => {
    const first = await signedInClient();
    await first.client.logout({ redirectTo: '/goodbye?from=nav' });
    expect(first.went).toEqual(['/goodbye?from=nav']);
    const second = await signedInClient();
    await second.client.logout({ redirectTo: 'https://app.acme.test/bye' });
    expect(second.went).toEqual(['https://app.acme.test/bye']);
  });

  it('refuses any other address and uses the default', async () => {
    for (const hostile of ['https://evil.test/phish', '//evil.test', '/\\evil.test', 'javascript:alert(1)', 'https://user:pw@app.acme.test/x', 'https://app.acme.test.evil.test/']) {
      const { client, went } = await signedInClient();
      await expect(client.logout({ redirectTo: hostile })).resolves.toEqual({ redirectTo: '/auth/login' });
      expect(went).toEqual(['/auth/login']);
    }
  });

  it('stays where it is when silent: signed out, no navigation, and the sign-out event is heard', async () => {
    const { client, went } = await signedInClient();
    const heard: string[] = [];
    client.on('signed-out', ({ reason }) => heard.push(reason));
    await expect(client.logout({ silent: true })).resolves.toEqual({ redirectTo: null });
    expect(went).toEqual([]);
    expect(heard).toEqual(['signed-out']);
    expect(client.session.get()).toEqual({ status: 'signed-out', reason: 'signed-out' });
  });

  it('sends the sign-out event in every case', async () => {
    const heard: string[] = [];
    for (const options of [{}, { redirectTo: '/bye' }, { silent: true }]) {
      const { client } = await signedInClient();
      client.on('signed-out', () => heard.push('signed-out'));
      await client.logout(options);
    }
    expect(heard).toHaveLength(3);
  });

  it('ends the session at Bridge, so a copied token stops working', async () => {
    const { fake, client } = await signedInClient();
    const copied = await client.token();
    const asks = () => fake.fetch(`${new URL(fake.issuer).origin}/v2/accounts/me`, { method: 'GET', headers: { Authorization: `Bearer ${copied}` } });
    expect((await asks()).status).toBe(200);
    await client.logout({ silent: true });
    expect((await asks()).status).toBe(401);
  });

  it('only answers where to go when the page navigates itself (navigate: null)', async () => {
    const { client } = await signedInClient({ navigate: null });
    await expect(client.logout({ redirectTo: '/bye' })).resolves.toEqual({ redirectTo: '/bye' });
  });
});

describe('ownDestination', () => {
  const page = 'https://acme.test';
  it('keeps a path and an address on the page\'s origin', () => {
    expect(ownDestination('/a/b?c=d', page)).toBe('/a/b?c=d');
    expect(ownDestination('https://acme.test/x', page)).toBe('https://acme.test/x');
  });
  it('refuses everything else', () => {
    for (const bad of ['', '  ', 'x/y', 'https://acme.test.evil.test/', 'http://acme.test/', '//acme.test/', 'https://acme.test\\@evil.test/', 'ftp://acme.test/', 'https://acme.test/\u0000']) expect([bad, ownDestination(bad, page)]).toEqual([bad, null]);
    expect(ownDestination(undefined, page)).toBeNull();
    expect(ownDestination('https://acme.test/x', null)).toBeNull();
  });
});

describe('logout() takes where to go from Bridge, so the app configures nothing', () => {
  const ORIGINS = ['https://acme.test', 'https://*.acme.test', 'http://localhost:*'];

  it('goes to the sign-out page the app lists in its settings, with no change in the app', async () => {
    const { client, went } = await signedInClient({ appOrigins: undefined }, { signOut: { page: 'https://acme.test/goodbye', origins: ORIGINS } });
    await expect(client.logout()).resolves.toEqual({ redirectTo: 'https://acme.test/goodbye' });
    expect(went).toEqual(['https://acme.test/goodbye']);
  });

  it('goes to Bridge\'s sign-in page when Bridge names it (an app whose users sign in there), and to the app\'s own sign-in page when it names none', async () => {
    const hosted = await signedInClient({ appOrigins: undefined }, { signOut: { page: 'https://auth.bridge.test/app-1/', origins: ORIGINS } });
    await hosted.client.logout();
    expect(hosted.went).toEqual(['https://auth.bridge.test/app-1/']);
    const own = await signedInClient({ appOrigins: undefined, signedOutPage: '/sign-in' }, { signOut: { page: null, origins: ORIGINS } });
    await own.client.logout();
    expect(own.went).toEqual(['/sign-in']);
  });

  it('lets a chosen address through only on one of the app\'s origins as Bridge lists them (wildcards as Bridge matches them); any other is refused and the default used', async () => {
    const allowed = ['https://acme.test/bye', 'https://app.acme.test/bye', 'http://localhost:5173/bye'];
    for (const to of allowed) {
      const { client, went } = await signedInClient({ appOrigins: undefined }, { signOut: { page: 'https://acme.test/goodbye', origins: ORIGINS } });
      await client.logout({ redirectTo: to });
      expect(went, to).toEqual([to]);
    }
    for (const to of ['https://evil.test/', 'https://acme.test.evil.test/', 'https://evilacme.test/', 'http://acme.test/bye', 'https://app.acme.test:8443/']) {
      const { client, went } = await signedInClient({ appOrigins: undefined }, { signOut: { page: 'https://acme.test/goodbye', origins: ORIGINS } });
      await client.logout({ redirectTo: to });
      expect(went, to).toEqual(['https://acme.test/goodbye']);
    }
  });

  it('follows a change in the app\'s settings on the next sign-out', async () => {
    let page: string | null = null;
    const { fake } = issuerWithPeople({ signOut: () => ({ page, origins: ORIGINS }) });
    const went: string[] = [];
    const client = clientOn(fake, { navigate: (to) => void went.push(to) });
    await client.ready;
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.logout();
    page = 'https://acme.test/goodbye';
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.logout();
    expect(went).toEqual(['/auth/login', 'https://acme.test/goodbye']);
  });

  it('still signs out, at Bridge too, and goes to the app\'s own sign-in page when the options fail or do not answer in time', async () => {
    const failing = await signedInClient({ appOrigins: undefined }, { signOut: () => { throw new Error('down'); } });
    const copied = await failing.client.token();
    await expect(failing.client.logout({ redirectTo: 'https://acme.test/bye' })).resolves.toEqual({ redirectTo: '/auth/login' });
    expect(failing.client.session.get().status).toBe('signed-out');
    const asks = () => failing.fake.fetch(`${new URL(failing.fake.issuer).origin}/v2/accounts/me`, { method: 'GET', headers: { Authorization: `Bearer ${copied}` } });
    expect((await asks()).status).toBe(401);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const held = await signedInClient({ appOrigins: undefined }, { signOut: () => new Promise(() => undefined) });
      const done = held.client.logout();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(done).resolves.toEqual({ redirectTo: '/auth/login' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks nothing when silent', async () => {
    let asked = 0;
    const { client, went } = await signedInClient({}, { signOut: () => { asked += 1; return { page: 'https://acme.test/goodbye', origins: ORIGINS }; } });
    const before = asked;
    await client.logout({ silent: true });
    expect([asked - before, went]).toEqual([0, []]);
  });

  it('still allows the origins a developer listed in appOrigins, for one release', async () => {
    const { client, went } = await signedInClient({ appOrigins: ['https://app.acme.test'] }, { signOut: { page: null, origins: [] } });
    await client.logout({ redirectTo: 'https://app.acme.test/bye' });
    expect(went).toEqual(['https://app.acme.test/bye']);
  });

  it('matches a saved origin as Bridge does', () => {
    expect(matchesOrigin('https://*.acme.test', 'https://a.b.acme.test')).toBe(true);
    expect(matchesOrigin('https://*.acme.test', 'https://acme.test')).toBe(false);
    expect(matchesOrigin('https://*.acme.test:*', 'https://a.acme.test:8443')).toBe(true);
    expect(matchesOrigin('https://*.acme.test:8443', 'https://a.acme.test:9443')).toBe(false);
    expect(matchesOrigin('http://localhost:*', 'http://localhost:5173')).toBe(true);
    expect(matchesOrigin('http://localhost:*', 'http://localhost:5173.evil.test')).toBe(false);
    expect(ownDestination('https://a.acme.test/x', null, ['https://*.acme.test'])).toBe('https://a.acme.test/x');
  });
});
