import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { isHostedReturn } from '../../hosted.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

const RETURN = 'https://app.acme.test/auth/callback';

/** The Child App and the hosted page, as two clients of one issuer: the app's storage never reaches the page. */
function setUp() {
  const { fake, alice, bob } = issuerWithPeople({ returns: [RETURN, 'http://127.0.0.1/callback'] });
  const appStorage = memoryStorage();
  const app = clientOn(fake, { storage: memoryStorage(), signUpStorage: appStorage });
  const page = () => clientOn(fake, { storage: memoryStorage(), signUpStorage: memoryStorage() });
  return { fake, alice, bob, app, appStorage, page };
}

const requestOf = (address: string) => new URL(address).searchParams.get('request')!;

describe('hosted mode: the app starts a sign-in request, the hosted page signs in on it, the app trades the code', () => {
  it('signs in with a password on the page, and only the app, with its verifier and return, gets the session', async () => {
    const { fake, app, page } = setUp();
    await expect(app.hosted.offered()).resolves.toBe(true);
    const address = await app.hosted.start({ redirectUri: RETURN });
    expect(address).toMatch(new RegExp(`^${fake.issuer.replace('/identity-access/apps/', '/sign-in/').replace(/[.?]/g, '\\$&')}/\\?request=[A-Za-z0-9_-]+$`));
    const started = fake.requests.find((each) => each.path.endsWith('/sign-in-requests'))!;
    expect(started.body).toEqual({ redirect_uri: RETURN, code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: 'S256', state: expect.any(String) });
    expect(started.body).not.toHaveProperty('code_verifier');

    const hosted = page();
    await hosted.request.use(requestOf(address));
    const step = await hosted.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    expect(step).toEqual({ done: true, handoff: expect.any(String) });
    // The page sent the request, never a challenge of its own, and made no session.
    const signedIn = fake.requests.filter((each) => each.path.endsWith('/sign-in')).pop()!;
    expect(signedIn.body).toEqual({ email: 'alice@acme.test', password: PASSWORD, request: requestOf(address) });
    expect(hosted.session.get()).toMatchObject({ status: 'signed-out' });
    const back = new URL((step as { handoff: string }).handoff);
    expect(`${back.origin}${back.pathname}`).toBe(RETURN);
    expect(back.searchParams.get('iss')).toBe(fake.issuer);
    expect(isHostedReturn(back)).toBe(true);

    await app.hosted.finish(back);
    expect(app.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'alice@acme.test' } });
    const traded = fake.requests.filter((each) => each.path.endsWith('/token')).pop()!;
    expect(traded.body).toMatchObject({ grant_type: 'authorization_code', redirect_uri: RETURN });
    // Finished once.
    await expect(app.hosted.finish(back)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a return with another state or issuer, or one this browser did not start', async () => {
    const { app, page, fake } = setUp();
    const address = await app.hosted.start({ redirectUri: RETURN });
    const hosted = page();
    await hosted.request.use(requestOf(address));
    const back = new URL(((await hosted.signIn.start({ email: 'alice@acme.test', password: PASSWORD })) as { handoff: string }).handoff);
    const forged = new URL(back);
    forged.searchParams.set('state', 'another-state-entirely');
    await expect(app.hosted.finish(forged)).rejects.toMatchObject({ kind: 'invalid' });
    const elsewhere = new URL(back);
    elsewhere.searchParams.set('iss', 'https://evil.test/identity-access/apps/app-test');
    await app.hosted.start({ redirectUri: RETURN });
    await expect(app.hosted.finish(elsewhere)).rejects.toMatchObject({ kind: 'invalid' });
    // Another browser: no verifier waits there.
    await expect(clientOn(fake).hosted.finish(back)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('a sign-in link sent on the request opens in any tab of the browser that asked, never elsewhere, and the request gives one code', async () => {
    const { fake, app, page } = setUp();
    const address = await app.hosted.start({ redirectUri: RETURN });
    // The page's tabs share the storage the link's verifier waits in.
    const shared = memoryStorage();
    const hosted = clientOn(fake, { storage: memoryStorage(), signUpStorage: shared });
    await hosted.request.use(requestOf(address));
    await expect(hosted.magicLink.start('alice@acme.test')).resolves.toEqual({ next: 'verify_email' });
    // This device's challenge binds the link to it; the request binds the code to the app.
    expect(fake.requests.filter((each) => each.path.endsWith('/magic-link')).pop()!.body).toEqual({ email: 'alice@acme.test', request: requestOf(address), code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: 'S256' });
    const link = fake.lastLink('alice@acme.test', 'magic-link')!;
    // Another browser, such as a mail scanner's, holds no verifier: refused, and nothing is spent.
    await expect(page().magicLink.finish(link)).rejects.toMatchObject({ kind: 'wrong-device' });
    // A new tab of the browser that asked: it has never seen the request.
    const step = await clientOn(fake, { storage: memoryStorage(), signUpStorage: shared }).magicLink.finish(link);
    expect(step).toEqual({ done: true, handoff: expect.any(String) });
    // The page's verifier was spent with the link.
    expect(await shared.get(`bridge:${fake.issuer}:magic-link`)).toBeNull();
    await app.hosted.finish((step as { handoff: string }).handoff);
    expect(app.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'alice@acme.test' } });
    // The request is spent: signing in on it again gives nothing.
    await expect(hosted.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).rejects.toMatchObject({ code: 'invalid_request_uri' });
  });

  it('a sign-in link sent on the request that lands on the app\'s own page opens there with the app\'s verifier', async () => {
    const { fake, app } = setUp();
    const address = await app.hosted.start({ redirectUri: RETURN, linkAddress: 'https://app.acme.test/account' });
    const hosted = clientOn(fake, { storage: memoryStorage(), signUpStorage: memoryStorage() });
    await hosted.request.use(requestOf(address));
    await hosted.magicLink.start('alice@acme.test');
    const step = await app.magicLink.finish(fake.lastLink('alice@acme.test', 'magic-link')!);
    expect(step).toEqual({ done: true, handoff: expect.any(String) });
    // The app's verifier stays for its return, which trades the code with it.
    await app.hosted.finish((step as { handoff: string }).handoff);
    expect(app.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'alice@acme.test' } });
  });

  it('a sign-up on the request keeps its link bound to the page that started it, and its code is the app\'s', async () => {
    const { fake, app, page } = setUp();
    const address = await app.hosted.start({ redirectUri: RETURN });
    const shared = memoryStorage();
    const hosted = clientOn(fake, { storage: memoryStorage(), signUpStorage: shared });
    await hosted.request.use(requestOf(address));
    await hosted.signUp.start({ email: 'new@acme.test', password: PASSWORD, workspace: 'New' });
    const body = fake.requests.filter((each) => each.path.endsWith('/sign-up')).pop()!.body;
    expect(body).toMatchObject({ request: requestOf(address), code_challenge: expect.any(String) });
    const link = fake.lastLink('new@acme.test', 'verify-sign-up')!;
    await expect(page().signUp.finish(link)).rejects.toMatchObject({ kind: 'wrong-device' });
    const step = await clientOn(fake, { storage: memoryStorage(), signUpStorage: shared }).signUp.finish(link);
    await app.hosted.finish((step as { handoff: string }).handoff);
    expect(app.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'new@acme.test' } });
  });

  it('the workspace step on the request ends with the app\'s code too', async () => {
    const { app, page } = setUp();
    const address = await app.hosted.start({ redirectUri: RETURN });
    const hosted = page();
    await hosted.request.use(requestOf(address));
    const step = await hosted.signIn.start({ email: 'bob@acme.test', password: PASSWORD });
    if (step.done) throw new Error('expected the workspace step');
    const chosen = await step.choose('ws-globex');
    await app.hosted.finish((chosen as { handoff: string }).handoff);
    expect(app.session.get()).toMatchObject({ status: 'signed-in', workspace: { id: 'ws-globex' } });
  });

  it('is not offered, and start says so, for an app that did not register the page', async () => {
    const { fake } = issuerWithPeople();
    const app = clientOn(fake);
    await expect(app.hosted.offered()).resolves.toBe(false);
    await expect(app.hosted.start({ redirectUri: RETURN })).rejects.toMatchObject({ kind: 'not-offered' });
    await expect(app.request.use('not a request id')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('names the page\'s own email-links address on sign-up, sign-in link and recovery, and leaves it to the request on one', async () => {
    const { fake, app } = setUp();
    const own = 'https://app.acme.test/account';
    const sdk = clientOn(fake, { storage: memoryStorage(), signUpStorage: memoryStorage(), linkAddress: own });
    await sdk.signUp.start({ email: 'fresh@acme.test', password: PASSWORD });
    await sdk.magicLink.start('alice@acme.test');
    await sdk.password.forgot('alice@acme.test');
    for (const path of ['/sign-up', '/magic-link', '/password/forgot']) {
      expect(fake.requests.filter((each) => each.path.endsWith(path)).pop()!.body, path).toMatchObject({ link_address: own });
    }
    const address = await app.hosted.start({ redirectUri: RETURN, linkAddress: own });
    expect(fake.requests.filter((each) => each.path.endsWith('/sign-in-requests')).pop()!.body).toMatchObject({ link_address: own });
    await sdk.request.use(requestOf(address));
    await sdk.magicLink.start('alice@acme.test');
    expect(fake.requests.filter((each) => each.path.endsWith('/magic-link')).pop()!.body).not.toHaveProperty('link_address');
    expect(fake.requests.filter((each) => each.path.endsWith('/magic-link')).pop()!.body).toMatchObject({ email: 'alice@acme.test', request: requestOf(address) });
  });
});
