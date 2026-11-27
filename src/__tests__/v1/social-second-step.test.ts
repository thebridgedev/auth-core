import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../core/storage.js';
import { readSocialReturn, takeSocialReturn, type EmailLinkWindow } from '../../sign-in.js';
import { clientOn, issuerWithPeople, PASSWORD, tokenCalls } from './helpers.js';

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const PAGE = 'https://app.acme.test/auth';

describe('social sign-in', () => {
  it('starts with this device\'s challenge and the page to come back to, and finishes only in that browser', async () => {
    const { fake } = issuerWithPeople({ social: ['google', 'github'] });
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    expect((await client.signIn.options()).social).toEqual(['google', 'github']);
    const url = await client.social.start('google', { returnPage: PAGE });
    const start = fake.requests.find((request) => request.path.endsWith('/social/start'))!;
    expect(start.body).toMatchObject({ provider: 'google', intent: 'sign-in', code_challenge_method: 'S256', return_page: PAGE });
    const back = fake.socialReturn(url, { email: 'alice@acme.test' });
    expect(back.startsWith(`${PAGE}#bridge=social&state=`)).toBe(true);
    const answer = readSocialReturn(back);
    expect(answer).toMatchObject({ state: expect.any(String) as unknown, code: expect.any(String) as unknown });
    // Another browser holds no verifier: refused.
    await expect(clientOn(fake).social.finish(answer!)).rejects.toMatchObject({ kind: 'wrong-device' });
    await expect(client.social.finish(answer!)).resolves.toEqual({ done: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'alice@acme.test' } });
    const exchange = tokenCalls(fake, 'authorization_code').at(-1)!.body as { code_verifier: string };
    expect(challengeOf(exchange.code_verifier)).toBe((start.body as { code_challenge: string }).code_challenge);
  });

  it('a sign-up names the screen\'s language, so the new User keeps it and its emails come in it; a sign-in names none', async () => {
    const { fake } = issuerWithPeople({ social: ['google'] });
    const client = clientOn(fake, { language: 'da' });
    const starts = () => fake.requests.filter((request) => request.path.endsWith('/social/start'));
    await client.social.start('google', { returnPage: PAGE, intent: 'sign-up' });
    expect(starts().at(-1)!.body).toMatchObject({ intent: 'sign-up', language: 'da' });
    await client.social.start('google', { returnPage: PAGE });
    expect(starts().at(-1)!.body).not.toHaveProperty('language');
  });

  it('signs up an address with no account only when asked to sign up; a provider\'s unverified address or a cancel is an error', async () => {
    const { fake } = issuerWithPeople({ social: ['google'] });
    const client = clientOn(fake);
    const signIn = await client.social.start('google', { returnPage: PAGE });
    await expect(client.social.finish(readSocialReturn(fake.socialReturn(signIn, { email: 'new@acme.test' }))!)).rejects.toMatchObject({ code: 'no_account' });
    const signUp = await client.social.start('google', { returnPage: PAGE, intent: 'sign-up', plan: 'pro' });
    expect(fake.requests.filter((request) => request.path.endsWith('/social/start')).at(-1)!.body).toMatchObject({ intent: 'sign-up', plan: 'pro' });
    await expect(client.social.finish(readSocialReturn(fake.socialReturn(signUp, { email: 'new@acme.test' }))!)).resolves.toEqual({ done: true });
    const other = clientOn(fake);
    const unverified = await other.social.start('google', { returnPage: PAGE });
    await expect(other.social.finish(readSocialReturn(fake.socialReturn(unverified, { email: 'bob@acme.test', verified: false }))!)).rejects.toMatchObject({ code: 'email_not_verified' });
    await expect(other.social.finish({ error: 'access_denied' })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('a provider that does not confirm the address (Facebook) answers verify_email: the link finishes the sign-up on this device, an existing address gets the same answer', async () => {
    const { fake } = issuerWithPeople({ social: ['facebook'] });
    const storage = memoryStorage();
    const client = clientOn(fake, { storage });
    const url = await client.social.start('facebook', { returnPage: PAGE, intent: 'sign-up' });
    const step = await client.social.finish(readSocialReturn(fake.socialReturn(url, { email: 'fresh@acme.test', unconfirmed: true }))!);
    expect(step).toEqual({ done: false, next: 'verify_email', email: 'fresh@acme.test' });
    expect(client.session.get()).toMatchObject({ status: 'signed-out' });
    // The verifier waits where the link's tab reads it, as after a password sign-up; the social one is gone.
    expect(await storage.get(`bridge:${fake.issuer}:social`)).toBeNull();
    expect(await storage.get(`bridge:${fake.issuer}:sign-up`)).not.toBeNull();
    const token = fake.lastLink('fresh@acme.test', 'verify-sign-up')!;
    // Another browser holds no verifier: refused; this one finishes and is signed in.
    await expect(clientOn(fake).signUp.finish(token)).rejects.toMatchObject({ kind: 'wrong-device' });
    await expect(client.signUp.finish(token)).resolves.toMatchObject({ done: true });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', user: { email: 'fresh@acme.test' } });
    // An address that has an account is never linked by the provider's say-so, and is answered as a password sign-up answers it.
    const again = await client.social.start('facebook', { returnPage: PAGE, intent: 'sign-up' });
    await expect(client.social.finish(readSocialReturn(fake.socialReturn(again, { email: 'alice@acme.test', unconfirmed: true }))!)).resolves.toEqual({ done: false, next: 'verify_email', email: 'alice@acme.test' });
    expect(fake.lastLink('alice@acme.test', 'verify-sign-up')).toBeNull();
  });

  it('takes the provider\'s answer from the address and clears it, and only a social one', () => {
    const replaced: string[] = [];
    const win = (hash: string): EmailLinkWindow => ({ location: { hash, pathname: '/auth', search: '?x=1' }, history: { state: null, replaceState: (_d, _u, url) => void replaced.push(String(url)) } });
    expect(takeSocialReturn(win('#bridge=magic-link&token=abc'))).toBeNull();
    expect(takeSocialReturn(win('#bridge=social&state=s1&code=c1'))).toEqual({ state: 's1', code: 'c1' });
    expect(takeSocialReturn(win('#bridge=social&error=server_error'))).toEqual({ error: 'provider_error' });
    expect(replaced).toEqual(['/auth?x=1', '/auth?x=1']);
  });
});

describe('the text-message second step', () => {
  it('sets up a phone with a code, gives the backup code once, then asks for a code at every sign-in', async () => {
    const { fake } = issuerWithPeople();
    fake.addPerson({ email: 'mfa@acme.test', password: PASSWORD, workspaces: [{ id: 'ws-safe', name: 'Safe', mfa: true }] });
    const client = clientOn(fake);
    const setup = await client.signIn.start({ email: 'mfa@acme.test', password: PASSWORD });
    expect(setup).toMatchObject({ done: false, next: 'second_step_setup' });
    if (setup.done || setup.next !== 'second_step_setup') return;
    const step = await setup.setUp('+46 70 123 45 67');
    expect(step).toMatchObject({ done: false, next: 'second_step', phone: '+46 •••• 67', sent: true });
    if (step.done || step.next !== 'second_step') return;
    await expect(step.verify('000000')).rejects.toMatchObject({ code: 'wrong_code' });
    await expect(step.verify(fake.lastText('+46701234567')!)).resolves.toEqual({ done: true, backupCode: 'BACK-UPCO-DE12' });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', workspace: { id: 'ws-safe' } });

    const again = await clientOn(fake).signIn.start({ email: 'mfa@acme.test', password: PASSWORD });
    expect(again).toMatchObject({ next: 'second_step', phone: '+46 •••• 67' });
    if (again.done || again.next !== 'second_step') return;
    const resent = await again.resend();
    if (resent.done || resent.next !== 'second_step') throw new Error('expected the code step');
    const reset = await resent.reset('BACK-UPCO-DE12');
    expect(reset).toMatchObject({ done: false, next: 'second_step_setup' });
  });
});
