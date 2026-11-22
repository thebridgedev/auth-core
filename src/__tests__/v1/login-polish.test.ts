import { describe, expect, it } from 'vitest';
import { fakeWebAuthn } from '../../testing/index.js';
import { languageField } from '../../sign-in.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** TBP-870: emails in the screen's language. TBP-864: the terms line in the sign-in options. TBP-55: link preview. */

describe('the screen\'s language goes with every request that makes an email (TBP-870)', () => {
  it('sends a language tag with sign-up, sign-in link, recovery and passkey setup link', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'magicLink', 'passkeys'] });
    const bridge = clientOn(fake, { language: 'da', webauthn: fakeWebAuthn() });
    await bridge.signUp.start({ email: 'new@acme.test', password: PASSWORD });
    await bridge.magicLink.start('alice@acme.test');
    await bridge.password.forgot('alice@acme.test');
    await bridge.passkeys.setupLink.request('alice@acme.test');
    expect(fake.sentLinks.map((link) => [link.purpose, link.language])).toEqual([
      ['verify-sign-up', 'da'],
      ['magic-link', 'da'],
      ['reset-password', 'da'],
      ['passkey-setup', 'da'],
    ]);
  });

  it('asks a function each time, so a screen that changes language is followed', async () => {
    const { fake } = issuerWithPeople();
    let language = 'nb';
    const bridge = clientOn(fake, { language: () => language });
    await bridge.password.forgot('alice@acme.test');
    language = 'sv-SE';
    await bridge.password.forgot('alice@acme.test');
    expect(fake.sentLinks.map((link) => link.language)).toEqual(['nb', 'sv-SE']);
  });

  it('sends none when the app names none, and leaves out a value that is no language tag', async () => {
    const { fake } = issuerWithPeople();
    await clientOn(fake).password.forgot('alice@acme.test');
    await clientOn(fake, { language: 'not a tag!' }).password.forgot('alice@acme.test');
    expect(fake.sentLinks.every((link) => link.language === undefined)).toBe(true);
    expect(languageField('nb')).toEqual({ language: 'nb' });
    expect(languageField('sv_SE')).toEqual({ language: 'sv_SE' });
    expect(languageField(undefined)).toEqual({});
    expect(languageField('x'.repeat(30))).toEqual({});
  });
});

describe('the terms line (TBP-864)', () => {
  it('lists the app\'s two pages as signUpNotice when the app shows the line', async () => {
    const notice = { terms: 'https://acme.test/terms', privacy: 'https://acme.test/privacy' };
    const { fake } = issuerWithPeople({ signUpNotice: notice });
    expect((await clientOn(fake).signIn.options()).signUpNotice).toEqual(notice);
  });

  it('lists none when the line is off', async () => {
    const { fake } = issuerWithPeople();
    expect((await clientOn(fake).signIn.options()).signUpNotice).toBeUndefined();
  });
});

describe('what an email link is, without using it (TBP-55)', () => {
  it('says open with the step, and using it afterwards still works: the preview spent nothing', async () => {
    const { fake } = issuerWithPeople();
    const bridge = clientOn(fake);
    await bridge.password.forgot('alice@acme.test');
    const token = fake.lastLink('alice@acme.test', 'reset-password')!;
    await expect(bridge.links.preview(token)).resolves.toEqual({ state: 'open', step: 'reset-password' });
    await expect(bridge.links.preview(token)).resolves.toEqual({ state: 'open', step: 'reset-password' });
    await bridge.password.set(token, 'a brand new password');
    await expect(bridge.links.preview(token)).resolves.toEqual({ state: 'used' });
  });

  it('names the step of each kind of link', async () => {
    const { fake } = issuerWithPeople({ methods: ['password', 'magicLink', 'passkeys'] });
    const bridge = clientOn(fake, { webauthn: fakeWebAuthn() });
    await bridge.signUp.start({ email: 'new@acme.test', password: PASSWORD });
    await bridge.magicLink.start('alice@acme.test');
    await bridge.passkeys.setupLink.request('bob@acme.test');
    await expect(bridge.links.preview(fake.lastLink('new@acme.test', 'verify-sign-up')!)).resolves.toEqual({ state: 'open', step: 'verify-email' });
    await expect(bridge.links.preview(fake.lastLink('alice@acme.test', 'magic-link')!)).resolves.toEqual({ state: 'open', step: 'magic-link' });
    await expect(bridge.links.preview(fake.lastLink('bob@acme.test', 'passkey-setup')!)).resolves.toEqual({ state: 'open', step: 'passkey-setup' });
  });

  it('says expired for a link past its time or one that names no link', async () => {
    let now = Date.now();
    const { fake } = issuerWithPeople({ now: () => now });
    const bridge = clientOn(fake);
    await bridge.magicLink.start('alice@acme.test');
    const token = fake.lastLink('alice@acme.test', 'magic-link')!;
    now += 16 * 60 * 1000;
    await expect(bridge.links.preview(token)).resolves.toEqual({ state: 'expired' });
    await expect(bridge.links.preview('nothing')).resolves.toEqual({ state: 'expired' });
  });

  it('puts the token in the body, never in the address', async () => {
    const { fake } = issuerWithPeople();
    const bridge = clientOn(fake);
    await bridge.links.preview('secret-token-1234567');
    const sent = fake.requests.find((each) => each.path.endsWith('/links/preview'))!;
    expect(sent.method).toBe('POST');
    expect(sent.path).not.toContain('secret-token');
    expect(sent.body).toEqual({ token: 'secret-token-1234567' });
  });

  it('is not offered by an issuer that lists no sign-in options', async () => {
    const { fake } = issuerWithPeople({ metadata: 'standard' });
    await expect(clientOn(fake).links.preview('x')).rejects.toMatchObject({ kind: 'not-offered' });
  });
});
