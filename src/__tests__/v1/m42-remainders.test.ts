import { describe, expect, it } from 'vitest';
import { errorFromAnswer, needsUserVerification, socialRefusal } from '../../core/errors.js';
import { memoryStorage } from '../../core/storage.js';
import { readSocialReturn } from '../../sign-in.js';
import { hostedPageRedirect, signedOutTarget, signInPlaceOf, signsInOnHostedPage } from '../../sign-in-place.js';
import { fakeWebAuthn } from '../../testing/index.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

const PAGE = 'https://app.acme.test/auth';
const HOSTED = 'https://auth.bridge.test/sign-in/app-1/';
const inApp = { location: 'app', main: 'https://acme-demo.com', path: '/auth/login', emailLinks: 'app', url: 'https://acme-demo.com/auth/login', signedOutUrl: 'https://acme-demo.com/auth/login' } as const;
const onHosted = { location: 'hosted', main: 'https://acme-demo.com', path: '/auth/login', emailLinks: 'hosted', url: HOSTED, signedOutUrl: HOSTED } as const;

describe('where users sign in (TBP-871)', () => {
  it('reads the place from the sign-in options, and none for an app from before the setting', async () => {
    const { fake } = issuerWithPeople({ signIn: onHosted });
    const options = await clientOn(fake).signIn.options();
    expect(signInPlaceOf(options)).toEqual({ ...onHosted, returnPath: '/auth/oauth-callback' });
    expect(signInPlaceOf({ signIn: { ...onHosted, returnPath: '/back' } as never })?.returnPath).toBe('/back');
    expect(signsInOnHostedPage(options)).toBe(true);
    expect(signInPlaceOf(await clientOn(issuerWithPeople().fake).signIn.options())).toBeNull();
    expect(signInPlaceOf({ signIn: { location: 'nowhere' } as never })).toBeNull();
  });

  it('sign-out lands on Bridge\'s page only when users sign in there; otherwise where the app says', () => {
    expect(signedOutTarget({ signIn: onHosted }, '/')).toBe(HOSTED);
    expect(signedOutTarget({ signIn: inApp }, '/')).toBe('/');
    expect(signedOutTarget({}, '/bye')).toBe('/bye');
  });

  it('Bridge\'s page sends "in your app" users to the app\'s sign-in page, but never a sign-in request, and never to itself', () => {
    expect(hostedPageRedirect({ signIn: inApp }, HOSTED, false)).toBe('https://acme-demo.com/auth/login');
    expect(hostedPageRedirect({ signIn: inApp }, HOSTED, true)).toBeNull();
    expect(hostedPageRedirect({ signIn: onHosted }, HOSTED, false)).toBeNull();
    expect(hostedPageRedirect({ signIn: inApp }, 'https://acme-demo.com/auth/login?x=1', false)).toBeNull();
    expect(hostedPageRedirect({ signIn: { ...inApp, url: null } }, HOSTED, false)).toBeNull();
    expect(hostedPageRedirect({}, HOSTED, false)).toBeNull();
  });
});

describe('named refusals (TBP-59, TBP-859, TBP-216)', () => {
  it('tells a passkey without a PIN or fingerprint apart', () => {
    const error = errorFromAnswer(400, { error: 'passkey_needs_verification', error_description: 'needs a PIN' });
    expect(needsUserVerification(error)).toBe(true);
    expect(needsUserVerification(errorFromAnswer(400, { error: 'passkey_refused' }))).toBe(false);
  });

  it('keeps Microsoft\'s refusal and the provider\'s cause as code and reason', () => {
    expect(socialRefusal(errorFromAnswer(403, { error: 'microsoft_account_not_allowed', reason: 'personal' }))).toEqual({ code: 'microsoft_account_not_allowed', reason: 'personal' });
    expect(errorFromAnswer(403, { error: 'microsoft_account_not_allowed', reason: 'work' })).toMatchObject({ kind: 'forbidden', code: 'microsoft_account_not_allowed', reason: 'work' });
    expect(socialRefusal(errorFromAnswer(400, { error: 'provider_error', reason: 'secret_expired' }))).toEqual({ code: 'provider_error', reason: 'secret_expired' });
    expect(socialRefusal(errorFromAnswer(400, { error: 'provider_error' }))).toBeNull();
    // Other refusals keep their reason as their code, as before.
    expect(errorFromAnswer(403, { error: 'refused', reason: 'invite_for_another_address' })).toMatchObject({ code: 'invite_for_another_address', reason: null });
  });

  it('names the rules a new password broke', () => {
    expect(errorFromAnswer(400, { error: 'password_rules', failed: ['minLength', 'blockCommon'] }).failed).toEqual(['minLength', 'blockCommon']);
  });

  it('reads the provider error\'s reason from the return, and nothing that is not a short word', () => {
    expect(readSocialReturn('#bridge=social&error=provider_error&reason=admin_approval_needed')).toEqual({ error: 'provider_error', reason: 'admin_approval_needed' });
    expect(readSocialReturn('#bridge=social&error=provider_error&reason=%3Cscript%3E')).toEqual({ error: 'provider_error' });
  });
});

