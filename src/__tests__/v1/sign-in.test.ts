import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { handoffReturnUrl, isLoopbackRedirect, readHandoffRequest } from '../../handoff.js';
import { readEmailLink, takeEmailLink, type EmailLinkWindow } from '../../sign-in.js';
import { clientOn, issuerWithPeople, PASSWORD, tokenCalls } from './helpers.js';

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

describe('sign-in with email and password', () => {
  it('signs in straight away with one workspace', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
    const signIn = fake.requests.find((request) => request.path.endsWith('/sign-in'))!;
    expect(signIn.body).toMatchObject({ code_challenge_method: 'S256' });
    expect((signIn.body as { code_challenge: string }).code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const exchange = tokenCalls(fake, 'authorization_code')[0]!.body as { code_verifier: string };
    expect(challengeOf(exchange.code_verifier)).toBe((signIn.body as { code_challenge: string }).code_challenge);
  });

  it('asks which workspace with several, and signs in to the chosen one', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    const step = await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD });
    expect(step.done).toBe(false);
    if (step.done) return;
    expect(step.workspaces).toEqual([
      { id: 'ws-acme', name: 'Acme', logo: null },
      { id: 'ws-globex', name: 'Globex', logo: null },
    ]);
    await expect(step.choose('ws-globex')).resolves.toEqual({ done: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', workspace: { id: 'ws-globex' } });
  });

  it('signs in to a named workspace without asking', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await expect(client.signIn.start({ email: 'bob@acme.test', password: PASSWORD, workspace: 'ws-globex' })).resolves.toEqual({ done: true });
  });

  it('answers wrong-credentials for a wrong password and for an unknown address alike', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await expect(client.signIn.start({ email: 'alice@acme.test', password: 'nope' })).rejects.toMatchObject({ kind: 'wrong-credentials' });
    await expect(client.signIn.start({ email: 'nobody@acme.test', password: PASSWORD })).rejects.toMatchObject({ kind: 'wrong-credentials' });
  });

  it('refuses a workspace step that was already used', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    const step = await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD });
    if (step.done) throw new Error('expected a step');
    await step.choose('ws-acme');
    await expect(step.choose('ws-acme')).rejects.toMatchObject({ kind: 'flow-expired' });
  });

  it('refuses a step it does not know with unsupported-step, and leaves the seam for it', async () => {
    const { fake } = issuerWithPeople();
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.endsWith('/sign-in') ? Response.json({ next: 'second_step', flow: 'f1' }) : fake.fetch(input, init);
    }) as typeof fetch;
    const client = clientOn(fake, { fetch: fetchFn });
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).rejects.toMatchObject({ kind: 'unsupported-step', step: 'second_step' });
  });

  it('never sends an invite with a sign-in: accepting is its own call', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    expect(fake.requests.find((request) => request.path.endsWith('/sign-in'))!.body).not.toHaveProperty('invite');
  });
});

describe('sign-up, finished from the email link on the same device', () => {
  it('signs up, then finishes from the link and is signed in', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await expect(client.signUp.start({ email: 'carol@acme.test', password: PASSWORD, firstName: 'Carol', workspace: 'Carol Co' })).resolves.toEqual({ next: 'verify_email' });
    const link = fake.lastLink('carol@acme.test', 'verify-sign-up')!;
    // The link opens a new tab on the same device: a new client, the same storage.
    const linkTab = clientOn(fake, { storage });
    await expect(linkTab.signUp.finish(link)).resolves.toEqual({ done: true });
    expect(linkTab.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'carol@acme.test' } });
    expect(await storage.get(`bridge:${fake.issuer}:sign-up`)).toBeNull();
  });

  it('answers the same for an address that already has an account', async () => {
    const { fake } = issuerWithPeople();
    await expect(clientOn(fake).signUp.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ next: 'verify_email' });
  });

  it('says wrong-device on another device, and the link still works on the right one', async () => {
    const { fake } = issuerWithPeople();
    const storage = memoryStorage();
    await clientOn(fake, { storage }).signUp.start({ email: 'dan@acme.test', password: PASSWORD });
    const link = fake.lastLink('dan@acme.test', 'verify-sign-up')!;
    await expect(clientOn(fake).signUp.finish(link)).rejects.toMatchObject({ kind: 'wrong-device' });
    await expect(clientOn(fake, { storage }).signUp.finish(link)).resolves.toEqual({ done: true });
  });

  it('says link-invalid for a used or unknown link', async () => {
    const { fake } = issuerWithPeople();
    await expect(clientOn(fake).signUp.finish('nope')).rejects.toMatchObject({ kind: 'link-invalid' });
  });
});

