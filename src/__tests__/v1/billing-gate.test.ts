import { describe, expect, it } from 'vitest';
import { BillingLockedError, deriveNoticeState, deriveSeverity, isBillingLocked } from '../../billing-gate.js';
import type { BillingFacts } from '../../billing.js';
import { BridgeError, errorFromAnswer, isBridgeError } from '../../core/errors.js';
import type { QuotaRead } from '../../quota.js';
import type { QuotaUpdatedMessage } from '../../quota-events.js';
import { clientOn, flush, issuerWithPeople, PASSWORD } from './helpers.js';

const WS = '/workspace/';
const PROJECTS: QuotaRead = { metric: 'projects', used: 4, limit: 5, remaining: 1, warningLevel: 'approaching', policy: 'hard', kind: 'gauge' };
const SEATS: QuotaRead = { metric: 'api.calls', used: 10, limit: 100, remaining: 90, warningLevel: null, policy: 'metered', kind: 'counter', unitAmount: 0.01, currency: 'usd', overageEstimate: 0, overcap: false };

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function signedIn(options: { live?: boolean; facts?: Record<string, unknown> } = {}) {
  const { fake } = issuerWithPeople();
  if (options.facts !== undefined) fake.setFacts(options.facts);
  fake.setQuota('projects', PROJECTS);
  fake.setQuota('api.calls', SEATS);
  const client = clientOn(fake, options.live === true ? { live: { websocket: fake.websocket as never } } : {});
  await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  return { fake, client };
}

const notice = (fake: ReturnType<typeof issuerWithPeople>['fake'], type: string) =>
  fake.publish(`${WS}${fake.appId}/ws-acme/1`, { type, record: 'payers/ws-acme', workspace: 'ws-acme' });

describe('billing lock: isLocked, gateState, assertNotLocked', () => {
  it('is not locked, and assertNotLocked passes, while nobody is signed in or the state is not known', () => {
    const { fake } = issuerWithPeople();
    const client = clientOn(fake);
    expect(client.isLocked()).toBe(false);
    expect(client.gateState()).toEqual({ locked: false, severity: 'info', noticeState: 'active' });
    expect(() => client.assertNotLocked()).not.toThrow();
  });

  it('reads the lock when the person signs in: a blocked workspace is locked with severity locked and a recovery address', async () => {
    const { client } = await signedIn({ facts: { plan: { key: 'pro', name: 'Pro' }, status: 'past_due', access: 'blocked' } });
    await until(() => client.isLocked());
    expect(client.gateState()).toEqual({ locked: true, severity: 'locked', noticeState: 'dunning_exhausted', recoveryUrl: '/subscription' });
  });

  it('assertNotLocked throws a BillingLockedError (402) carrying the lock payload', async () => {
    const { client } = await signedIn({ facts: { plan: { key: 'pro', name: 'Pro' }, status: 'past_due', access: 'blocked' } });
    await until(() => client.isLocked());
    let thrown: unknown;
    try {
      client.assertNotLocked();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BillingLockedError);
    expect(thrown).toBeInstanceOf(BridgeError);
    const error = thrown as BillingLockedError;
    expect(error.name).toBe('BillingLockedError');
    expect(error.status).toBe(402);
    expect(error.code).toBe('BILLING_GATE_ENGAGED');
    expect(error.reason).toBe('billing-locked');
    expect(error.kind).toBe('plan-required');
    expect(error.payload).toEqual({ reason: 'billing_locked', billing: { status: 'past_due', gateEngaged: true, recoveryUrl: '/subscription' } });
    expect(isBillingLocked(error)).toBe(true);
    expect(isBillingLocked(new BridgeError('plan-required', 'x', { status: 402, code: 'limit-reached' }))).toBe(false);
    expect(isBillingLocked(new BridgeError('plan-required', 'x', { status: 402, code: 'billing-locked' }))).toBe(true);
    expect(isBridgeError(error, 'plan-required')).toBe(true);
  });

  it('a payment that is due or a plan to pick is a notice, not a lock', async () => {
    const { client } = await signedIn({ facts: { plan: { key: 'pro', name: 'Pro' }, status: 'past_due', access: 'payment_due' } });
    await until(() => client.gateState().noticeState === 'past_due');
    expect(client.isLocked()).toBe(false);
    expect(client.gateState()).toEqual({ locked: false, severity: 'warn', noticeState: 'past_due' });
    expect(() => client.assertNotLocked()).not.toThrow();
  });

  it('follows billing.access_changed: locks and unlocks, and tells gate-changed', async () => {
    const { fake, client } = await signedIn({ live: true, facts: { plan: { key: 'pro', name: 'Pro' }, status: 'active', access: 'ok' } });
    await until(() => client.live.status.get() === 'open');
    const heard: boolean[] = [];
    client.on('gate-changed', (state) => heard.push(state.locked));
    await flush();
    expect(client.isLocked()).toBe(false);
    fake.setFacts({ status: 'past_due', access: 'blocked' });
    notice(fake, 'billing.access_changed');
    await until(() => client.isLocked());
    expect(() => client.assertNotLocked()).toThrow(BillingLockedError);
    fake.setFacts({ status: 'active', access: 'ok' });
    notice(fake, 'billing.access_changed');
    await until(() => !client.isLocked());
    expect(() => client.assertNotLocked()).not.toThrow();
    expect(heard).toEqual([true, false]);
  });

  it('does not read billing again for a quota notice', async () => {
    const { fake, client } = await signedIn({ live: true, facts: { access: 'ok', status: 'active' } });
    await until(() => client.live.status.get() === 'open');
    await flush();
    const reads = () => fake.requests.filter((request) => request.path === '/v2/billing/payer/gate').length;
    const before = reads();
    notice(fake, 'billing.quota_updated');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reads()).toBe(before);
  });

  it('forgets the lock on sign-out and is not locked for the next person', async () => {
    const { client } = await signedIn({ facts: { status: 'past_due', access: 'blocked' } });
    await until(() => client.isLocked());
    await client.signOut();
    expect(client.isLocked()).toBe(false);
    expect(client.gateState().noticeState).toBe('active');
  });

  it('reads again after the plan is changed through bridge.billing', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'past_due', access: 'blocked' } });
    await until(() => client.isLocked());
    fake.setPlans([{ key: 'free', name: 'Free', free: true, archived: false, prices: [], features: [], limits: {}, trial: null, description: null }]);
    await client.billing.choosePlan({ plan: 'free' });
    await until(() => !client.isLocked());
  });
});

