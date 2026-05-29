import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeFlags, type CachedFlag } from '../../flags/flag.js';
import { TelemetryBatcher } from '../../flags/telemetry.js';

const captureFetch = () => {
  const calls: Array<{ url: string; init: any }> = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 202 });
  });
  (global as any).fetch = spy;
  return { spy, calls };
};

const boolFlag = (over: Partial<CachedFlag> = {}): CachedFlag => ({
  key: 'dark_mode',
  state: 'on',
  valueType: 'boolean',
  offValue: false,
  onValue: true,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (global as any).fetch;
});

const CONFIG = {
  apiBaseUrl: 'https://api.test.local',
  apiKey: 'test-key',
  flushIntervalMs: 1000,
};

describe('TelemetryBatcher — config + lifecycle', () => {
  it('does not call fetch when disabled', async () => {
    const { spy } = captureFetch();
    const b = new TelemetryBatcher({ ...CONFIG, enabled: false });
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);
    bridge.flag('dark_mode', false);
    await b.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('strips trailing slashes from apiBaseUrl', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher({ ...CONFIG, apiBaseUrl: 'https://api.test.local/' });
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);
    bridge.flag('dark_mode', false);
    await b.flush();
    expect(calls[0].url).toBe('https://api.test.local/v1/flags/eval-events');
  });

  it('stop() forces a final flush', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);
    bridge.flag('dark_mode', false);
    expect(b.stats().evalQueue).toBe(1);
    await b.stop();
    expect(calls).toHaveLength(1);
  });

  it('flushes after the interval elapses', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);
    bridge.flag('dark_mode', false);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1100);
    // Let the queued microtask resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('TelemetryBatcher — eval coalescing', () => {
  it('100 evals with same (identity, flag, value) in same minute → 1 event count 100', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    bridge.setContext({ identity: 'u-1', attributes: {} });
    b.attach(bridge);

    for (let i = 0; i < 100; i++) {
      bridge.flag('dark_mode', false);
    }
    expect(b.stats().evalQueue).toBe(1);
    await b.flush();

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].count).toBe(100);
    expect(body.events[0].flag).toBe('dark_mode');
    expect(body.events[0].identity).toBe('u-1');
  });

  it('different identities → separate buffer entries', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);

    bridge.setContext({ identity: 'u-1', attributes: {} });
    bridge.flag('dark_mode', false);
    bridge.setContext({ identity: 'u-2', attributes: {} });
    bridge.flag('dark_mode', false);

    expect(b.stats().evalQueue).toBe(2);
    await b.flush();
    expect(JSON.parse(calls[0].init.body).events).toHaveLength(2);
  });

  it('sends x-api-key header', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);
    bridge.flag('dark_mode', false);
    await b.flush();
    expect(calls[0].init.headers['x-api-key']).toBe('test-key');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
  });
});

describe('TelemetryBatcher — discovery', () => {
  it('records on first flag sighting via the hook', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    b.attach(bridge);
    bridge.flag('new_flag', 'default');
    await b.flush();
    const discoveryCall = calls.find((c) => c.url.endsWith('/v1/flags/discover'));
    expect(discoveryCall).toBeDefined();
    const body = JSON.parse(discoveryCall!.init.body);
    expect(body.events[0]).toMatchObject({ kind: 'flag', key: 'new_flag', observedType: 'string' });
  });
});

describe('TelemetryBatcher — attribute observations (TBP-178)', () => {
  it('flushes per-call attribute observations to /v1/flags/discover with kind=attribute + sampleValue', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([
      {
        key: 'feat',
        state: 'on-with-rule',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
        rule: { branches: [], otherwiseValue: false, rolloutPct: 100 },
      },
    ]);
    b.attach(bridge);
    bridge.flag('feat', false, { attributes: { plan: 'enterprise', country: 'SE' } });
    await b.flush();
    const discoveryCalls = calls.filter((c) => c.url.endsWith('/v1/flags/discover'));
    const events = discoveryCalls.flatMap((c) => JSON.parse(c.init.body).events as Array<Record<string, unknown>>);
    const attrEvents = events.filter((e) => e.kind === 'attribute');
    const byKey = Object.fromEntries(attrEvents.map((e) => [e.key, e]));
    expect(byKey.plan).toMatchObject({ kind: 'attribute', key: 'plan', sampleValue: 'enterprise', observedType: 'string' });
    expect(byKey.country).toMatchObject({ kind: 'attribute', key: 'country', sampleValue: 'SE', observedType: 'string' });
  });
});

describe('TelemetryBatcher — call sites', () => {
  it('dedupes per (identity, fingerprint) for the SDK runtime', () => {
    const b = new TelemetryBatcher(CONFIG);
    b.recordCallSite('dark_mode', 'u-1', 'cs_xyz');
    b.recordCallSite('dark_mode', 'u-1', 'cs_xyz');
    b.recordCallSite('dark_mode', 'u-2', 'cs_xyz');
    expect(b.stats().callSiteQueue).toBe(2);
    expect(b.stats().seenCallSites).toBe(2);
  });

  it('flushes to /v1/flags/call-sites', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher(CONFIG);
    b.recordCallSite('dark_mode', 'u-1', 'cs_xyz', 'src/layout.svelte:14');
    await b.flush();
    const csCall = calls.find((c) => c.url.endsWith('/v1/flags/call-sites'));
    expect(csCall).toBeDefined();
    expect(JSON.parse(csCall!.init.body).events[0]).toMatchObject({
      flag: 'dark_mode',
      identity: 'u-1',
      fingerprint: 'cs_xyz',
      devLabel: 'src/layout.svelte:14',
    });
  });

  it('ignores call-site records without identity or fingerprint', () => {
    const b = new TelemetryBatcher(CONFIG);
    b.recordCallSite('a', '', 'fp');
    b.recordCallSite('a', 'u', '');
    expect(b.stats().callSiteQueue).toBe(0);
  });
});

describe('TelemetryBatcher — robustness', () => {
  it('swallows network failures (telemetry must never break the SDK)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    (global as any).fetch = fetchSpy;

    const b = new TelemetryBatcher(CONFIG);
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag()]);
    b.attach(bridge);
    bridge.flag('dark_mode', false);
    await expect(b.flush()).resolves.toBeUndefined();
  });

  it('size-based flush triggers when buffer crosses flushAtSize', async () => {
    const { calls } = captureFetch();
    const b = new TelemetryBatcher({ ...CONFIG, flushAtSize: 3 });
    const bridge = new BridgeFlags();
    bridge.hydrate([boolFlag(), { ...boolFlag(), key: 'a' }, { ...boolFlag(), key: 'b' }]);
    b.attach(bridge);
    bridge.setContext({ identity: 'u-1', attributes: {} });
    bridge.flag('dark_mode', false);
    bridge.flag('a', false);
    bridge.flag('b', false); // crosses size threshold
    // Let microtasks settle
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
