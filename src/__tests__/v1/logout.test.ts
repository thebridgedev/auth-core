import { describe, expect, it } from 'vitest';
import { ownDestination } from '../../logout.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** Signing out keeps people in the app, or exactly where the developer chooses. */

async function signedInClient(options: Parameters<typeof clientOn>[1] = {}) {
  const { fake } = issuerWithPeople();
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