const LOCKED_402 = { type: 'urn:bridge:problem:billing-locked', title: 'Payment required', status: 402, detail: 'This workspace is locked for payment.', reason: 'billing_locked', billing: { access: 'payment_due' } };

describe('the lock is read by every person, and a caught 402 shows it at once', () => {
  it('reads the gate from the read open to every person of the workspace, never the payer\'s details', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'past_due', access: 'blocked', locked: true } });
    await until(() => client.isLocked());
    const paths = fake.requests.map((request) => request.path);
    expect(paths).toContain('/v2/billing/payer/gate');
    expect(paths).not.toContain('/v2/billing/payer');
  });

  it('a payment that is overdue before the lock is the past_due notice; the gate never says more than the lock', async () => {
    const { client } = await signedIn({ facts: { status: 'past_due', access: 'payment_due', plan: { key: 'pro', name: 'Pro' } } });
    await until(() => client.gateState().noticeState === 'past_due');
    expect(client.gateState()).toEqual({ locked: false, severity: 'warn', noticeState: 'past_due' });
  });

  it('a Bridge call refused with 402 billing-locked locks the workspace at once, as 0.9 did, and throws the 0.9 error', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    expect(client.isLocked()).toBe(false);
    const heard: boolean[] = [];
    client.on('gate-changed', (state) => heard.push(state.locked));
    fake.answerWith('/v2/billing/payer/plan', 402, LOCKED_402);
    const error = await client.billing.choosePlan({ plan: 'free' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BillingLockedError);
    expect(error).toMatchObject({ status: 402, code: 'BILLING_GATE_ENGAGED', reason: 'billing-locked', kind: 'plan-required' });
    expect(isBillingLocked(error)).toBe(true);
    expect(client.isLocked()).toBe(true);
    expect(client.gateState()).toMatchObject({ locked: true, severity: 'locked', noticeState: 'dunning_exhausted', recoveryUrl: '/subscription' });
    expect(heard).toEqual([true]);
    expect(() => client.assertNotLocked()).toThrow(BillingLockedError);
  });

  it('the Child App\'s own 402 with 0.9\'s billing_locked body, through bridge.fetch, locks too; the answer is handed on whole', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.answerWith('/v2/billing/payer/usage', 402, { reason: 'billing_locked', billing: { status: 'past_due', gateEngaged: true } });
    const answer = await client.fetch(`https://bridge.test/v2/billing/payer/usage`);
    expect(answer.status).toBe(402);
    expect(await answer.json()).toMatchObject({ reason: 'billing_locked' });
    expect(client.isLocked()).toBe(true);
  });

  it('a 402 for a limit, or one that is not JSON, locks nothing', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.answerWith('/v2/billing/payer/usage', 402, { type: 'urn:bridge:problem:limit-reached', title: 'Limit', status: 402, reason: 'limit_reached', metric: 'projects', limit: 5, used: 5 });
    expect((await client.fetch(`https://bridge.test/v2/billing/payer/usage`)).status).toBe(402);
    fake.answerWith('/v2/billing/payer/usage', 402, 'payment required');
    expect((await client.fetch(`https://bridge.test/v2/billing/payer/usage`)).status).toBe(402);
    expect(client.isLocked()).toBe(false);
  });

  it('the read the lock waits on never unlocks a lock a refusal just showed', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.answerWith('/v2/billing/payer/usage', 402, LOCKED_402);
    await client.fetch(`https://bridge.test/v2/billing/payer/usage`);
    expect(client.isLocked()).toBe(true);
    // Bridge's own notice of a change is what says whether it still holds.
    fake.answerWith('/v2/billing/payer/usage', null);
    await client.quotas.refresh();
    expect(client.isLocked()).toBe(true);
  });

  it('forgets a lock that was only caught on sign-out', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.answerWith('/v2/billing/payer/usage', 402, LOCKED_402);
    await client.fetch(`https://bridge.test/v2/billing/payer/usage`);
    expect(client.isLocked()).toBe(true);
    await client.signOut();
    expect(client.isLocked()).toBe(false);
  });
});

