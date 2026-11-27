import { describe, expect, it } from 'vitest';
import { codeRefusal, errorFromAnswer, isPasswordChangeRequired, isPasswordExpired } from '../../core/errors.js';
import { memoryStorage } from '../../core/storage.js';
import { emailConfirmationOf, type SignInStep } from '../../sign-in.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** Email codes, the second step's ways, remembered devices, the Security settings and changing a password. */

const second = (step: SignInStep) => {
  if (step.done || step.next !== 'second_step') throw new Error(`expected the second step, got ${JSON.stringify(step)}`);
  return step;
};

describe('email codes: signing in', () => {
  it('reads how the app proves an address: code, or link (also from an older Bridge that says nothing)', async () => {
    expect(emailConfirmationOf(await clientOn(issuerWithPeople({ emailConfirmation: 'code' }).fake).signIn.options())).toBe('code');
    expect(emailConfirmationOf(await clientOn(issuerWithPeople().fake).signIn.options())).toBe('link');
    expect(emailConfirmationOf({})).toBe('link');
    expect(emailConfirmationOf(null)).toBe('link');
  });

  it('emails a code, shows the masked address, signs in with it on this device only', async () => {
    const { fake } = issuerWithPeople({ emailConfirmation: 'code' });
    const client = clientOn(fake);
    const step = await client.emailCode.request('alice@acme.test');
    expect(step).toMatchObject({ done: false, next: 'verify_code', email: 'a…@acme.test', expiresIn: 600, resendIn: 60 });
    const sent = fake.lastCode('alice@acme.test', 'sign-in')!;
    expect(sent).toMatch(/^\d{6}$/);
    await expect(step.verify(`${sent.slice(0, 3)} ${sent.slice(3)}`)).resolves.toEqual({ done: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'alice@acme.test' } });
    const verify = fake.requests.find((request) => request.path.endsWith('/email-code/verify'))!;
    expect(verify.body).toMatchObject({ code: sent, code_verifier: expect.any(String) as unknown });
  });

  it('answers the same for an address with no account, and a wrong code says how many tries are left, then that it expired', async () => {
    const { fake } = issuerWithPeople({ emailConfirmation: 'code' });
    const client = clientOn(fake);
    const nobody = await client.emailCode.request('nobody@acme.test');
    expect(nobody).toMatchObject({ next: 'verify_code', email: 'n…@acme.test' });
    expect(fake.lastCode('nobody@acme.test')).toBeNull();
    const step = await client.emailCode.request('alice@acme.test');
    const first = await step.verify('000000').catch((error: unknown) => error);
    expect(first).toMatchObject({ kind: 'invalid', code: 'wrong_code', triesLeft: 4 });
    expect(codeRefusal(first)).toEqual({ reason: 'wrong', triesLeft: 4 });
    for (let i = 0; i < 4; i += 1) await step.verify('000000').catch(() => undefined);
    const spent = await step.verify(fake.lastCode('alice@acme.test')!).catch((error: unknown) => error);
    expect(codeRefusal(spent)).toEqual({ reason: 'expired' });
  });

  it('a new code waits 60 seconds: too soon is rate-limited with the seconds left, from the body when the header is hidden', async () => {
    let clock = 1_000_000;
    const { fake } = issuerWithPeople({ emailConfirmation: 'code', now: () => clock });
    const client = clientOn(fake);
    const step = await client.emailCode.request('alice@acme.test');
    const early = await step.resend().catch((error: unknown) => error);
    expect(early).toMatchObject({ kind: 'rate-limited', code: 'too_soon', retryAfterSeconds: 60 });
    expect(codeRefusal(early)).toEqual({ reason: 'too-soon', retryAfterSeconds: 60 });
    clock += 61_000;
    const again = await step.resend();
    expect(again).toMatchObject({ next: 'verify_code', resendIn: 60 });
    await expect(again.verify(fake.lastCode('alice@acme.test')!)).resolves.toMatchObject({ done: true });
  });

  it('an app on links refuses codes; a link app\'s sign-up and forgot password are unchanged', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await expect(client.emailCode.request('alice@acme.test')).rejects.toMatchObject({ kind: 'forbidden', code: 'method_disabled' });
    await expect(client.signUp.start({ email: 'new@acme.test', password: PASSWORD })).resolves.toEqual({ next: 'verify_email' });
    await expect(client.password.forgot('alice@acme.test')).resolves.toBeUndefined();
  });
});

