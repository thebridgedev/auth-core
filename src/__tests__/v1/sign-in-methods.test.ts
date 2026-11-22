import { describe, expect, it } from 'vitest';
import { BridgeError, isPasswordChangeRequired, passkeyHandOver } from '../../index.js';
import { errorFromAnswer } from '../../core/errors.js';
import { fakeWebAuthn } from '../../testing/index.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** Passkeys on the app's own domain, the Continue click for returns to localhost, and passwords that must change. */

const REQUEST_RETURN = 'http://127.0.0.1:53123/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('a passkey sign-in on Bridge\'s own pages is handed over to the app\'s sign-in page', () => {
  it('reads the refusal: passkey_on_app_page with the app\'s sign-in address', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'], passkeysBelongTo: 'https://app.acme.test/auth/login' });
    const onBridgesPage: typeof fetch = (input, init) => fake.fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), origin: 'https://bridge.test' } });
    const client = clientOn(fake, { fetch: onBridgesPage, webauthn: fakeWebAuthn() });
    const error = await client.passkeys.signIn().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect(passkeyHandOver(error)).toBe('https://app.acme.test/auth/login');
    expect(error).toMatchObject({ kind: 'conflict', status: 409, code: 'passkey_on_app_page' });
  });

  it('says nothing for any other error, and never takes an address that is not http(s) or has credentials', () => {
    expect(passkeyHandOver(new BridgeError('conflict', 'x', { code: 'passkey_exists' }))).toBeNull();
    expect(passkeyHandOver(new Error('x'))).toBeNull();
    for (const bad of ['javascript:alert(1)', 'https://user:pw@app.acme.test/', '/relative', 42, undefined]) {
      expect(passkeyHandOver(errorFromAnswer(409, { error: 'passkey_on_app_page', sign_in_url: bad }))).toBeNull();
    }
  });

  it('on the app\'s own page the sign-in goes on as before', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'], passkeysBelongTo: 'https://app.acme.test/auth/login' });
    const client = clientOn(fake, { webauthn: fakeWebAuthn() });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.passkeys.add('Laptop');
    await client.signOut();
    await expect(client.passkeys.signIn()).resolves.toMatchObject({ done: true });
  });
});

describe('passkeys made for another domain say so', () => {
  it('lists usable: false for a passkey made on the old page, and true for the others', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'] });
    const client = clientOn(fake, { webauthn: fakeWebAuthn() });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.passkeys.add('Old');
    fake.retirePasskeys();
    await client.passkeys.add('New');
    const listed = await client.passkeys.list();
    expect(listed.map((each) => [each.name, each.usable])).toEqual([['New', true], ['Old', false]]);
  });

  it('takes a server that says nothing about it as usable', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'] });
    const client = clientOn(fake, { webauthn: fakeWebAuthn() });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.passkeys.add('Laptop');
    expect((await client.passkeys.list())[0]?.usable).toBe(true);
  });
});

describe('a return to localhost in production asks for a click', () => {
  async function signInOnRequest(confirmReturn: boolean) {
    const { fake } = issuerWithPeople({ returns: [REQUEST_RETURN], confirmReturn });
    const bridge = clientOn(fake);
    const start = await fake.fetch(`${fake.issuer.replace('/identity-access/', '/v2/identity-access/')}/sign-in-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code_challenge: CHALLENGE, code_challenge_method: 'S256', redirect_uri: REQUEST_RETURN, state: 'state-0001' }) });
    const { request } = (await start.json()) as { request: string };
    await bridge.request.use(request);
    return bridge.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  }

  it('answers with the return and confirmReturn, so the page shows a Continue button', async () => {
    const step = await signInOnRequest(true);
    expect(step).toMatchObject({ done: true, confirmReturn: true });
    const back = new URL((step as { handoff: string }).handoff);
    expect(back.origin).toBe('http://127.0.0.1:53123');
    expect(back.searchParams.get('state')).toBe('state-0001');
  });

  it('goes straight back when Bridge does not ask for a click', async () => {
    const step = await signInOnRequest(false);
    expect(step).toMatchObject({ done: true });
    expect((step as { confirmReturn?: true }).confirmReturn).toBeUndefined();
    expect((step as { handoff?: string }).handoff).toContain('http://127.0.0.1:53123/callback');
  });
});

describe('a password that no longer meets the app\'s rules must be changed', () => {
  it('reads password_change_required with the rules it breaks, and a link to choose a new one was sent', async () => {
    const { fake } = issuerWithPeople();
    fake.requirePasswordChange('alice@acme.test', ['minLength', 'requireDigit']);
    const client = clientOn(fake);
    const error = await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD }).catch((caught: unknown) => caught);
    expect(isPasswordChangeRequired(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'forbidden', status: 403, code: 'password_change_required', failed: ['minLength', 'requireDigit'] });
    expect(fake.lastLink('alice@acme.test', 'reset-password')).toBeTruthy();
  });

  it('is not what a wrong password or any other refusal looks like', async () => {
    const { fake } = issuerWithPeople();
    const wrong = await clientOn(fake).signIn.start({ email: 'alice@acme.test', password: 'nope nope nope' }).catch((caught: unknown) => caught);
    expect(isPasswordChangeRequired(wrong)).toBe(false);
    expect(isPasswordChangeRequired(new Error('x'))).toBe(false);
  });

  it('after choosing a new password the person signs in', async () => {
    const { fake } = issuerWithPeople();
    fake.requirePasswordChange('alice@acme.test');
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD }).catch(() => undefined);
    const link = fake.lastLink('alice@acme.test', 'reset-password')!;
    await client.password.set(link, 'a much longer password 123');
    await expect(client.signIn.start({ email: 'alice@acme.test', password: 'a much longer password 123' })).resolves.toMatchObject({ done: true });
  });
});