describe('notice and severity states', () => {
  const base: BillingFacts = { plan: { key: 'pro', name: 'Pro' }, status: 'active', access: 'ok', limits: {}, usage: {}, periodStart: null, periodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, waiting: null, locked: false };
  const now = Date.parse('2026-01-10T00:00:00Z');
  it('maps the facts to the 0.9 notice states and severities', () => {
    expect(deriveNoticeState(null)).toBe('active');
    expect(deriveNoticeState({ ...base, access: 'blocked' })).toBe('dunning_exhausted');
    expect(deriveNoticeState({ ...base, status: 'canceled' })).toBe('canceled');
    expect(deriveNoticeState({ ...base, cancelAtPeriodEnd: true })).toBe('cancel_at_period_end');
    expect(deriveNoticeState({ ...base, status: 'past_due', access: 'payment_due' })).toBe('past_due');
    expect(deriveNoticeState({ ...base, status: 'trialing', access: 'payment_due' })).toBe('past_due_trial');
    expect(deriveNoticeState({ ...base, status: 'trialing', trialEnd: '2026-01-12T00:00:00Z' }, now)).toBe('trial_ending_soon');
    expect(deriveNoticeState({ ...base, status: 'trialing', trialEnd: '2026-02-12T00:00:00Z' }, now)).toBe('trial_active');
    expect(deriveNoticeState({ ...base, status: 'trialing', trialEnd: null }, now)).toBe('trial_active');
    expect(deriveSeverity('dunning_exhausted')).toBe('locked');
    expect(deriveSeverity('trial_ending_soon')).toBe('warn');
    expect(deriveSeverity('active')).toBe('info');
  });
});