describe('social sign-in remainders (TBP-134, D24)', () => {
  it('no_account names the provider used, for a one-click "Create an account with …"', async () => {
    const { fake } = issuerWithPeople({ social: ['google'] });
    const client = clientOn(fake);
    const url = await client.social.start('google', { returnPage: PAGE });
    await expect(client.social.finish(readSocialReturn(fake.socialReturn(url, { email: 'new@acme.test' }))!)).rejects.toMatchObject({ code: 'no_account', reason: 'google' });
  });

  it('link required: an address with an account links the provider once the person signs in the way they already do, on this device', async () => {
    const { fake } = issuerWithPeople({ social: ['facebook'] });
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    const url = await client.social.start('facebook', { returnPage: PAGE });
    await expect(client.social.finish(readSocialReturn(fake.socialReturn(url, { email: 'alice@acme.test', unconfirmed: true }))!)).resolves.toEqual({ done: false, next: 'verify_email', email: 'alice@acme.test' });
    expect(fake.linkedProviders('alice@acme.test')).toEqual([]);
    // Another browser holds no waiting link: its sign-in links nothing.
    await expect(clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
    expect(fake.linkedProviders('alice@acme.test')).toEqual([]);
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true, linked: { provider: 'facebook', name: 'Facebook' } });
    expect(fake.linkedProviders('alice@acme.test')).toEqual(['facebook']);
    // Used once.
    await client.signOut();
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
  });

  it('a waiting link for an address of someone else links nothing and never fails the sign-in', async () => {
    const { fake } = issuerWithPeople({ social: ['facebook'] });
    const client = clientOn(fake);
    const url = await client.social.start('facebook', { returnPage: PAGE });
    await client.social.finish(readSocialReturn(fake.socialReturn(url, { email: 'bob@acme.test', unconfirmed: true }))!);
    await expect(client.signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
    expect(fake.linkedProviders('alice@acme.test')).toEqual([]);
  });
});

describe('passkeys (TBP-861)', () => {
  it('renames a passkey and tells the browser which are still the person\'s after the list and after a removal', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'] });
    const webauthn = fakeWebAuthn();
    const client = clientOn(fake, { webauthn });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    const first = await client.passkeys.add('Laptop');
    const second = await client.passkeys.add('Phone');
    await expect(client.passkeys.rename(first.id, 'Work laptop')).resolves.toMatchObject({ id: first.id, name: 'Work laptop', usable: true });
    const listed = await client.passkeys.list();
    expect(listed.map((each) => each.name)).toEqual(['Phone', 'Work laptop']);
    expect(webauthn.signals.at(-1)).toMatchObject({ kind: 'accepted', rpId: 'localhost', ids: [second.id, first.id] });
    await client.passkeys.remove(first.id);
    expect(webauthn.signals.at(-1)).toMatchObject({ kind: 'accepted', rpId: 'localhost', ids: [second.id] });
  });

  it('tells the browser the person\'s new name for their passkeys, once per domain', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'] });
    const webauthn = fakeWebAuthn();
    const client = clientOn(fake, { webauthn });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.passkeys.add('Laptop');
    await client.passkeys.add('Phone');
    const before = webauthn.signals.length;
    await client.passkeys.signalCurrentUser('alice@acme.test', 'Alice Liddell');
    const details = webauthn.signals.slice(before);
    expect(details).toEqual([{ kind: 'details', rpId: 'localhost', userId: expect.any(String) as unknown, name: 'alice@acme.test', displayName: 'Alice Liddell' }]);
  });

  it('tells the browser to stop offering a passkey Bridge does not know', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'passkeys'] });
    const webauthn = fakeWebAuthn();
    const client = clientOn(fake, { webauthn });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    const made = await client.passkeys.add('Laptop');
    await client.passkeys.remove(made.id);
    await client.signOut();
    webauthn.use(made.id);
    await expect(client.passkeys.signIn()).rejects.toMatchObject({ code: 'unknown_passkey' });
    expect(webauthn.signals.at(-1)).toEqual({ kind: 'unknown', rpId: 'localhost', credentialId: made.id });
  });
});
