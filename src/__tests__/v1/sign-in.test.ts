import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { handoffReturnUrl, isLoopbackRedirect, readHandoffRequest } from '../../handoff.js';
import { readEmailLink } from '../../sign-in.js';
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

  it('sends an invite only when one is given', async () => {
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

describe('invites and sign-in options wait for the issuer', () => {
  it('answers not-offered while the issuer does not list them', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await expect(client.signIn.options()).rejects.toMatchObject({ kind: 'not-offered' });
    await expect(client.invites.preview('t')).rejects.toMatchObject({ kind: 'not-offered' });
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
    ['http://127.0.0.1.evil.test:53123/', false],
    ['http://user@127.0.0.1:53123/', false],
    ['not a url', false],
  ])('returns a code to %s: %s', (address, allowed) => {
    expect(isLoopbackRedirect(address)).toBe(allowed);
  });

  it('reads a hand-off request, and sends the code back with the state', () => {
    const request = readHandoffRequest(`?code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:5000/cb')}&state=state-123456`);
    expect(handoffReturnUrl(request, 'the-code')).toBe('http://127.0.0.1:5000/cb?code=the-code&state=state-123456');
  });

  it('refuses a request that would send the code off the machine', () => {
    expect(() => readHandoffRequest(`code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fevil.test%2F&state=state-123456`)).toThrow(/loopback|127\.0\.0\.1/);
    expect(() => readHandoffRequest(`code_challenge=${challenge}&code_challenge_method=plain&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2F&state=state-123456`)).toThrow(/S256/);
    expect(() => readHandoffRequest(`code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2F`)).toThrow(/state/);
  });
});

describe('email links', () => {
  it('reads the kind and token from the fragment', () => {
    expect(readEmailLink('https://app.test/auth#bridge=verify-email&token=abc')).toEqual({ kind: 'verify-email', token: 'abc' });
    expect(readEmailLink('#bridge=reset-password&token=t1')).toEqual({ kind: 'reset-password', token: 't1' });
    expect(readEmailLink('https://app.test/auth?token=abc')).toBeNull();
    expect(readEmailLink('#bridge=other&token=abc')).toBeNull();
  });
});