describe("handle({ 'quota.updated': fn })", () => {
  it('fires on billing.quota_updated with the numbers read again, in the 0.9 message shape', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    const heard: QuotaUpdatedMessage[] = [];
    client.handle({ 'quota.updated': (message) => heard.push(message) });
    fake.setQuota('projects', { ...PROJECTS, used: 5, remaining: 0, warningLevel: 'critical' });
    notice(fake, 'billing.quota_updated');
    await until(() => heard.length === 1);
    const message = heard[0]!;
    expect(message).toMatchObject({ kind: 'quota.updated', tenantId: 'ws-acme', metric: 'projects', used: 5, limit: 5, remaining: 0, warningLevel: 'critical', policy: 'hard', overcap: false });
    expect(Number.isNaN(Date.parse(message.effectiveAt))).toBe(false);
  });

  it('fires once per metric that changed, and not for one that did not', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    await client.quotas.read('api.calls');
    const heard: string[] = [];
    client.handle({ 'quota.updated': (message) => heard.push(`${message.metric}:${message.used}`) });
    fake.setQuota('api.calls', { ...SEATS, used: 150, remaining: -50, overcap: true, overageEstimate: 0.5 });
    notice(fake, 'billing.quota_updated');
    await until(() => heard.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(heard).toEqual(['api.calls:150']);
    notice(fake, 'billing.quota_updated');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(heard).toEqual(['api.calls:150']);
  });

  it('carries the metered price and overage in the message', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('api.calls');
    const heard: QuotaUpdatedMessage[] = [];
    client.handle({ 'quota.updated': (message) => heard.push(message) });
    fake.setQuota('api.calls', { ...SEATS, used: 150, remaining: -50, overcap: true, overageEstimate: 0.5 });
    notice(fake, 'billing.quota_updated');
    await until(() => heard.length === 1);
    expect(heard[0]).toMatchObject({ policy: 'metered', unitAmount: 0.01, currency: 'usd', overageEstimate: 0.5, overcap: true });
  });

  it('does not fire for a first read, for a change told by another notice, or after the handlers are removed', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    const heard: string[] = [];
    const off = client.handle({ 'quota.updated': (message) => heard.push(message.metric) });
    await client.quotas.read('projects');
    fake.setQuota('projects', { ...PROJECTS, limit: 50, remaining: 46 });
    notice(fake, 'billing.access_changed');
    await until(() => client.quotas.get('projects')?.limit === 50);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toEqual([]);
    off();
    fake.setQuota('projects', { ...PROJECTS, limit: 50, used: 9, remaining: 41 });
    notice(fake, 'billing.quota_updated');
    await until(() => client.quotas.get('projects')?.used === 9);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toEqual([]);
  });

  it('a handler that throws does not stop the others or the client', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    const heard: number[] = [];
    client.handle({ 'quota.updated': () => { throw new Error('mine'); } });
    client.handle({ 'quota.updated': (message) => heard.push(message.used) });
    fake.setQuota('projects', { ...PROJECTS, used: 5, remaining: 0 });
    notice(fake, 'billing.quota_updated');
    await until(() => heard.length === 1);
    expect(heard).toEqual([5]);
    expect(client.quotas.get('projects')?.used).toBe(5);
  });
});

