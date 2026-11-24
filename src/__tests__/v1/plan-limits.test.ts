import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_FLAG_PREFIX, entitlementFlag, snapshotOf, type QuotaRead, type QuotaSnapshot } from '../../quota.js';
import { clientOn, flush, issuerWithPeople, PASSWORD } from './helpers.js';

const PROJECTS: QuotaRead = { metric: 'projects', used: 4, limit: 5, remaining: 1, warningLevel: 'approaching', policy: 'hard', kind: 'gauge' };
const quotaReads = (fake: ReturnType<typeof issuerWithPeople>['fake'], metric = 'projects') => fake.quotaReads.filter((each) => each === metric).length;
const evaluations = (fake: ReturnType<typeof issuerWithPeople>['fake']) => fake.requests.filter((request) => request.path.endsWith('/ofrep/v1/evaluate/flags')).length;

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function signedIn(options: { live?: boolean } = {}) {
  const { fake } = issuerWithPeople();
  fake.setQuota('projects', PROJECTS);
  const client = clientOn(fake, options.live === true ? { live: { websocket: fake.websocket as never } } : {});
  await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
  await client.flags.load();
  return { fake, client };
}

describe('entitlements: plan features as flags', () => {
  it('names the flag bridge:billing.entitlement.<key>', () => {
    expect(ENTITLEMENT_FLAG_PREFIX).toBe('bridge:billing.entitlement.');
    expect(entitlementFlag('ai_completions')).toBe('bridge:billing.entitlement.ai_completions');
  });

  it('can(key) reads the flag result: on when on, off when off, off when Bridge gave none', async () => {
    const { fake, client } = await signedIn();
    fake.setFlags({ 'bridge:billing.entitlement.ai_completions': true, 'bridge:billing.entitlement.sso': false });
    await client.flags.load();
    expect(client.entitlements.can('ai_completions')).toBe(true);
    expect(client.entitlements.can('sso')).toBe(false);
    expect(client.entitlements.can('unknown')).toBe(false);
    expect(client.entitlements.can('')).toBe(false);
    expect(client.entitlements.all()).toEqual({ ai_completions: true, sso: false });
  });

  it('never reads the plan: the facts naming a feature do not turn it on', async () => {
    const { fake, client } = await signedIn();
    fake.setFacts({ plan: { key: 'pro', name: 'Pro' }, status: 'active', access: 'ok', features: { ai_completions: true } });
    fake.setFlags({ 'bridge:billing.entitlement.ai_completions': false });
    // The lock for payment reads the payer once at sign-in; loading flags never reads it.
    await flush();
    const payerReads = () => fake.requests.filter((request) => request.path.startsWith('/v2/billing/payer')).length;
    const before = payerReads();
    await client.flags.load();
    expect(client.entitlements.can('ai_completions')).toBe(false);
    expect(payerReads()).toBe(before);
  });

  it('is off before sign-in, and tells subscribers when the results change', async () => {
    const { fake } = issuerWithPeople();
    fake.setFlags({ 'bridge:billing.entitlement.sso': true });
    const client = clientOn(fake);
    expect(client.entitlements.can('sso')).toBe(false);
    const heard: Record<string, boolean>[] = [];
    client.entitlements.subscribe((features) => heard.push(features));
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.flags.load();
    expect(heard.at(-1)).toEqual({ sso: true });
    expect(client.entitlements.can('sso')).toBe(true);
  });
});

