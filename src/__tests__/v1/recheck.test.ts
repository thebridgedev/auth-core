import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { needsRecheck } from '../../recheck.js';
import { fakeWebAuthn } from '../../testing/index.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

/** An issuer whose PATCH /v2/accounts/me wants a sign-in within 5 minutes, and Alice signed in an hour ago. */
async function aliceSignedInLongAgo(methods: readonly string[] = ['password', 'magicLink', 'passkeys'], device = fakeWebAuthn()) {
  // Bridge's clock, which a test moves on: a token's sign-in time is in whole seconds.
  let offset = 0;
  const { fake } = issuerWithPeople({ methods, recheck: { routes: ['PATCH /v2/accounts/me'], maxAgeSeconds: 300 }, now: () => Date.now() + offset });
  const later = (ms: number) => void (offset += ms);
  const signUpStorage = memoryStorage();
  const client = clientOn(fake, { webauthn: device, signUpStorage });
  await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  fake.signedInLongAgo();
  later(2000);
  return { fake, client, device, signUpStorage, later };
}
const rename = (client: Awaited<ReturnType<typeof aliceSignedInLongAgo>>['client']) => client.me.update({ firstName: 'Alicia' });
const meCalls = (fake: Awaited<ReturnType<typeof aliceSignedInLongAgo>>['fake']) => fake.requests.filter((each) => each.method === 'PATCH' && each.path === '/v2/accounts/me');

describe('confirming it is you', () => {
  it('an action that wants a recent sign-in is `reauthenticate`, never a sign-out; the person stays signed in', async () => {
    const { client } = await aliceSignedInLongAgo();
    const refused = await rename(client).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'reauthenticate', status: 401 });
    expect(needsRecheck(refused)).toBe(true);
    expect(client.session.get()).toMatchObject({ status: 'signed-in' });
  });

  it('lists the ways the app offers, in its sign-in page\'s order', async () => {
    const { client } = await aliceSignedInLongAgo(['passkeys', 'password']);
    await expect(client.recheck.methods()).resolves.toEqual(['password', 'passkeys']);
  });

  it('by password: the session\'s next token carries the new sign-in time, and the action passes; a wrong password is `wrong-credentials`', async () => {
    const { client } = await aliceSignedInLongAgo();
    const before = (await client.recheck.signedInAt()) ?? 0;
    await expect(client.recheck.password('not it')).rejects.toMatchObject({ kind: 'wrong-credentials' });
    await client.recheck.password(PASSWORD);
    expect(await client.recheck.signedInAt()).toBeGreaterThan(before + 1000);
    await expect(rename(client)).resolves.toMatchObject({ firstName: 'Alicia' });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'alice@acme.test' } });
  });

  it('by passkey: the options name only the person\'s own passkeys, and the answer confirms', async () => {
    const device = fakeWebAuthn();
    const { client, fake } = await aliceSignedInLongAgo(undefined, device);
    const added = await client.passkeys.add('Laptop');
    fake.signedInLongAgo();
    await client.recheck.passkey();
    const options = fake.requests.filter((each) => each.path === '/v2/identity-access/recheck/passkey-options');
    expect(options).toHaveLength(1);
    const answered = fake.requests.filter((each) => each.path === '/v2/identity-access/recheck').at(-1)!;
    expect((answered.body as { passkey: { id: string } }).passkey.id).toBe(added.id);
    await expect(rename(client)).resolves.toMatchObject({ firstName: 'Alicia' });
  });

  it('by a link to the person\'s address: opened on this device it renews this session instead of signing in again, and the page waiting for it goes on', async () => {
    const { client, fake } = await aliceSignedInLongAgo();
    await expect(client.recheck.email()).resolves.toEqual({ next: 'verify_email' });
    const waiting = client.recheck.emailOpened({ everyMs: 60_000 });
    const link = fake.lastLink('alice@acme.test', 'magic-link')!;
    const sessionsBefore = fake.requests.filter((each) => each.path.endsWith('/token') && (each.body as { grant_type?: string }).grant_type === 'authorization_code').length;
    await expect(client.magicLink.finish(link)).resolves.toEqual({ done: true, rechecked: true });
    await expect(waiting).resolves.toBeUndefined();
    expect(fake.requests.filter((each) => each.path.endsWith('/token') && (each.body as { grant_type?: string }).grant_type === 'authorization_code')).toHaveLength(sessionsBefore);
    await expect(rename(client)).resolves.toMatchObject({ firstName: 'Alicia' });
    // Once.
    await expect(client.magicLink.finish(link)).rejects.toMatchObject({ kind: 'link-invalid' });
  });

  it('a link opened on another device confirms nothing', async () => {
    const { client, fake } = await aliceSignedInLongAgo();
    await client.recheck.email();
    const link = fake.lastLink('alice@acme.test', 'magic-link')!;
    await expect(clientOn(fake).magicLink.finish(link)).rejects.toMatchObject({ kind: 'wrong-device' });
    await expect(rename(client)).rejects.toMatchObject({ kind: 'reauthenticate' });
  });

  it('waiting for a link stops when the page cancels', async () => {
    const { client } = await aliceSignedInLongAgo();
    const stop = new AbortController();
    const waiting = client.recheck.emailOpened({ signal: stop.signal, everyMs: 60_000 });
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('guard: runs the action, asks once when it needs a recent sign-in, and runs it again; a cancelled ask and any other error are thrown', async () => {
    const { client, fake } = await aliceSignedInLongAgo();
    let asked = 0;
    await expect(client.recheck.guard(() => rename(client), async () => void (asked += 1, await client.recheck.password(PASSWORD)))).resolves.toMatchObject({ firstName: 'Alicia' });
    expect(asked).toBe(1);
    expect(meCalls(fake)).toHaveLength(2);
    fake.signedInLongAgo();
    const cancelled = new Error('cancelled');
    await expect(client.recheck.guard(() => rename(client), () => Promise.reject(cancelled))).rejects.toBe(cancelled);
    const other = new Error('other');
    let askedAgain = 0;
    await expect(client.recheck.guard(() => Promise.reject(other), async () => void (askedAgain += 1))).rejects.toBe(other);
    expect(askedAgain).toBe(0);
  });
});