describe('forgot and reset password', () => {
  it('sends a link, sets the password, signs nobody in, and ends every session', async () => {
    const { fake } = issuerWithPeople();
    const signedIn = clientOn(fake);
    await signedIn.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    const client = clientOn(fake);
    await client.password.forgot('alice@acme.test');
    const token = fake.lastLink('alice@acme.test', 'reset-password')!;
    await client.password.set(token, 'a brand new password');
    expect(client.session.get().status).toBe('signed-out');
    expect(fake.sessions().every((session) => session.ended)).toBe(true);
    await expect(client.signIn.start({ email: 'alice@acme.test', password: 'a brand new password' })).resolves.toEqual({ done: true });
  });

  it('answers the same for an unknown address', async () => {
    const { fake } = issuerWithPeople();
    await expect(clientOn(fake).password.forgot('nobody@acme.test')).resolves.toBeUndefined();
  });

  it('refuses a used reset link', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.password.forgot('alice@acme.test');
    const token = fake.lastLink('alice@acme.test', 'reset-password')!;
    await client.password.set(token, 'a brand new password');
    await expect(client.password.set(token, 'another new password')).rejects.toMatchObject({ kind: 'link-invalid' });
  });
});

describe('sign-in options and invites', () => {
  it('reads the sign-in options when the issuer lists them', async () => {
    const { fake } = issuerWithPeople();
    await expect(clientOn(fake).signIn.options()).resolves.toEqual({ app: { id: fake.appId }, signUp: true, methods: ['password'], password: { minLength: 8, maxLength: 128 } });
  });

  it('answers not-offered while the issuer does not list them', async () => {
    const { fake } = issuerWithPeople({ metadata: 'standard' });
    const client = clientOn(fake);
    await expect(client.signIn.options()).rejects.toMatchObject({ kind: 'not-offered' });
    await expect(client.invites.preview('t')).rejects.toMatchObject({ kind: 'not-offered' });
    await expect(client.invites.accept('t')).rejects.toMatchObject({ kind: 'not-offered' });
  });
});