describe('a lock or unlock takes back the tokens: the open page renews silently and shows the new state', () => {
  const tokenReads = (fake: ReturnType<typeof issuerWithPeople>['fake']) => fake.requests.filter((request) => request.path === '/token' || request.path.endsWith('/token')).length;

  it('lock: the next call is refused 401, the session renews, the call is made again, and the lockscreen state shows', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    expect(client.isLocked()).toBe(false);
    const signedOutEvents: unknown[] = [];
    client.on('signed-out', (value) => signedOutEvents.push(value));
    const refreshes = tokenReads(fake);
    fake.setFacts({ status: 'past_due', access: 'blocked' });
    fake.refuseTokensSoFar();
    const answer = await client.fetch('https://bridge.test/v2/billing/payer/usage');
    expect(answer.status).toBe(200);
    expect(tokenReads(fake)).toBe(refreshes + 1);
    await until(() => client.isLocked());
    expect(client.gateState()).toMatchObject({ locked: true, severity: 'locked', recoveryUrl: '/subscription' });
    expect(signedOutEvents).toEqual([]);
    expect(client.session.get().status).toBe('signed-in');
  });

  it('unlock: the next call is refused 401, the session renews, the call is made again, and the page is unlocked again', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'past_due', access: 'blocked' } });
    await until(() => client.isLocked());
    fake.setFacts({ status: 'active', access: 'ok' });
    fake.refuseTokensSoFar();
    const answer = await client.fetch('https://bridge.test/v2/billing/payer/usage');
    expect(answer.status).toBe(200);
    await until(() => !client.isLocked());
    expect(client.gateState()).toEqual({ locked: false, severity: 'info', noticeState: 'active' });
  });

  it('a call through bridge.me or bridge.billing renews and goes through too, and reads the lock again', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.setFacts({ status: 'past_due', access: 'blocked' });
    fake.refuseTokensSoFar();
    expect(await client.me.get()).toMatchObject({ workspaces: expect.any(Array) });
    await until(() => client.isLocked());
    fake.setFacts({ status: 'active', access: 'ok' });
    fake.refuseTokensSoFar();
    await client.billing.state();
    await until(() => !client.isLocked());
  });

  it('a write that comes back 402 billing-locked after the renewal shows the lockscreen at once', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.refuseTokensSoFar();
    fake.answerWith('/v2/billing/payer/usage', 402, LOCKED_402);
    const answer = await client.fetch('https://bridge.test/v2/billing/payer/usage', { method: 'POST', body: '{}' });
    expect(answer.status).toBe(402);
    expect(client.isLocked()).toBe(true);
  });

  it('a lock refuses even a token renewed at once, for a moment: the gate read waits, renews again, and shows the lock', async () => {
    const { fake, client } = await signedIn({ live: true, facts: { status: 'active', access: 'ok' } });
    await until(() => client.live.status.get() === 'open');
    await flush();
    expect(client.isLocked()).toBe(false);
    const ended: unknown[] = [];
    client.on('signed-out', (value) => ended.push(value));
    const refreshes = tokenReads(fake);
    fake.setFacts({ status: 'past_due', access: 'blocked' });
    // Bridge takes back every token issued until a moment after the lock, so the first renewal is refused too.
    fake.refuseTokensFor(600);
    notice(fake, 'billing.access_changed');
    await until(() => client.isLocked(), 5000);
    expect(client.gateState()).toMatchObject({ locked: true, severity: 'locked', recoveryUrl: '/subscription' });
    expect(tokenReads(fake)).toBeGreaterThanOrEqual(refreshes + 2);
    expect(ended).toEqual([]);
    expect(client.session.get().status).toBe('signed-in');
  }, 10_000);

  it('when the session cannot be renewed it is a normal sign-out', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    const ended: unknown[] = [];
    client.on('signed-out', (value) => ended.push(value));
    fake.refuseTokensSoFar();
    for (const each of fake.sessions()) fake.endSession(each.id);
    const answer = await client.fetch('https://bridge.test/v2/billing/payer/usage');
    expect(answer.status).toBe(401);
    expect(client.session.get().status).toBe('signed-out');
    expect(ended).toHaveLength(1);
    expect(client.isLocked()).toBe(false);
  });
});

describe('the lock goes by Bridge\'s problem type billing-locked and by 0.9\'s code BILLING_GATE_ENGAGED', () => {
  const lockedBy = (body: unknown) => isBillingLocked(errorFromAnswer(402, body));
  it('recognises the problem type, with or without its prefix, and the 0.9 code, in a body or on an error', () => {
    expect(lockedBy({ type: 'urn:bridge:problem:billing-locked', title: 'x', status: 402 })).toBe(true);
    expect(lockedBy({ type: 'billing-locked', title: 'x' })).toBe(true);
    expect(lockedBy({ statusCode: 402, code: 'BILLING_GATE_ENGAGED', message: 'locked' })).toBe(true);
    expect(lockedBy({ code: 'billing-locked' })).toBe(true);
    expect(lockedBy({ reason: 'billing_locked' })).toBe(true);
    expect(errorFromAnswer(402, { code: 'BILLING_GATE_ENGAGED' })).toBeInstanceOf(BillingLockedError);
    expect(isBillingLocked(new BridgeError('plan-required', 'x', { status: 402, problem: { type: 'urn:bridge:problem:billing-locked' } }))).toBe(true);
    expect(isBillingLocked(new BridgeError('plan-required', 'x', { status: 402, code: 'billing-locked' }))).toBe(true);
  });

  it('does not take a limit, a missing feature or another status for a lock', () => {
    expect(lockedBy({ type: 'urn:bridge:problem:limit-reached', metric: 'projects', limit: 5, used: 5 })).toBe(false);
    expect(lockedBy({ code: 'QUOTA_EXCEEDED' })).toBe(false);
    expect(isBillingLocked(errorFromAnswer(403, { type: 'urn:bridge:problem:billing-locked' }))).toBe(false);
  });

  it('the Child App\'s own 402 with the 0.9 code locks through bridge.fetch', async () => {
    const { fake, client } = await signedIn({ facts: { status: 'active', access: 'ok' } });
    await flush();
    fake.answerWith('/v2/billing/payer/usage', 402, { statusCode: 402, code: 'BILLING_GATE_ENGAGED', message: 'Billing gate engaged' });
    await client.fetch('https://bridge.test/v2/billing/payer/usage');
    expect(client.isLocked()).toBe(true);
  });
});
