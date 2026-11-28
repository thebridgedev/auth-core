import { describe, expect, it } from 'vitest';
import { BridgeError, errorFromAnswer, fieldProblems, managedByProvider } from '../../core/errors.js';
import { ROUTES } from '../../core/routes.js';
import { needsRecheck } from '../../recheck.js';
import { readEmailLink } from '../../sign-in.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** Alice signed in just now, on an issuer that offers the email change. */
async function aliceSignedIn(options: Parameters<typeof issuerWithPeople>[0] = {}) {
  const { fake, alice, bob } = issuerWithPeople(options);
  const client = clientOn(fake, { linkAddress: 'https://app.acme.test/auth' });
  await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  return { fake, alice, bob, client };
}
const sent = (fake: Awaited<ReturnType<typeof aliceSignedIn>>['fake'], to: string, purpose: string) => fake.lastLink(to, purpose);

describe('my login: the address, who manages it, a change waiting', () => {
  it('reads the address and that it can be changed, with nothing waiting', async () => {
    const { client } = await aliceSignedIn();
    await expect(client.emailChange.status()).resolves.toEqual({ email: 'alice@acme.test', emailChangeable: true, managedBy: null, pendingChange: null });
  });

  it('an address Google manages is read-only: `managedBy` names it, and a change is `managed-by-provider` with the provider', async () => {
    const { fake } = issuerWithPeople();
    fake.addPerson({ email: 'sam@acme.test', password: PASSWORD, managedBy: 'google', workspaces: [{ id: 'ws-acme', name: 'Acme' }] });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'sam@acme.test', password: PASSWORD });
    await expect(client.emailChange.status()).resolves.toMatchObject({ emailChangeable: false, managedBy: 'google' });
    const refused = await client.emailChange.start('sam@newmail.test').catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'managed-by-provider', status: 409, code: 'managed_by_provider', provider: 'google' });
    expect(managedByProvider(refused)).toBe('google');
    expect(sent(fake, 'sam@acme.test', 'email-change')).toBeNull();
  });

  it('an issuer that does not offer it yet is `not-offered`, never a call to a made-up address', async () => {
    const { fake } = issuerWithPeople();
    fake.withoutEmailChange();
    const client = clientOn(fake);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await expect(client.emailChange.status()).rejects.toMatchObject({ kind: 'not-offered' });
    await expect(client.emailChange.start('alice@new.test')).rejects.toMatchObject({ kind: 'not-offered' });
    expect(fake.requests.some((each) => each.path.includes('email-change') || each.path.includes('/me/login'))).toBe(false);
  });
});

