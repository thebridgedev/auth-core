/**
 * The many-app verifier's suite, run on Node and in an edge runtime
 * (`app-verifiers.node.test.ts`, `app-verifiers.edge.test.ts`).
 *
 * A server that serves many apps learns which app a credential is for from
 * the credential itself, so a forged credential can name any app id. These
 * tests prove such a credential makes the server do no lasting work: each
 * app's keys are fetched once, an app's revocation list is followed only
 * after a credential for it passed its checks, an unknown app is a plain
 * refusal, and the apps followed are capped.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAppVerifiers,
  type AppSettings,
  type AppVerifiers,
  type AppVerifiersOptions,
  type Verification,
} from '../../verifier/index.js';
import {
  AUDIENCE,
  INTROSPECTION_URL,
  KEYS,
  fakeIntrospection,
  makeKey,
  mint,
  personClaims,
  tamper,
  unsigned,
  type MintOptions,
  type TestKey,
} from './fixtures.js';
import { fakeRevocationList, makeLaneKey, type LaneKey } from './revocation-fixtures.js';

const BASE = 'https://auth.example.test/apps';
const APP_IDS = ['app-acme', 'app-globex', 'app-initech', 'app-umbrella', 'app-hooli', 'app-stark'] as const;
const LANE_NAMES = ['members', 'sessions'] as const;

interface FakeApp {
  appId: string;
  signing: TestKey;
  lanes: Record<string, LaneKey>;
  list: ReturnType<typeof fakeRevocationList>;
}

function settingsFor(appId: string): AppSettings {
  return {
    issuer: `${BASE}/${appId}`,
    audience: AUDIENCE,
    jwksUrl: `${BASE}/${appId}/jwks.json`,
    revocationLanes: Object.fromEntries(LANE_NAMES.map((lane) => [lane, `${BASE}/${appId}/revocations/${lane}`])),
  };
}

function outcome(result: Verification): string {
  return result.ok ? 'accepted' : result.refusal.reason;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function defineAppVerifiersSuite(runtime: string): void {
  describe(`verifier for many apps (${runtime})`, () => {
    const keys = new Map<string, { signing: TestKey; lanes: Record<string, LaneKey> }>();
    let apps: Map<string, FakeApp>;
    let clock: number;
    let unknownAppFetches: number;
    let lookups: string[];
    let verifiers: AppVerifiers | null = null;
    const introspection = fakeIntrospection({
      'k-acme': { body: { ...KEYS.app, appId: 'app-acme' } },
      'k-inactive': { body: { active: false } },
      'k-service': { body: KEYS.service },
    });

    beforeAll(async () => {
      for (const appId of APP_IDS) {
        const lanes: Record<string, LaneKey> = {};
        for (const lane of LANE_NAMES) lanes[lane] = await makeLaneKey(lane, `${appId}-${lane}-1`);
        keys.set(appId, { signing: await makeKey(`${appId}-key-1`), lanes });
      }
    });

    beforeEach(() => {
      clock = Date.now();
      unknownAppFetches = 0;
      lookups = [];
      apps = new Map();
      for (const appId of APP_IDS) {
        const { signing, lanes } = keys.get(appId)!;
        const list = fakeRevocationList(lanes, appId, () => clock, {
          list: `${BASE}/${appId}/revocations`,
          jwks: `${BASE}/${appId}/jwks.json`,
        });
        list.setKeys({ keys: [signing.publicJwk, ...Object.values(lanes).map((key) => key.publicJwk)] });
        apps.set(appId, { appId, signing, lanes, list });
      }
    });

    afterEach(() => {
      verifiers?.stop();
      verifiers = null;
    });

    const platformFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === INTROSPECTION_URL) return introspection.fetch(input, init);
      for (const app of apps.values()) {
        if (url.startsWith(`${BASE}/${app.appId}/`)) return app.list.fetch(input, init);
      }
      unknownAppFetches += 1;
      return new Response('no such app', { status: 404 });
    }) as typeof fetch;

    /** The registry knows the apps above. */
    const registry = (appId: string): AppSettings | null => {
      lookups.push(appId);
      return apps.has(appId) ? settingsFor(appId) : null;
    };

    function make(overrides: Partial<AppVerifiersOptions> = {}): AppVerifiers {
      verifiers = createAppVerifiers({
        apps: registry,
        introspectionUrl: INTROSPECTION_URL,
        trustedServiceAppId: KEYS.service.appId,
        fetch: platformFetch,
        now: () => clock,
        revocation: { intervalMs: 10 },
        ...overrides,
      });
      return verifiers;
    }

    function tokenFor(appId: string, options: MintOptions = {}, signing?: TestKey): Promise<string> {
      const key = signing ?? apps.get(appId)?.signing ?? keys.get('app-acme')!.signing;
      return mint(key, personClaims({ aid: appId }), { issuer: `${BASE}/${appId}`, ...options });
    }

    async function check(v: AppVerifiers, token: string, options = {}): Promise<string> {
      return outcome(await v.verify({ type: 'token', value: token }, options));
    }

    const app = (appId: string) => apps.get(appId)!;
    const followed = (v: AppVerifiers) => v.status().apps.filter((a) => a.followed).map((a) => a.appId);

    it("fetches each app's signing keys once, however many tokens it checks, and shares them with the app's revocation list", async () => {
      const v = make();
      for (let i = 0; i < 20; i += 1) expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      for (let i = 0; i < 5; i += 1) expect(await check(v, await tokenFor('app-globex'))).toBe('accepted');
      expect(app('app-acme').list.keySetFetches).toBe(1);
      expect(app('app-globex').list.keySetFetches).toBe(1);
      expect(lookups).toEqual(['app-acme', 'app-globex']);
    });

    it("follows an app's revocation list only after a token for that app has passed its signature check: forged tokens start nothing", async () => {
      const v = make();
      const good = await tokenFor('app-globex');
      const forgeries = [
        unsigned({ ...personClaims({ aid: 'app-globex' }), iss: `${BASE}/app-globex`, aud: AUDIENCE, sub: 'mallory', exp: Math.floor(clock / 1000) + 300 }),
        tamper(good, (c) => (c.sub = 'user-mallory')),
        await tokenFor('app-globex', {}, keys.get('app-acme')!.signing),
        await tokenFor('app-globex', {}, await makeKey('app-globex-key-1')),
        await tokenFor('app-globex', { kid: 'made-up-kid' }),
      ];
      for (const forged of forgeries) {
        expect(['unknown_key', 'bad_signature', 'wrong_algorithm']).toContain(await check(v, forged));
      }
      expect(app('app-globex').list.attempts).toBe(0);
      expect(followed(v)).toEqual([]);

      expect(await check(v, good)).toBe('accepted');
      expect(app('app-globex').list.attempts).toBeGreaterThan(0);
      expect(followed(v)).toEqual(['app-globex']);
    });

    it('refuses a token for an app nobody knows as a credential refusal (unknown_app), never as unavailable, and looks the app up once', async () => {
      const v = make();
      for (let i = 0; i < 50; i += 1) {
        expect(await check(v, await tokenFor('app-made-up'))).toBe('unknown_app');
      }
      expect(lookups).toEqual(['app-made-up']);
      expect(unknownAppFetches).toBe(0);
      expect(v.status()).toMatchObject({ apps: [], unknownApps: 1 });

      // Remembered for a while only: an app created since is found.
      clock += 61_000;
      expect(await check(v, await tokenFor('app-made-up'))).toBe('unknown_app');
      expect(lookups).toEqual(['app-made-up', 'app-made-up']);
    });

    it('refuses a token for an app its issuer publishes no keys for as unknown_app, and asks the issuer once', async () => {
      // Settings made up from the app id alone, for any id: the issuer's key set is what knows the app.
      const v = make({ apps: (appId) => settingsFor(appId) });
      for (let i = 0; i < 20; i += 1) {
        expect(await check(v, await tokenFor(`app-made-up-${i % 2}`))).toBe('unknown_app');
      }
      expect(unknownAppFetches).toBe(2);
      expect(v.status().apps).toEqual([]);
    });

    it('follows at most maxApps apps, dropping the one called least recently and stopping its revocation list', async () => {
      const v = make({ maxApps: 2 });
      expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      expect(await check(v, await tokenFor('app-globex'))).toBe('accepted');
      expect(await check(v, await tokenFor('app-initech'))).toBe('accepted');
      expect(followed(v)).toEqual(['app-globex', 'app-initech']);

      // The dropped app's revocation list is no longer fetched.
      await pause(30);
      const before = app('app-acme').list.attempts;
      await pause(60);
      expect(app('app-acme').list.attempts).toBe(before);
      await waitFor(() => app('app-initech').list.attempts > 4);

      // Called again, it is followed again, and the least recently called makes room.
      expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      expect(followed(v)).toEqual(['app-initech', 'app-acme']);
    });

    it('drops an app nobody has called for idleMs, and stops following its revocation list', async () => {
      const v = make({ idleMs: 60_000 });
      expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      clock += 30_000;
      expect(await check(v, await tokenFor('app-globex'))).toBe('accepted');
      clock += 31_000;
      expect(v.status().apps.map((a) => a.appId)).toEqual(['app-globex']);
      const before = app('app-acme').list.attempts;
      await pause(60);
      expect(app('app-acme').list.attempts).toBe(before);
    });

    it('does not let tokens that fail their checks push out the apps it follows', async () => {
      const v = make({ maxApps: 2 });
      expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      for (const appId of ['app-globex', 'app-initech', 'app-umbrella', 'app-hooli', 'app-stark']) {
        expect(await check(v, await tokenFor(appId, {}, keys.get('app-acme')!.signing))).toBe('unknown_key');
      }
      expect(followed(v)).toEqual(['app-acme']);
      expect(v.status().apps.length).toBe(3);
    });

    it("principle 6 (taking access away works within seconds, everywhere): refuses a token the app's revocation list names", async () => {
      const v = make();
      const token = await tokenFor('app-acme', { subject: 'user-bob' });
      expect(await check(v, token)).toBe('accepted');
      await app('app-acme').list.revoke('members', { kind: 'person', id: 'user-bob' });
      await waitFor(() => v.status().apps[0]?.revocation?.lanes.some((l) => l.lane === 'members' && l.seq === 1) ?? false);
      expect(await check(v, token)).toBe('revoked');
      // Another app's list is another app's.
      expect(await check(v, await tokenFor('app-globex', { subject: 'user-bob' }))).toBe('accepted');
    });

    it("holds one check to a stricter limit on how far behind the app's revocation list may be", async () => {
      const v = make({ revocation: { intervalMs: 60_000 } });
      expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      app('app-acme').list.setDown(true);
      clock += 45_000;
      const token = await tokenFor('app-acme');
      expect(await check(v, token)).toBe('accepted');
      expect(await check(v, token, { maxLagMs: 30_000 })).toBe('unavailable');
    });

    it("refuses a token for another app than the one the caller says, before looking anything up", async () => {
      const v = make();
      expect(await check(v, await tokenFor('app-globex'), { appId: 'app-acme' })).toBe('wrong_app');
      expect(lookups).toEqual([]);
    });

    it("takes a key's app from the issuer's answer, and follows its revocation list only once the issuer accepts the key", async () => {
      const v = make();
      expect(outcome(await v.verify({ type: 'key', value: 'k-inactive' }))).toBe('inactive');
      expect(lookups).toEqual([]);
      const result = await v.verify({ type: 'key', value: 'k-acme' });
      expect(outcome(result)).toBe('accepted');
      expect(result.ok && result.actor).toMatchObject({ kind: 'app_key', appId: 'app-acme' });
      expect(followed(v)).toEqual(['app-acme']);
    });

    it("accepts a service's key in the app the caller names, and refuses it for an app nobody knows", async () => {
      const v = make();
      const result = await v.verify({ type: 'key', value: 'k-service' }, { appId: 'app-globex' });
      expect(result.ok && result.actor).toMatchObject({ kind: 'service' });
      expect(followed(v)).toEqual(['app-globex']);
      expect(outcome(await v.verify({ type: 'key', value: 'k-service' }, { appId: 'app-made-up' }))).toBe('unknown_app');
    });

    it('refuses with unavailable while an app cannot be looked up, and does not remember that', async () => {
      let down = true;
      const v = make({
        apps: (appId) => {
          if (down) throw new Error('registry down');
          return registry(appId);
        },
      });
      const token = await tokenFor('app-acme');
      expect(await check(v, token)).toBe('unavailable');
      down = false;
      expect(await check(v, token)).toBe('accepted');
    });

    it('stops following every revocation list when stopped', async () => {
      const v = make();
      expect(await check(v, await tokenFor('app-acme'))).toBe('accepted');
      v.stop();
      await pause(30);
      const before = app('app-acme').list.attempts;
      await pause(60);
      expect(app('app-acme').list.attempts).toBe(before);
      expect(v.status().apps).toEqual([]);
    });

    it('refuses to start without a way to look apps up', () => {
      expect(() => createAppVerifiers({} as AppVerifiersOptions)).toThrow(/apps/);
      expect(() => createAppVerifiers({ apps: registry, maxApps: 0 })).toThrow(/maxApps/);
    });
  });
}