describe('email codes: signing up and forgot password', () => {
  it('a sign-up on a code app is finished with its code, and signs in', async () => {
    const { fake } = issuerWithPeople({ emailConfirmation: 'code' });
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    const step = await client.signUp.start({ email: 'carol@acme.test', password: PASSWORD, workspace: 'Carol Co' });
    if (!('verify' in step)) throw new Error('expected the code step');
    expect(step).toMatchObject({ next: 'verify_code', email: 'c…@acme.test' });
    // Nothing waits for a link.
    expect(await storage.get(`bridge:${fake.issuer}:sign-up`)).toBeNull();
    await expect(step.verify(fake.lastCode('carol@acme.test', 'sign-up')!)).resolves.toMatchObject({ done: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'carol@acme.test' } });
  });

  it('a sign-up without a password asks for one once the code is right, and finishes without the code', async () => {
    const { fake } = issuerWithPeople({ emailConfirmation: 'code' });
    const client = clientOn(fake);
    const step = await client.signUp.start({ email: 'dave@acme.test' });
    if (!('verify' in step)) throw new Error('expected the code step');
    await expect(step.verify(fake.lastCode('dave@acme.test')!)).rejects.toMatchObject({ code: 'password_required' });
    await expect(step.choosePassword('short')).rejects.toMatchObject({ code: 'password_rules', failed: ['minLength'] });
    await expect(step.choosePassword(PASSWORD)).resolves.toMatchObject({ done: true });
    const last = fake.requests.filter((request) => request.path.endsWith('/sign-up/code')).at(-1)!;
    expect(Object.keys(last.body as object).sort()).toEqual(['code_verifier', 'flow', 'password']);
  });

  it('forgot password on a code app: the code gives a reset token, the new password signs nobody in', async () => {
    const { fake } = issuerWithPeople({ emailConfirmation: 'code' });
    const client = clientOn(fake);
    const step = await client.password.forgot('alice@acme.test');
    expect(step).toMatchObject({ next: 'verify_code', email: 'a…@acme.test' });
    const reset = await step!.verify(fake.lastCode('alice@acme.test', 'reset')!);
    expect(reset).toEqual({ next: 'reset_password', token: expect.any(String) as unknown, expiresIn: 600 });
    await client.password.set(reset.token, 'a brand new password');
    expect(client.session.get()).toMatchObject({ status: 'signed-out' });
    await expect(client.signIn.start({ email: 'alice@acme.test', password: 'a brand new password' })).resolves.toMatchObject({ done: true });
  });
});