describe('invites: preview, sign up from one, or sign in and accept', () => {
  const ACME = { id: 'ws-acme', name: 'Acme' };

  it('previews an open invite with the token in the body, never in the address', async () => {
    const { fake } = issuerWithPeople();
    const token = fake.invite('new@acme.test', ACME);
    const client = clientOn(fake);
    await expect(client.invites.preview(token)).resolves.toEqual({ state: 'open', workspace: { name: 'Acme', logo: null }, account: false });
    const asked = fake.requests.find((request) => request.path.endsWith('/invites/preview'))!;
    expect(asked).toMatchObject({ method: 'POST', path: `/v2/identity-access/apps/${fake.appId}/invites/preview`, body: { token } });
    expect(fake.requests.every((request) => !request.path.includes(token))).toBe(true);
    expect(asked.headers).not.toHaveProperty('authorization');
  });

  it('says when the invited address already has an account', async () => {
    const { fake } = issuerWithPeople();
    const token = fake.invite('bob@acme.test', { id: 'ws-initech', name: 'Initech' });
    await expect(clientOn(fake).invites.preview(token)).resolves.toMatchObject({ state: 'open', account: true });
  });

  it('previews a revoked, used, expired or unknown invite by its state only', async () => {
    const { fake, alice } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signIn.start({ email: alice.email, password: PASSWORD });
    const revoked = (await client.team.invites.create({ email: 'gone@acme.test' })).id;
    const revokedToken = fake.lastLink('gone@acme.test', 'invite')!;
    await client.team.invites.revoke(revoked);
    const expiredToken = fake.invite('late@acme.test', ACME);
    fake.expireInvites('late@acme.test');
    const usedToken = fake.invite('used@acme.test', ACME);
    await clientOn(fake).invites.signUp({ token: usedToken, password: PASSWORD });

    const fresh = clientOn(fake);
    await expect(fresh.invites.preview(revokedToken)).resolves.toEqual({ state: 'revoked' });
    await expect(fresh.invites.preview(usedToken)).resolves.toEqual({ state: 'used' });
    await expect(fresh.invites.preview(expiredToken)).resolves.toEqual({ state: 'expired' });
    await expect(fresh.invites.preview('ws-acme_made-up')).resolves.toEqual({ state: 'expired' });
  });

  it('signs a new person up from the invite and in, in the inviting workspace, with no email to verify', async () => {
    const { fake } = issuerWithPeople();
    const token = fake.invite('new@acme.test', ACME, 'EDITOR');
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await expect(client.invites.signUp({ token, password: PASSWORD, firstName: 'New', lastName: 'Person' })).resolves.toEqual({ done: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'new@acme.test' }, workspace: { id: 'ws-acme' } });
    expect(fake.person('new@acme.test')!.workspaces).toEqual([{ id: 'ws-acme', name: 'Acme', role: 'EDITOR' }]);
    const signUp = fake.requests.find((request) => request.path.endsWith('/sign-up'))!;
    expect(signUp.body).toEqual({ invite: token, password: PASSWORD, code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: 'S256', firstName: 'New', lastName: 'Person' });
    // The code is bound to this device: the verifier traded for it matches the challenge, and none was stored for another tab.
    const exchange = tokenCalls(fake, 'authorization_code')[0]!.body as { code_verifier: string };
    expect(challengeOf(exchange.code_verifier)).toBe((signUp.body as { code_challenge: string }).code_challenge);
    expect(await storage.get(`bridge:${fake.issuer}:sign-up`)).toBeNull();
    expect(fake.sentLinks.filter((link) => link.to === 'new@acme.test').map((link) => link.purpose)).toEqual(['invite-new']);
  });

  it('refuses a sign-up from an invite for an address with an account, or for another address', async () => {
    const { fake } = issuerWithPeople();
    const forBob = fake.invite('bob@acme.test', { id: 'ws-initech', name: 'Initech' });
    await expect(clientOn(fake).invites.signUp({ token: forBob, password: PASSWORD })).rejects.toMatchObject({ kind: 'conflict', code: 'account_exists' });
    const forNew = fake.invite('new@acme.test', ACME);
    await expect(clientOn(fake).invites.signUp({ token: forNew, password: PASSWORD, email: 'other@acme.test' })).rejects.toMatchObject({ kind: 'forbidden', code: 'invite_for_another_address' });
    await expect(clientOn(fake).invites.signUp({ token: 'ws-acme_made-up', password: PASSWORD })).rejects.toMatchObject({ kind: 'link-invalid', code: 'invite_expired' });
  });

  it('accepts as the signed-in person, then moves the session into the invited workspace', async () => {
    const { fake, bob } = issuerWithPeople();
    const token = fake.invite(bob.email, { id: 'ws-initech', name: 'Initech' }, 'EDITOR');
    const client = clientOn(fake);
    const step = await client.signIn.start({ email: bob.email, password: PASSWORD });
    if (!step.done) await step.choose('ws-acme');
    await expect(client.invites.accept(token)).resolves.toEqual({ workspace: { id: 'ws-initech', name: 'Initech' }, member: { id: `mem-${bob.id}`, role: 'EDITOR' } });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', workspace: { id: 'ws-initech' } });
    const accept = fake.requests.find((request) => request.path === '/v2/identity-access/invites/accept')!;
    expect(accept.body).toEqual({ token });
    expect(accept.headers['authorization']).toMatch(/^Bearer /);
    expect(tokenCalls(fake, 'refresh_token').at(-1)!.body).toMatchObject({ workspace: 'ws-initech' });
    await expect(client.invites.accept(token)).rejects.toMatchObject({ kind: 'link-invalid', code: 'invite_used' });
  });

  it('refuses an accept for another address, by a member already, or with nobody signed in', async () => {
    const { fake, alice, bob } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signIn.start({ email: alice.email, password: PASSWORD });
    const forBob = fake.invite(bob.email, { id: 'ws-initech', name: 'Initech' });
    await expect(client.invites.accept(forBob)).rejects.toMatchObject({ kind: 'forbidden', code: 'invite_for_another_address' });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', workspace: { id: 'ws-acme' } });
    const forAlice = fake.invite(alice.email, ACME);
    await expect(client.invites.accept(forAlice)).rejects.toMatchObject({ kind: 'conflict', code: 'already_member' });
    await expect(clientOn(fake).invites.accept(forBob)).rejects.toMatchObject({ kind: 'signed-out' });
  });

  it('a new token stops the old one working (sent again)', async () => {
    const { fake } = issuerWithPeople();
    const first = fake.invite('new@acme.test', ACME);
    const second = fake.invite('new@acme.test', ACME);
    expect(second).not.toBe(first);
    await expect(clientOn(fake).invites.preview(first)).resolves.toEqual({ state: 'expired' });
    await expect(clientOn(fake).invites.preview(second)).resolves.toMatchObject({ state: 'open' });
  });
});

