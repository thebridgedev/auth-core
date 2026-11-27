import { describe, expect, it } from 'vitest';
import { errorFromAnswer } from '../../core/errors.js';
import { memoryStorage } from '../../core/storage.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

const LEAKED = 'Password123!';
const signUpBody = (fake: ReturnType<typeof issuerWithPeople>['fake']) => [...fake.requests].reverse().find((request) => request.path.endsWith('/sign-up'))?.body as Record<string, unknown>;

describe("login security: Bridge's refusals, typed (TBP-83, TBP-84, TBP-85)", () => {
  it('names a suspended person and a blocked domain, whatever the error they come with', () => {
    expect(errorFromAnswer(403, { error: 'access_denied', reason: 'user_suspended' })).toMatchObject({ kind: 'suspended', code: 'user_suspended', status: 403 });
    expect(errorFromAnswer(403, { error: 'access_denied', reason: 'domain_blocked' })).toMatchObject({ kind: 'domain-blocked', code: 'domain_blocked' });
    // Another access_denied stays forbidden.
    expect(errorFromAnswer(403, { error: 'access_denied', reason: 'not_a_member' })).toMatchObject({ kind: 'forbidden', code: 'not_a_member' });
  });

  it("names sign-up protection's and the bot check's refusals", () => {
    expect(errorFromAnswer(400, { error: 'permanent_email_required', error_description: 'Please use a permanent email address.' })).toMatchObject({ kind: 'permanent-email-required', message: 'Please use a permanent email address.' });
    expect(errorFromAnswer(400, { error: 'bot_check_failed' })).toMatchObject({ kind: 'bot-check-failed', code: 'bot_check_failed' });
  });

  it("names a leaked password with the app's setting, and a sign-in that needs a new one", () => {
    expect(errorFromAnswer(400, { error: 'password_leaked', mode: 'warn' })).toMatchObject({ kind: 'password-leaked', leakedPasswords: 'warn' });
    expect(errorFromAnswer(400, { error: 'password_leaked', mode: 'refuse' })).toMatchObject({ kind: 'password-leaked', leakedPasswords: 'refuse' });
    expect(errorFromAnswer(400, { error: 'password_leaked', mode: 'other' })).toMatchObject({ kind: 'password-leaked', leakedPasswords: null });
    expect(errorFromAnswer(403, { error: 'password_change_required', reason: 'leaked_password' })).toMatchObject({ kind: 'password-change-required', code: 'leaked_password', leakedPasswords: null });
    // Every other error has no setting.
    expect(errorFromAnswer(400, { error: 'wrong_credentials' }).leakedPasswords).toBeNull();
  });
});

describe('sign-in options: the bot check and the support contact', () => {
  it('carries them only when the app has them', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    const plain = await client.signIn.options();
    expect(plain.botCheck).toBeUndefined();
    expect(plain.supportContact).toBeUndefined();
    fake.requireBotCheck('1x00000000000000000000AA');
    fake.setSupportContact('support@acme.test');
    await expect(client.signIn.options()).resolves.toMatchObject({ botCheck: { provider: 'turnstile', siteKey: '1x00000000000000000000AA' }, supportContact: 'support@acme.test' });
  });
});