describe('the second step\'s ways', () => {
  const mfaIssuer = (extra: Parameters<typeof issuerWithPeople>[0] = {}) => {
    const made = issuerWithPeople({ mfa: { methods: ['totp', 'email', 'sms'], rememberDeviceDays: 30 }, ...extra });
    made.fake.addPerson({ email: 'eve@acme.test', password: PASSWORD, totp: true, phone: '+46701234567', workspaces: [{ id: 'ws-safe', name: 'Safe', mfa: true }] });
    return made;
  };

  it('asks for the authenticator app first, offers the other ways, and finishes with its code', async () => {
    const { fake } = mfaIssuer();
    const client = clientOn(fake);
    const step = second(await client.signIn.start({ email: 'eve@acme.test', password: PASSWORD }));
    expect(step).toMatchObject({ method: 'totp', methods: ['totp', 'sms', 'email'], rememberDays: 30, recovery: false, phone: '' });
    await expect(step.verify('000000')).rejects.toMatchObject({ code: 'wrong_code', triesLeft: 4 });
    await expect(step.verify(fake.authenticatorCode('eve@acme.test')!)).resolves.toEqual({ done: true });
  });

  it('"Use another way": an email code, sent to the masked address', async () => {
    const { fake } = mfaIssuer();
    const client = clientOn(fake);
    const step = second(await client.signIn.start({ email: 'eve@acme.test', password: PASSWORD }));
    const byEmail = second(await step.chooseMethod('email'));
    expect(byEmail).toMatchObject({ method: 'email', email: 'e…@acme.test', sent: true, resendIn: 60 });
    await expect(byEmail.resend()).rejects.toMatchObject({ code: 'too_soon' });
    await expect(byEmail.verify(fake.lastCode('eve@acme.test', 'second-step')!)).resolves.toEqual({ done: true });
    expect(fake.requests.find((request) => request.path.endsWith('/second-step/method'))!.body).toEqual({ flow: expect.any(String) as unknown, method: 'email' });
  });

  it('remembers this device when asked: the next sign-in here sends it and skips the step; elsewhere it still asks', async () => {
    const { fake } = mfaIssuer();
    const storage = memoryStorage();
    const client = clientOn(fake, { storage, signUpStorage: storage });
    const step = second(await client.signIn.start({ email: 'eve@acme.test', password: PASSWORD }));
    await expect(step.verify(fake.authenticatorCode('eve@acme.test')!, { remember: true })).resolves.toEqual({ done: true, rememberedForDays: 30 });
    expect(fake.requests.filter((request) => request.path.endsWith('/second-step')).at(-1)!.body).toMatchObject({ remember: true });
    await client.signOut();
    await expect(client.signIn.start({ email: 'eve@acme.test', password: PASSWORD })).resolves.toEqual({ done: true });
    expect(fake.requests.filter((request) => request.path.endsWith('/sign-in')).at(-1)!.body).toMatchObject({ device: expect.any(String) as unknown });
    await expect(clientOn(fake).signIn.start({ email: 'eve@acme.test', password: PASSWORD })).resolves.toMatchObject({ next: 'second_step' });
  });

  it('a remembered device past its days is not sent, and is forgotten', async () => {
    let clock = 1_000_000;
    const { fake } = mfaIssuer({ now: () => clock });
    const storage = memoryStorage();
    const client = clientOn(fake, { storage, signUpStorage: storage });
    await second(await client.signIn.start({ email: 'eve@acme.test', password: PASSWORD })).verify(fake.authenticatorCode('eve@acme.test')!, { remember: true });
    await client.signOut();
    // The SDK reads Date.now for the device's days: put the stored expiry in the past.
    const key = `bridge:${fake.issuer}:device`;
    const kept = JSON.parse(String(await storage.get(key))) as { device: string; expiresAt: number };
    await storage.set(key, JSON.stringify({ ...kept, expiresAt: Date.now() - 1 }));
    clock += 1;
    await expect(client.signIn.start({ email: 'eve@acme.test', password: PASSWORD })).resolves.toMatchObject({ next: 'second_step' });
    expect(fake.requests.filter((request) => request.path.endsWith('/sign-in')).at(-1)!.body).not.toHaveProperty('device');
    expect(await storage.get(key)).toBeNull();
  });

  it('sets up an authenticator app on the way: the QR address and the key, its first code, recovery codes shown once; a recovery code works once', async () => {
    const { fake } = issuerWithPeople({ mfa: { methods: ['totp'], rememberDeviceDays: 0 } });
    fake.addPerson({ email: 'new@acme.test', password: PASSWORD, workspaces: [{ id: 'ws-safe', name: 'Safe', mfa: true }] });
    const client = clientOn(fake);
    const setup = await client.signIn.start({ email: 'new@acme.test', password: PASSWORD });
    expect(setup).toMatchObject({ next: 'second_step_setup', methods: ['totp'] });
    if (setup.done || setup.next !== 'second_step_setup') return;
    const scan = second(await setup.setUpTotp());
    expect(scan.setup).toEqual({ secret: 'JBSW Y3DP EHPK 3PXP', uri: expect.stringMatching(/^otpauth:\/\/totp\//) as unknown });
    const done = await scan.verify(fake.authenticatorCode('new@acme.test')!);
    expect(done).toMatchObject({ done: true });
    if (!done.done) return;
    expect(done.recoveryCodes).toHaveLength(10);
    await client.signOut();
    const again = second(await client.signIn.start({ email: 'new@acme.test', password: PASSWORD }));
    expect(again.recovery).toBe(true);
    await expect(again.useRecoveryCode('nope')).rejects.toMatchObject({ code: 'wrong_recovery_code' });
    await expect(again.useRecoveryCode(done.recoveryCodes![0]!)).resolves.toEqual({ done: true, recoveryCodesLeft: 9 });
    const third = second(await clientOn(fake).signIn.start({ email: 'new@acme.test', password: PASSWORD }));
    await expect(third.useRecoveryCode(done.recoveryCodes![0]!)).rejects.toMatchObject({ code: 'wrong_recovery_code' });
  });

  it('an older Bridge that names no way is the text message, with its backup code', async () => {
    const { fake } = issuerWithPeople();
    fake.addPerson({ email: 'sms@acme.test', password: PASSWORD, phone: '+46701234567', workspaces: [{ id: 'ws-safe', name: 'Safe', mfa: true }] });
    const step = second(await clientOn(fake).signIn.start({ email: 'sms@acme.test', password: PASSWORD }));
    expect(step).toMatchObject({ method: 'sms', methods: ['sms'], rememberDays: 0, recovery: true, phone: '+46 •••• 67' });
  });
});

describe('the Security settings', () => {
  const signedIn = async (extra: Parameters<typeof issuerWithPeople>[0] = {}) => {
    const made = issuerWithPeople({ mfa: { methods: ['totp', 'email', 'sms'], rememberDeviceDays: 30 }, ...extra });
    const storage = memoryStorage();
    const client = clientOn(made.fake, { storage, signUpStorage: storage });
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    return { ...made, client, storage };
  };

  it('adds an authenticator app with its first code, gives recovery codes once, uses it first, and turns it on for oneself', async () => {
    const { fake, client } = await signedIn();
    const before = await client.security.status();
    expect(before).toMatchObject({ available: true, on: false, setUp: false, allowed: ['totp', 'email', 'sms'], strongest: 'totp', methods: [{ method: 'email', first: true, email: 'a…@acme.test' }] });
    const started = await client.security.totp.start();
    expect(started.uri).toMatch(/^otpauth:\/\//);
    await expect(client.security.totp.confirm('000000')).rejects.toMatchObject({ code: 'wrong_code' });
    const added = await client.security.totp.confirm(fake.authenticatorCode('alice@acme.test')!);
    expect(added.recoveryCodes).toHaveLength(10);
    expect(added.methods[0]).toMatchObject({ method: 'totp', first: true });
    const on = await client.security.change({ on: true });
    expect(on).toMatchObject({ on: true, self: true });
    const first = await client.security.change({ first: 'email' });
    expect(first.methods[0]).toMatchObject({ method: 'email', first: true });
    const codes = await client.security.newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(codes).not.toEqual(added.recoveryCodes);
    expect((await client.security.remove('totp')).setUp).toBe(false);
  });

  it('adds a phone with a texted code; turning it on with no way set up says to set one up first', async () => {
    const { fake, client } = await signedIn({ mfa: { methods: ['totp', 'sms'] } });
    await expect(client.security.change({ on: true })).rejects.toMatchObject({ code: 'set_up_first' });
    await expect(client.security.sms.start('070')).rejects.toMatchObject({ code: 'invalid_phone' });
    await expect(client.security.sms.start('+46 70 123 45 67')).resolves.toEqual({ phone: '+46 •••• 67', sent: true });
    const added = await client.security.sms.confirm(fake.lastText('+46701234567')!);
    expect(added.methods).toEqual([{ method: 'sms', first: true, phone: '+46 •••• 67', setUpAt: null }]);
  });

  it('forgets remembered devices, this one too', async () => {
    const { fake, client, storage } = await signedIn();
    fake.person('alice@acme.test')!.totp = true;
    fake.person('alice@acme.test')!.mfaSelf = true;
    await client.signOut();
    const step = second(await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD }));
    await step.verify(fake.authenticatorCode('alice@acme.test')!, { remember: true });
    expect((await client.security.status()).rememberedDevices).toBe(1);
    await client.security.forgetDevices();
    expect(await storage.get(`bridge:${fake.issuer}:device`)).toBeNull();
    expect((await client.security.status()).rememberedDevices).toBe(0);
  });

  it('a change that needs a recent sign-in is refused as reauthenticate, which the recheck flow confirms', async () => {
    const { fake, client } = await signedIn({ recheck: { routes: ['POST /v2/identity-access/second-step/totp'] } });
    fake.signedInLongAgo();
    await expect(client.security.totp.start()).rejects.toMatchObject({ kind: 'reauthenticate' });
    await expect(client.recheck.guard(() => client.security.totp.start(), () => client.recheck.password(PASSWORD))).resolves.toMatchObject({ uri: expect.stringMatching(/^otpauth/) as unknown });
  });
});

describe('changing the password and an expired one', () => {
  it('changes with the current password, refuses a wrong one and one used recently, and ends the other sessions only', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    const other = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await other.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await expect(client.password.change({ current: 'wrong', password: 'another long password' })).rejects.toMatchObject({ kind: 'invalid', code: 'wrong_password' });
    await expect(client.password.change({ current: PASSWORD, password: PASSWORD })).rejects.toMatchObject({ code: 'password_rules', failed: ['history'] });
    await client.password.change({ current: PASSWORD, password: 'another long password' });
    expect(fake.sessions().filter((each) => !each.ended)).toHaveLength(1);
    await expect(client.password.change({ password: PASSWORD })).rejects.toMatchObject({ code: 'password_rules', failed: ['history'] });
  });

  it('without the current password, needs a recent sign-in', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    fake.signedInLongAgo();
    await expect(client.password.change({ password: 'another long password' })).rejects.toMatchObject({ kind: 'reauthenticate' });
  });

  it('an expired password is a password that must change, with the reason expired', async () => {
    const { fake } = issuerWithPeople();
    fake.expirePassword('alice@acme.test');
    const error = await clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD }).catch((caught: unknown) => caught);
    expect(isPasswordChangeRequired(error)).toBe(true);
    expect(isPasswordExpired(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'forbidden', code: 'password_change_required', reason: 'expired' });
    expect(fake.lastLink('alice@acme.test', 'reset-password')).not.toBeNull();
    // Rules that changed: not expired.
    expect(isPasswordExpired(errorFromAnswer(403, { error: 'password_change_required', failed: ['minLength'] }))).toBe(false);
    expect(isPasswordChangeRequired(errorFromAnswer(403, { error: 'password_change_required', failed: ['minLength'] }))).toBe(true);
  });
});