describe('quota snapshots: today\'s shape', () => {
  it('maps what Bridge answers to the 0.9 snapshot', () => {
    expect(snapshotOf('projects', PROJECTS)).toEqual({ metric: 'projects', used: 4, limit: 5, remaining: 1, percent_used: 0.8, policy: 'hard', kind: 'gauge', warningLevel: 'approaching', label: 'projects', overcap: false });
    expect(snapshotOf('api.calls', { metric: 'api.calls', used: 12, limit: 10, remaining: 0, warningLevel: 'critical', policy: 'metered', kind: 'counter', unitAmount: 0.002, currency: 'usd', overageEstimate: 0.004, overcap: true })).toMatchObject({ policy: 'metered', unitAmount: 0.002, currency: 'usd', overageEstimate: 0.004, overcap: true, percent_used: 1.2 });
    expect(snapshotOf('seats', { metric: 'seats', used: 2, limit: 3, remaining: 1, kind: 'gauge', source: 'membership' })).toMatchObject({ source: 'membership', warningLevel: null });
    // As 0.9 did: no limit is no snapshot, no policy reads as metered, no kind as a counter, a limit of 0 has no percent.
    expect(snapshotOf('x', null)).toBeUndefined();
    expect(snapshotOf('x', { metric: 'x', used: 0, limit: 0, remaining: 0 })).toMatchObject({ policy: 'metered', kind: 'counter', percent_used: 0, overcap: false });
  });
});