describe('sign-up protection and the bot check (TBP-83)', () => {
  it("sends the bot check's answer, the form's time and the hidden field; leaves them out when not given", async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signUp.start({ email: 'carol@acme.test', password: PASSWORD, turnstileToken: 'tok-1', formMs: 4321.6, website: '' });
    expect(signUpBody(fake)).toMatchObject({ turnstileToken: 'tok-1', formMs: 4322, website: '' });
    await client.signUp.start({ email: 'dan@acme.test', password: PASSWORD });
    const plain = signUpBody(fake);
    expect(plain).not.toHaveProperty('turnstileToken');
    expect(plain).not.toHaveProperty('formMs');
    expect(plain).not.toHaveProperty('website');
    expect(plain).not.toHaveProperty('acceptLeaked');
    // A time that is no time is not sent.
    await client.signUp.start({ email: 'eve@acme.test', password: PASSWORD, formMs: Number.NaN, turnstileToken: '' });
    expect(signUpBody(fake)).not.toHaveProperty('formMs');
    expect(signUpBody(fake)).not.toHaveProperty('turnstileToken');
  });

  it('is refused without the bot check on Block, and for a throwaway address, before any email', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    fake.requireBotCheck('1x00000000000000000000AA');
    await expect(client.signUp.start({ email: 'carol@acme.test', password: PASSWORD })).rejects.toMatchObject({ kind: 'bot-check-failed' });
    fake.markThrowaway('mailinator.test');
    await expect(client.signUp.start({ email: 'bot@mailinator.test', password: PASSWORD, turnstileToken: 'ok' })).rejects.toMatchObject({ kind: 'permanent-email-required' });
    expect(fake.lastLink('carol@acme.test', 'verify-sign-up')).toBeNull();
    expect(fake.lastLink('bot@mailinator.test', 'verify-sign-up')).toBeNull();
    await expect(client.signUp.start({ email: 'carol@acme.test', password: PASSWORD, turnstileToken: 'ok' })).resolves.toEqual({ next: 'verify_email' });
  });

  it('never gives a social sign-in the bot check', async () => {
    const { fake } = issuerWithPeople({ social: ['google'] });
    fake.requireBotCheck('1x00000000000000000000AA');
    const client = clientOn(fake);
    await client.social.start('google', { intent: 'sign-up', returnPage: 'https://app.test/auth/sign-in' });
    const start = [...fake.requests].reverse().find((request) => request.path.endsWith('/social/start'));
    expect(start?.body).not.toHaveProperty('turnstileToken');
  });
});

describe('blocked domains and suspension (TBP-84)', () => {
  it('refuses a sign-up from a blocked domain at the first step, with no email', async () => {
    const { fake } = issuerWithPeople();
    fake.blockDomain('spam.test');
    const client = clientOn(fake);
    await expect(client.signUp.start({ email: 'bot@spam.test', password: PASSWORD })).rejects.toMatchObject({ kind: 'domain-blocked' });
    expect(fake.lastLink('bot@spam.test', 'verify-sign-up')).toBeNull();
  });

  it('answers suspended at sign-in, with the right password', async () => {
    const { fake } = issuerWithPeople();
    fake.suspend('alice@acme.test');
    await expect(clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD })).rejects.toMatchObject({ kind: 'suspended' });
    fake.resume('alice@acme.test');
    await expect(clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
  });
});

describe('leaked passwords (TBP-85)', () => {
  it('on Warn, a new leaked password is refused until the person confirms it, everywhere a password is set', async () => {
    const { fake } = issuerWithPeople();
    fake.leakPasswords([LEAKED], 'warn');
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await expect(client.signUp.start({ email: 'carol@acme.test', password: LEAKED })).rejects.toMatchObject({ kind: 'password-leaked', leakedPasswords: 'warn' });
    await expect(client.signUp.start({ email: 'carol@acme.test', password: LEAKED, acceptLeaked: true })).resolves.toEqual({ next: 'verify_email' });
    expect(signUpBody(fake)).toMatchObject({ acceptLeaked: true });

    await client.password.forgot('alice@acme.test');
    const reset = fake.lastLink('alice@acme.test', 'reset-password')!;
    await expect(client.password.set(reset, LEAKED)).rejects.toMatchObject({ kind: 'password-leaked', leakedPasswords: 'warn' });
    await expect(client.password.set(reset, LEAKED, { acceptLeaked: true })).resolves.toBeUndefined();
  });

  it('on Refuse, confirming does not help', async () => {
    const { fake } = issuerWithPeople();
    fake.leakPasswords([LEAKED], 'refuse');
    await expect(clientOn(fake).signUp.start({ email: 'carol@acme.test', password: LEAKED, acceptLeaked: true })).rejects.toMatchObject({ kind: 'password-leaked', leakedPasswords: 'refuse' });
  });

  it('signing in on Warn signs in and says so, also through the workspace choice', async () => {
    const { fake } = issuerWithPeople();
    fake.leakPasswords([PASSWORD], 'warn');
    await expect(clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true, passwordLeaked: true });
    const client = clientOn(fake);
    const step = await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD });
    if (step.done || step.next !== 'workspace') throw new Error('expected the workspace choice');
    expect(step.passwordLeaked).toBe(true);
    await expect(step.choose('ws-globex')).resolves.toEqual({ done: true, passwordLeaked: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in' });
  });

  it('signing in on Refuse makes no session and asks for a new password', async () => {
    const { fake } = issuerWithPeople();
    fake.leakPasswords([PASSWORD], 'refuse');
    const client = clientOn(fake);
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).rejects.toMatchObject({ kind: 'password-change-required', code: 'leaked_password' });
    expect(client.session.get().status).not.toBe('signed-in');
  });

  it('a sign-in without a leaked password says nothing', async () => {
    const { fake } = issuerWithPeople();
    const step = await clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    expect(step).not.toHaveProperty('passwordLeaked');
    expect(step).not.toHaveProperty('alreadyHadAccount');
  });
});