describe('hand-off: signing in for a program on this machine', () => {
  const challenge = challengeOf('the-programs-own-verifier-that-never-leaves-it');

  it('signs in with the program\'s challenge and returns the code without trading it', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    const step = await client.signIn.handoff({ email: 'alice@acme.test', password: PASSWORD, codeChallenge: challenge });
    expect(step).toMatchObject({ done: true, code: expect.any(String) });
    expect(tokenCalls(fake)).toHaveLength(0);
    expect(client.session.get().status).toBe('signed-out');
    expect(fake.requests.find((request) => request.path.endsWith('/sign-in'))!.body).toMatchObject({ code_challenge: challenge });
  });

  it('asks which workspace, and still returns only the code', async () => {
    const { fake } = issuerWithPeople();
    const step = await clientOn(fake).signIn.handoff({ email: 'bob@acme.test', password: PASSWORD, codeChallenge: challenge });
    if (step.done) throw new Error('expected a step');
    await expect(step.choose('ws-globex')).resolves.toMatchObject({ done: true, code: expect.any(String) });
    expect(tokenCalls(fake)).toHaveLength(0);
  });

  it('refuses a challenge that is not S256', async () => {
    const { fake } = issuerWithPeople();
    await expect(clientOn(fake).signIn.handoff({ email: 'a@b.test', password: PASSWORD, codeChallenge: 'plain' })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it.each([
    ['http://127.0.0.1:53123/callback', true],
    ['http://[::1]:53123/callback', true],
    ['http://localhost:53123/callback', false],
    ['https://127.0.0.1:53123/callback', false],
    ['http://127.0.0.1/callback', false],
    ['http://evil.test:53123/callback', false],
    ['http://127.0.0.1.evil.test:53123/callback', false],
    ['http://127.0.0.1.evil.com:53123/callback', false],
    ['http://user@127.0.0.1:53123/callback', false],
    ['http://127.0.0.1@evil.test:53123/callback', false],
    ['http://127.0.0.1@evil.com/callback', false],
    ['http://127.0.0.1:53123/callback#x', false],
    ['http://[::ffff:127.0.0.1]:53123/callback', false],
    ['http://127.0.0.1:53123/', false],
    ['http://127.0.0.1:53123/cb', false],
    ['http://127.0.0.1:53123/callback/', false],
    ['http://127.0.0.1:53123/callback/x', false],
    ['http://127.0.0.1:53123/%63allback', false],
    ['http://127.0.0.1:53123/other/callback', false],
    ['not a url', false],
  ])('returns a code to %s: %s', (address, allowed) => {
    expect(isLoopbackRedirect(address)).toBe(allowed);
  });

  const query = (redirect: string, extra = '') =>
    `?code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirect)}&state=state-123456${extra}`;

  it('reads a hand-off request, and sends the code back with the state and the issuer', () => {
    const request = readHandoffRequest(query('http://127.0.0.1:5000/callback'));
    const back = new URL(handoffReturnUrl(request, 'the-code', 'https://bridge.test/identity-access/apps/app-1'));
    expect(back.origin + back.pathname).toBe('http://127.0.0.1:5000/callback');
    expect(back.searchParams.get('code')).toBe('the-code');
    expect(back.searchParams.get('state')).toBe('state-123456');
    expect(back.searchParams.get('iss')).toBe('https://bridge.test/identity-access/apps/app-1');
    expect(() => handoffReturnUrl(request, 'the-code', '')).toThrow(/issuer/);
  });

  it('refuses a callback other than /callback, and a parameter given twice', () => {
    expect(() => readHandoffRequest(query('http://127.0.0.1:5000/cb'))).toThrow(/callback/);
    expect(() => readHandoffRequest(query('http://127.0.0.1:5000/callback', `&redirect_uri=${encodeURIComponent('https://evil.test/callback')}`))).toThrow(/more than once/);
    expect(() => readHandoffRequest(query('http://127.0.0.1:5000/callback', '&state=another-state-1'))).toThrow(/more than once/);
    expect(() => readHandoffRequest(query('http://127.0.0.1:5000/callback', `&code_challenge=${challenge}`))).toThrow(/more than once/);
  });

  it('refuses a request that would send the code off the machine', () => {
    expect(() => readHandoffRequest(`code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fevil.test%2F&state=state-123456`)).toThrow(/loopback|127\.0\.0\.1/);
    expect(() => readHandoffRequest(`code_challenge=${challenge}&code_challenge_method=plain&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&state=state-123456`)).toThrow(/S256/);
    expect(() => readHandoffRequest(`code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback`)).toThrow(/state/);
  });
});

describe('email links', () => {
  it('reads the kind and token from the fragment', () => {
    expect(readEmailLink('https://app.test/auth#bridge=verify-email&token=abc')).toEqual({ kind: 'verify-email', token: 'abc' });
    expect(readEmailLink('#bridge=reset-password&token=t1')).toEqual({ kind: 'reset-password', token: 't1' });
    expect(readEmailLink('https://app.test/auth?token=abc')).toBeNull();
    expect(readEmailLink('#bridge=other&token=abc')).toBeNull();
    expect(readEmailLink('#bridge=invite&token=ws-1_abc')).toEqual({ kind: 'invite', token: 'ws-1_abc' });
  });
});

describe('takeEmailLink: the token leaves the address bar and the history', () => {
  function pageAt(url: string) {
    const at = new URL(url);
    const replaced: string[] = [];
    const win: EmailLinkWindow = {
      location: { hash: at.hash, pathname: at.pathname, search: at.search },
      history: { state: { kept: true }, replaceState: (_data, _unused, next) => void replaced.push(String(next)) },
    };
    return { win, replaced };
  }

  it('takes an invite link and replaces the address without its fragment, keeping the query', () => {
    const { win, replaced } = pageAt('https://app.test/auth/invite?lang=de#bridge=invite&token=ws-1_secret');
    expect(takeEmailLink('invite', win)).toEqual({ kind: 'invite', token: 'ws-1_secret' });
    expect(replaced).toEqual(['/auth/invite?lang=de']);
  });

  it('leaves a link of another kind, and any other fragment, where it is', () => {
    const other = pageAt('https://app.test/auth/invite#bridge=verify-email&token=t');
    expect(takeEmailLink('invite', other.win)).toBeNull();
    expect(other.replaced).toEqual([]);
    const plain = pageAt('https://app.test/docs#section-2');
    expect(takeEmailLink(undefined, plain.win)).toBeNull();
    expect(plain.replaced).toEqual([]);
  });

  it('takes any Bridge link without a kind, and nothing outside a browser', () => {
    const { win } = pageAt('https://app.test/auth#bridge=reset-password&token=r1');
    expect(takeEmailLink(undefined, win)).toEqual({ kind: 'reset-password', token: 'r1' });
    expect(takeEmailLink('invite', undefined)).toBeNull();
  });
});
