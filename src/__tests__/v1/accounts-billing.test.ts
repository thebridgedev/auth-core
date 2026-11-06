import { describe, expect, it } from 'vitest';
import { billingNotice, readCheckoutReturn, type BillingFacts } from '../../billing.js';
import { clientOn, issuerWithPeople, PASSWORD } from './helpers.js';

async function aliceClient() {
  const { fake, alice, bob } = issuerWithPeople();
  const client = clientOn(fake);
  await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  return { fake, client, alice, bob };
}

describe('accounts: the person, workspaces and the team, over REST', () => {
  it('reads and updates the person', async () => {
    const { client, fake } = await aliceClient();
    await expect(client.me.get()).resolves.toMatchObject({ email: 'alice@acme.test', firstName: 'Alice' });
    await expect(client.me.update({ firstName: 'Alicia' })).resolves.toMatchObject({ firstName: 'Alicia' });
    const patch = fake.requests.find((request) => request.method === 'PATCH' && request.path === '/v2/accounts/me')!;
    expect(patch.body).toEqual({ firstName: 'Alicia' });
    expect(patch.headers['authorization']).toMatch(/^Bearer /);
  });

  it('lists the workspaces with names for a chooser, and switches', async () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD, workspace: 'ws-acme' });
    const workspaces = await client.workspaces.list();
    expect(workspaces.map((each) => each.name)).toEqual(['Acme', 'Globex']);
    await client.workspaces.switch('ws-globex');
    expect(client.session.get()).toMatchObject({ workspace: { id: 'ws-globex' } });
  });

  it('refuses a switch to a workspace the person is not in, and keeps the session', async () => {
    const { client } = await aliceClient();
    await expect(client.workspaces.switch('ws-globex')).rejects.toMatchObject({ kind: 'forbidden' });
    expect(client.session.get()).toMatchObject({ status: 'signed-in', workspace: { id: 'ws-acme' } });
  });

  it('creates a workspace', async () => {
    const { client } = await aliceClient();
    await expect(client.workspaces.create({ name: 'New Co' })).resolves.toMatchObject({ name: 'New Co' });
  });

  it('lists members, invites and the roles the person may give', async () => {
    const { client, fake } = await aliceClient();
    await expect(client.team.members.list({ limit: 50 })).resolves.toHaveLength(2);
    expect(fake.requests.some((request) => request.path === '/v2/accounts/members?limit=50')).toBe(true);
    const invite = await client.team.invites.create({ email: 'erin@acme.test', role: 'MEMBER' });
    await expect(client.team.invites.list()).resolves.toHaveLength(1);
    await expect(client.team.invites.revoke(invite.id)).resolves.toEqual({ revoked: true });
    await expect(client.team.roles.list({ assignable: true })).resolves.toEqual([{ key: 'MEMBER', name: 'Member', privileges: [] }]);
  });

  it('never sends a token in a URL or a body', async () => {
    const { fake, client } = await aliceClient();
    await client.team.members.list();
    const token = await client.token();
    for (const request of fake.requests) {
      expect(request.path).not.toContain(token);
      expect(JSON.stringify(request.body ?? {})).not.toContain(token);
    }
  });

  it('answers signed-out for any of them while nobody is signed in', async () => {
    const { fake } = issuerWithPeople();
    await expect(clientOn(fake).team.members.list()).rejects.toMatchObject({ kind: 'signed-out' });
  });
});

describe('billing: the payer, checkout and the portal', () => {
  const plans = [
    { key: 'free', name: 'Free', free: true, prices: [], features: [], limits: {}, archived: false, description: null, trial: null },
    { key: 'pro', name: 'Pro', free: false, prices: [{ currency: 'eur', interval: 'month', amount: 2000 }], features: [], limits: {}, archived: false, description: null, trial: null },
  ];

  it('chooses a free plan at once, and a paid one through checkout', async () => {
    const { client, fake } = await aliceClient();
    fake.setPlans(plans);
    await expect(client.billing.plans()).resolves.toHaveLength(2);
    await expect(client.billing.choosePlan({ plan: 'free' })).resolves.toEqual({ status: 'changed' });
    const paid = await client.billing.choosePlan({ plan: 'pro', currency: 'eur', interval: 'month' });
    expect(paid.status).toBe('payment_required');
    if (paid.status !== 'payment_required') return;
    expect(paid.checkout.url).toMatch(/^https:\/\//);
    await expect(client.billing.confirmCheckout(paid.checkout.session)).resolves.toMatchObject({ plan: { key: 'pro' }, access: 'ok' });
    await expect(client.billing.state()).resolves.toMatchObject({ plan: { key: 'pro' } });
  });

  it('fetches flags again after a plan change, since rules may read the plan', async () => {
    const { client, fake } = await aliceClient();
    fake.setPlans(plans);
    // Let the load that signing in started settle first.
    await client.flags.load();
    const loads = () => fake.requests.filter((request) => request.path.endsWith('/evaluate/flags')).length;
    const before = loads();
    await client.billing.choosePlan({ plan: 'free' });
    for (let tries = 0; loads() === before && tries < 100; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loads()).toBe(before + 1);
  });

  it('gives the billing portal address', async () => {
    const { client } = await aliceClient();
    await expect(client.billing.portal()).resolves.toEqual({ url: 'https://portal.bridge.test/session' });
  });

  it('reads a return from checkout', () => {
    expect(readCheckoutReturn('https://app.test/billing?stripe_success=1&session_id=cs_test_1')).toEqual({ session: 'cs_test_1' });
    expect(readCheckoutReturn('https://app.test/billing')).toBeNull();
    expect(readCheckoutReturn('https://app.test/billing?session_id=<script>')).toBeNull();
  });

  describe('the notice to show', () => {
    const base: BillingFacts = { plan: { key: 'pro', name: 'Pro' }, status: 'active', access: 'ok', limits: {}, usage: {}, periodStart: null, periodEnd: '2026-12-01T00:00:00.000Z', trialEnd: null, cancelAtPeriodEnd: false, waiting: null, locked: false };
    const now = Date.parse('2026-11-06T00:00:00.000Z');

    it.each([
      [{ access: 'blocked' }, 'blocked'],
      [{ access: 'payment_due' }, 'payment-due'],
      [{ access: 'needs_plan', plan: null }, 'needs-plan'],
      [{ status: 'trialing', trialEnd: '2026-11-09T00:00:00.000Z' }, 'trial-ending'],
      [{ cancelAtPeriodEnd: true }, 'ending'],
      [{ waiting: { plan: 'team', waitsFor: 'period_end', at: null } }, 'waiting'],
    ] as const)('%j gives %s', (change, kind) => {
      expect(billingNotice({ ...base, ...change } as BillingFacts, now)?.kind).toBe(kind);
    });

    it('says how many days a trial has left', () => {
      expect(billingNotice({ ...base, status: 'trialing', trialEnd: '2026-11-09T00:00:00.000Z' }, now)).toMatchObject({ daysLeft: 3 });
    });

    it('shows nothing for a trial far from its end, or a plan in good standing', () => {
      expect(billingNotice({ ...base, status: 'trialing', trialEnd: '2026-12-30T00:00:00.000Z' }, now)).toBeNull();
      expect(billingNotice(base, now)).toBeNull();
    });
  });
});