describe('signing up again with an address that has an account (TBP-87)', () => {
  it('adds a workspace below the limit, and signs in with a note at it', async () => {
    const { fake } = issuerWithPeople();
    fake.setWorkspaceLimit(2);
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    await client.signUp.start({ email: 'Alice@Acme.test', password: 'another password 1', workspace: "Alice's side project" });
    await expect(clientOn(fake, { storage }).signUp.finish(fake.lastLink('alice@acme.test', 'verify-sign-up')!)).resolves.toEqual({ done: true });
    expect(fake.person('alice@acme.test')?.workspaces.map((each) => each.name)).toEqual(['Acme', "Alice's side project"]);
    // The repeat sign-up never changed the password.
    expect(fake.person('alice@acme.test')?.password).toBe(PASSWORD);

    await client.signUp.start({ email: 'alice@acme.test', password: 'another password 1', workspace: 'A third' });
    const step = await clientOn(fake, { storage }).signUp.finish(fake.lastLink('alice@acme.test', 'verify-sign-up')!);
    if (step.done || step.next !== 'workspace') throw new Error('expected the workspace choice');
    expect(step.alreadyHadAccount).toBe(true);
    await expect(step.choose(step.workspaces[0]!.id)).resolves.toEqual({ done: true, alreadyHadAccount: true });
    expect(fake.person('alice@acme.test')?.workspaces).toHaveLength(2);
  });
});

describe('access taken away reaches the app\'s own server calls (TBP-240)', () => {
  const pageLocation = { href: 'https://app.test/dashboard', origin: 'https://app.test' };

  /** The app's own server, as one on a 1.0 backend plugin: refuses a token Bridge took back with 401 `revoked`. */
  function appServer(fake: ReturnType<typeof issuerWithPeople>['fake'], refuse: (token: string) => boolean) {
    const seen: string[] = [];
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, pageLocation.href);
      if (url.origin !== 'https://bridge.test') {
        const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
        seen.push(token);
        return Promise.resolve(refuse(token) ? Response.json({ statusCode: 401, code: 'revoked' }, { status: 401 }) : Response.json({ ok: true }));
      }
      return fake.fetch(input, init);
    }) as typeof fetch;
    return { fetchFn, seen };
  }

  it('picks up a fresh token by itself after a refusal (a role or plan change), and the call goes through', async () => {
    (globalThis as { location?: unknown }).location = pageLocation;
    try {
      const { fake } = issuerWithPeople();
      let taken: string | null = null;
      const server = appServer(fake, (token) => token === taken);
      const client = clientOn(fake, { fetch: server.fetchFn });
      await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
      expect((await client.fetch('/api/notes')).status).toBe(200);
      // The role changed: Bridge took back the token the app holds.
      taken = server.seen[0]!;
      const answer = await client.fetch('/api/notes');
      expect(answer.status).toBe(200);
      expect(server.seen).toHaveLength(3);
      expect(server.seen[2]).not.toBe(taken);
      expect(client.session.get().status).toBe('signed-in');
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });

  it('a suspended person ends signed out: renewing is refused, and the refusal is handed on', async () => {
    (globalThis as { location?: unknown }).location = pageLocation;
    try {
      const { fake } = issuerWithPeople();
      const server = appServer(fake, () => fake.person('alice@acme.test') !== undefined && suspended);
      let suspended = false;
      const client = clientOn(fake, { fetch: server.fetchFn });
      await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
      fake.suspend('alice@acme.test');
      suspended = true;
      const answer = await client.fetch('/api/notes');
      expect(answer.status).toBe(401);
      expect(client.session.get()).toMatchObject({ status: 'signed-out', reason: 'access-removed' });
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });
});