describe('the quota store', () => {
  it('quota(metric) starts reading and returns undefined, then holds the snapshot and tells subscribers', async () => {
    const { fake, client } = await signedIn();
    const heard: [string, QuotaSnapshot | undefined][] = [];
    client.quotas.subscribe((metric, snapshot) => heard.push([metric, snapshot]));
    expect(client.quota('projects')).toBeUndefined();
    await until(() => client.quota('projects') !== undefined);
    expect(client.quota('projects')).toMatchObject({ metric: 'projects', used: 4, limit: 5, policy: 'hard', kind: 'gauge', warningLevel: 'approaching' });
    expect(heard).toHaveLength(1);
    expect(heard[0]![0]).toBe('projects');
    expect(client.quotas.getAll().get('projects')?.used).toBe(4);
    // Reading again while one is held asks nothing.
    expect(quotaReads(fake)).toBe(1);
    const read = fake.requests.find((request) => request.path === '/v2/billing/usage/quota/projects')!;
    expect(read.headers['authorization']).toMatch(/^Bearer /);
  });

  it('shares one read between calls made while it is under way', async () => {
    const { fake, client } = await signedIn();
    client.quota('projects');
    client.quota('projects');
    client.quota('projects');
    await until(() => client.quota('projects') !== undefined);
    expect(quotaReads(fake)).toBe(1);
  });

  it('has no snapshot for a metric the plan sets no limit on', async () => {
    const { fake, client } = await signedIn();
    fake.setQuota('exports.made', null);
    expect(await client.quotas.read('exports.made')).toBeUndefined();
    expect(client.quotas.get('exports.made')).toBeUndefined();
    expect(quotaReads(fake, 'exports.made')).toBe(1);
  });

  it('reads nothing while nobody is signed in, and the asked-for metrics once someone is', async () => {
    const { fake } = issuerWithPeople();
    fake.setQuota('projects', PROJECTS);
    const client = clientOn(fake);
    await client.ready;
    expect(client.quota('projects')).toBeUndefined();
    await flush();
    expect(quotaReads(fake)).toBe(0);
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await until(() => client.quota('projects') !== undefined);
    expect(client.quota('projects')?.used).toBe(4);
  });

  it('refresh() reads every metric a screen asked for again', async () => {
    const { fake, client } = await signedIn();
    fake.setQuota('seats', { metric: 'seats', used: 2, limit: 3, remaining: 1, kind: 'gauge', source: 'membership', policy: 'hard' });
    await client.quotas.read('projects');
    await client.quotas.read('seats');
    fake.setQuota('projects', { ...PROJECTS, used: 5, remaining: 0, warningLevel: 'critical' });
    fake.setQuota('seats', { metric: 'seats', used: 3, limit: 3, remaining: 0, kind: 'gauge', source: 'membership', policy: 'hard' });
    await client.quotas.refresh();
    expect(client.quotas.get('projects')?.used).toBe(5);
    expect(client.quotas.get('seats')?.used).toBe(3);
  });

  it('keeps what it holds when a read fails, and reports the failure', async () => {
    const { fake } = issuerWithPeople();
    fake.setQuota('projects', PROJECTS);
    let failing = false;
    const client = clientOn(fake, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (failing && url.includes('/usage/quota/')) return new Response(null, { status: 503 });
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    const errors: unknown[] = [];
    client.on('error', (error) => errors.push(error));
    await client.signIn.start({ email: 'alice@acme.test', password: PASSWORD });
    await client.quotas.read('projects');
    failing = true;
    expect((await client.quotas.read('projects'))?.used).toBe(4);
    expect(client.quotas.get('projects')?.used).toBe(4);
    expect(errors).toHaveLength(1);
  });

  it('renews a token Bridge refuses after a plan change, and reads again', async () => {
    const { fake, client } = await signedIn();
    fake.refuseTokensSoFar();
    const snapshot = await client.quotas.read('projects');
    expect(snapshot?.used).toBe(4);
  });

  it('drops what it holds for another workspace and reads the asked-for metrics again', async () => {
    const { fake } = issuerWithPeople();
    fake.setQuota('projects', PROJECTS);
    const client = clientOn(fake);
    await client.signIn.start({ email: 'bob@acme.test', password: PASSWORD }).then((step) => (step.done || step.next !== 'workspace' ? undefined : step.choose('ws-acme')));
    await client.quotas.read('projects');
    expect(quotaReads(fake)).toBe(1);
    fake.setQuota('projects', { ...PROJECTS, used: 1, remaining: 4, warningLevel: null });
    await client.workspaces.switch('ws-globex');
    await until(() => client.quotas.get('projects')?.used === 1);
    expect(quotaReads(fake)).toBe(2);
  });

  it('forgets everything when the person signs out', async () => {
    const { client } = await signedIn();
    await client.quotas.read('projects');
    await client.signOut();
    expect(client.quotas.get('projects')).toBeUndefined();
  });
});

describe('the quota store follows Live', () => {
  it('reads again on billing.quota_updated, which carries no numbers, and does not ask for flags again', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    const evaluationsBefore = evaluations(fake);
    fake.setQuota('projects', { ...PROJECTS, used: 5, remaining: 0, warningLevel: 'critical' });
    fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'billing.quota_updated', record: 'payers/ws-acme', workspace: 'ws-acme' });
    await until(() => client.quotas.get('projects')?.used === 5);
    expect(client.quotas.get('projects')?.warningLevel).toBe('critical');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Usage moved numbers, not what the plan allows: flags are left alone.
    expect(evaluations(fake)).toBe(evaluationsBefore);
  });

  it('reads again on billing.access_changed, a changed plan or limit, and flags follow as before', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    fake.setQuota('projects', { ...PROJECTS, limit: 50, remaining: 46 });
    const before = evaluations(fake);
    fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'billing.access_changed', record: 'payers/ws-acme', workspace: 'ws-acme' });
    await until(() => client.quotas.get('projects')?.limit === 50);
    await until(() => evaluations(fake) > before);
  });

  it('does not read again for a notice that is about something else', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    const before = quotaReads(fake);
    fake.publish(`/app/${fake.appId}`, { type: 'flags.revision_changed', record: 'revisions/2' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quotaReads(fake)).toBe(before);
  });

  it('answers a burst of notices with at most one read under way and one after it', async () => {
    const { fake, client } = await signedIn({ live: true });
    await until(() => client.live.status.get() === 'open');
    await client.quotas.read('projects');
    const before = quotaReads(fake);
    for (let i = 0; i < 6; i += 1) fake.publish(`/workspace/${fake.appId}/ws-acme/1`, { type: 'billing.quota_updated', record: 'payers/ws-acme', workspace: 'ws-acme' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reads = quotaReads(fake) - before;
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThan(6);
  });
});