describe('changing the address: current inbox, then the new one', () => {
  it('asks, confirms in the current inbox, then the new one; the old address works until both are done', async () => {
    const { fake, client } = await aliceSignedIn();
    await expect(client.emailChange.start(' Alice@NewMail.test ')).resolves.toEqual({ next: 'confirm_current' });
    const asked = fake.requests.find((each) => each.method === 'POST' && each.path === '/v2/identity-access/me/email-change');
    expect(asked?.body).toMatchObject({ email: 'Alice@NewMail.test', link_address: 'https://app.acme.test/auth' });
    expect(asked?.headers['authorization']).toMatch(/^Bearer /);
    await expect(client.emailChange.status()).resolves.toMatchObject({ email: 'alice@acme.test', pendingChange: { newEmail: 'alice@newmail.test', stage: 'current' } });

    // The first link goes to the current inbox only.
    expect(sent(fake, 'alice@newmail.test', 'email-change')).toBeNull();
    const first = sent(fake, 'alice@acme.test', 'email-change')!;
    // The address still signs in while the new inbox has not confirmed.
    await expect(clientOn(fake).signIn.start({ email: 'alice@acme.test', password: PASSWORD })).resolves.toMatchObject({ done: true });

    await expect(client.emailChange.confirm(first)).resolves.toEqual({ next: 'confirm_new' });
    await expect(client.emailChange.status()).resolves.toMatchObject({ email: 'alice@acme.test', pendingChange: { stage: 'new' } });
    // A link works once.
    await expect(client.emailChange.confirm(first)).rejects.toMatchObject({ kind: 'link-invalid' });

    const second = sent(fake, 'alice@newmail.test', 'email-change')!;
    await expect(client.emailChange.confirm(second)).resolves.toEqual({ done: true, email: 'alice@newmail.test' });
    await expect(client.emailChange.status()).resolves.toEqual({ email: 'alice@newmail.test', emailChangeable: true, managedBy: null, pendingChange: null });
    expect(fake.emailChangeNotices).toContainEqual({ to: 'alice@acme.test', kind: 'changed', newEmail: 'alice@newmail.test' });
  });

  it('the links need no session: they work from a tab that is signed out, and send no token', async () => {
    const { fake, client } = await aliceSignedIn();
    await client.emailChange.start('alice@newmail.test');
    const elsewhere = clientOn(fake);
    await elsewhere.ready;
    await expect(elsewhere.emailChange.confirm(sent(fake, 'alice@acme.test', 'email-change')!)).resolves.toEqual({ next: 'confirm_new' });
    const confirm = fake.requests.filter((each) => each.path === `/v2/identity-access/apps/${fake.appId}/email-change/confirm`).at(-1)!;
    expect(confirm.headers['authorization']).toBeUndefined();
  });

  it('wants a recent sign-in: older than 10 minutes it is `reauthenticate`, and `recheck.guard` asks once, then the change goes on', async () => {
    const { fake, client } = await aliceSignedIn();
    fake.signedInLongAgo();
    const refused = await client.emailChange.start('alice@newmail.test').catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'reauthenticate', status: 401 });
    expect(needsRecheck(refused)).toBe(true);
    expect(client.session.get()).toMatchObject({ status: 'signed-in' });
    let asked = 0;
    await expect(client.recheck.guard(() => client.emailChange.start('alice@newmail.test'), async () => {
      asked += 1;
      await client.recheck.password(PASSWORD);
    })).resolves.toEqual({ next: 'confirm_current' });
    expect(asked).toBe(1);
  });

  it('a taken new address gets the same answers and no link: nothing says it has an account', async () => {
    const { fake, client } = await aliceSignedIn();
    await expect(client.emailChange.start('bob@acme.test')).resolves.toEqual({ next: 'confirm_current' });
    await expect(client.emailChange.confirm(sent(fake, 'alice@acme.test', 'email-change')!)).resolves.toEqual({ next: 'confirm_new' });
    expect(sent(fake, 'bob@acme.test', 'email-change')).toBeNull();
    await expect(client.emailChange.status()).resolves.toMatchObject({ email: 'alice@acme.test' });
  });

  it('a malformed address is `invalid`; cancelling stops the links', async () => {
    const { fake, client } = await aliceSignedIn();
    await expect(client.emailChange.start('not an address')).rejects.toMatchObject({ kind: 'invalid', status: 400 });
    await client.emailChange.start('alice@newmail.test');
    const first = sent(fake, 'alice@acme.test', 'email-change')!;
    await client.emailChange.cancel();
    expect(fake.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/v2/identity-access/me/email-change' });
    await expect(client.emailChange.status()).resolves.toMatchObject({ pendingChange: null });
    await expect(client.emailChange.confirm(first)).rejects.toMatchObject({ kind: 'link-invalid' });
  });
});

describe('"This wasn\'t me"', () => {
  it('puts the old address back, signs every device out and sends a link to set a new password', async () => {
    const { fake, client } = await aliceSignedIn();
    await client.emailChange.start('alice@newmail.test');
    await client.emailChange.confirm(sent(fake, 'alice@acme.test', 'email-change')!);
    await client.emailChange.confirm(sent(fake, 'alice@newmail.test', 'email-change')!);
    const revert = sent(fake, 'alice@acme.test', 'email-revert')!;
    expect(revert).not.toBeNull();

    await expect(clientOn(fake).emailChange.revert(revert)).resolves.toEqual({ next: 'reset_password' });
    expect(fake.person('alice@acme.test')).toBeDefined();
    expect(fake.person('alice@newmail.test')).toBeUndefined();
    expect(fake.sessions().filter((each) => each.user === fake.person('alice@acme.test')!.id).every((each) => each.ended)).toBe(true);
    expect(sent(fake, 'alice@acme.test', 'reset-password')).not.toBeNull();
    await expect(client.emailChange.status()).rejects.toMatchObject({ kind: 'signed-out' });
    // Once.
    await expect(clientOn(fake).emailChange.revert(revert)).rejects.toMatchObject({ kind: 'link-invalid' });
  });
});

describe('the pieces', () => {
  it('email-change and email-revert are links read from the fragment', () => {
    expect(readEmailLink('https://app.test/auth/email-change#bridge=email-change&token=abc')).toEqual({ kind: 'email-change', token: 'abc' });
    expect(readEmailLink('#bridge=email-revert&token=xyz')).toEqual({ kind: 'email-revert', token: 'xyz' });
  });

  it('every email-change route waits for Bridge to list it', () => {
    for (const route of [ROUTES.myLogin, ROUTES.emailChangeStart, ROUTES.emailChangeCancel, ROUTES.emailChangeConfirm, ROUTES.emailChangeRevert]) expect(route.pending).toBe('changing the email address');
  });

  it('managed_by_provider in either shape is `managed-by-provider` with the provider', () => {
    expect(errorFromAnswer(409, { error: 'managed_by_provider', provider: 'microsoft' })).toMatchObject({ kind: 'managed-by-provider', provider: 'microsoft' });
    expect(errorFromAnswer(409, { type: 'urn:bridge:problem:managed-by-provider', title: 'Managed', provider: 'apple' })).toMatchObject({ kind: 'managed-by-provider', provider: 'apple' });
    expect(managedByProvider(new BridgeError('conflict', 'x'))).toBeNull();
  });

  it('the profile reads and saves the person\'s own language and the app\'s fields', async () => {
    const { fake } = issuerWithPeople();
    fake.addPerson({ email: 'anna@acme.test', password: PASSWORD, firstName: 'Anna', customFields: [{ label: 'jobTitle', userLabel: 'Job title', type: 'text', value: 'Engineer' }], workspaces: [{ id: 'ws-acme', name: 'Acme' }] });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'anna@acme.test', password: PASSWORD });
    await expect(client.me.get()).resolves.toMatchObject({ language: null, customFields: [{ label: 'jobTitle', value: 'Engineer' }] });
    await expect(client.me.update({ language: 'sv', customFields: [{ label: 'jobTitle', value: 'Lead' }] })).resolves.toMatchObject({ language: 'sv', customFields: [{ value: 'Lead' }] });
    await expect(client.me.update({ language: 'xx' as never })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('a refused value of the app\'s fields names each wrong field, as Bridge answers it, and nothing is saved', async () => {
    const { fake } = issuerWithPeople();
    fake.addPerson({
      email: 'ben@acme.test',
      password: PASSWORD,
      customFields: [
        { label: 'employeeId', userLabel: 'Employee number', type: 'integer', value: null, editable: true },
        { label: 'costCentre', userLabel: 'Cost centre', type: 'text', value: 'CC-1', editable: false },
      ],
      workspaces: [{ id: 'ws-acme', name: 'Acme' }],
    });
    const client = clientOn(fake);
    await client.signIn.start({ email: 'ben@acme.test', password: PASSWORD });
    await expect(client.me.get()).resolves.toMatchObject({ customFields: [{ label: 'employeeId', editable: true }, { label: 'costCentre', editable: false }] });
    const refused = await client.me.update({ customFields: [{ label: 'employeeId', value: 'forty-two' }, { label: 'costCentre', value: 'CC-9' }] }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'invalid', status: 400 });
    expect(fieldProblems(refused)).toEqual({ employeeId: 'Employee number must be a valid integer.', costCentre: 'Cost centre cannot be changed here.' });
    await expect(client.me.get()).resolves.toMatchObject({ customFields: [{ value: null }, { value: 'CC-1' }] });
    await expect(client.me.update({ customFields: [{ label: 'employeeId', value: '42' }] })).resolves.toMatchObject({ customFields: [{ value: '42' }, { value: 'CC-1' }] });
    // The same reading of Bridge's own answer.
    expect(fieldProblems(errorFromAnswer(400, { type: 'urn:bridge:problem:bad-request', title: 'Bad request', status: 400, fields: [{ label: 'badge', message: 'badge must be in the field\'s pattern.' }, { label: 1 }] }))).toEqual({ badge: "badge must be in the field's pattern." });
    expect(fieldProblems(new Error('x'))).toEqual({});
  });
});
