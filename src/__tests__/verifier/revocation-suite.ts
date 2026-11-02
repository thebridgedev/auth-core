/**
 * The revocation puller's conformance suite, run on Node and in an edge
 * runtime (`revocation.node.test.ts`, `revocation.edge.test.ts`).
 *
 * Tests named `principle N: …` prove one of the architecture's principles:
 * 5, only signed data is a fact; 6, taking access away works within seconds,
 * everywhere.
 */
import { CompactSign } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCredentialVerifier,
  createRevocationPuller,
  RevocationListUnavailableError,
  type RevocationEntry,
  type RevocationPuller,
  type RevocationPullerOptions,
  type Verification,
} from '../../verifier/index.js';
import {
  APP,
  INTROSPECTION_URL,
  ISSUER,
  KEYS,
  OTHER_APP,
  decodeSegment,
  fakeIntrospection,
  jobClaims,
  makeKeyRing,
  mint,
  personClaims,
  type KeyRing,
} from './fixtures.js';
import {
  LANES,
  REVOCATION_JWKS_URL,
  alterEntry,
  fakeRevocationList,
  laneUrls,
  makeLaneKey,
  signEntry,
  unsignedEntry,
  type LaneKey,
} from './revocation-fixtures.js';

function outcome(result: Verification): string {
  return result.ok ? 'accepted' : result.refusal.reason;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function defineRevocationSuite(runtime: string): void {
  describe(`revocation puller (${runtime})`, () => {
    let ring: KeyRing;
    let keys: Record<string, LaneKey>;
    let list: ReturnType<typeof fakeRevocationList>;
    let clock: number;
    const introspection = fakeIntrospection({
      'k-app': { body: KEYS.app },
      'k-personal': { body: { ...KEYS.personal, iat: nowSeconds() - 3600 } },
    });

    beforeEach(async () => {
      ring ??= await makeKeyRing();
      keys ??= Object.fromEntries(await Promise.all(LANES.map(async (lane) => [lane, await makeLaneKey(lane)])));
      list = fakeRevocationList(keys);
      clock = 1_000_000;
    });

    function puller(overrides: Partial<RevocationPullerOptions> = {}): RevocationPuller {
      return createRevocationPuller({
        appId: APP,
        lanes: laneUrls(),
        jwksUrl: REVOCATION_JWKS_URL,
        fetch: list.fetch,
        now: () => clock,
        ...overrides,
      });
    }

    function verifierWith(revocations: RevocationPuller, check = revocations.check) {
      return createCredentialVerifier({
        appId: APP,
        issuer: ISSUER,
        jwks: ring.jwks,
        introspectionUrl: INTROSPECTION_URL,
        fetch: introspection.fetch,
        revocationCheck: check,
      });
    }

    async function verifyToken(revocations: RevocationPuller, claims = personClaims(), options = {}) {
      const token = await mint(ring.app, claims, options);
      return outcome(await verifierWith(revocations).verify({ type: 'token', value: token }));
    }

    describe('loading', () => {
      it('serves nothing until every lane has loaded', async () => {
        const half = createRevocationPuller({
          appId: APP,
          lanes: { ...laneUrls(['members']), billing: 'https://unreachable.example.test/billing' },
          jwksUrl: REVOCATION_JWKS_URL,
          fetch: list.fetch,
          now: () => clock,
        });
        expect(await verifyToken(half)).toBe('unavailable');
        expect(half.status().ready).toBe(false);
        await expect(half.check(fakeActor())).rejects.toBeInstanceOf(RevocationListUnavailableError);
      });

      it('loads every lane on the first check, then accepts what no entry names', async () => {
        const revocations = puller();
        expect(await verifyToken(revocations)).toBe('accepted');
        expect(revocations.status()).toMatchObject({ ready: true, lagMs: 0 });
        expect(list.requests.map((r) => r.lane).sort()).toEqual([...LANES].sort());
        expect(list.requests.every((r) => r.after === 0 && r.v === '1')).toBe(true);
      });

      it('fetches only the entries it has not seen yet', async () => {
        const revocations = puller();
        await list.revoke('members', { kind: 'person', id: 'user-carol' });
        await list.revoke('members', { kind: 'person', id: 'user-dave' });
        await revocations.sync();
        await list.revoke('members', { kind: 'person', id: 'user-erin' });
        await revocations.sync();
        const afters = list.requests.filter((r) => r.lane === 'members').map((r) => r.after);
        expect(afters).toEqual([0, 2]);
        expect(revocations.status().lanes.find((l) => l.lane === 'members')).toMatchObject({ seq: 3, head: 3 });
      });

      it('pages through a long lane until it reaches the end', async () => {
        const revocations = puller({ pageSize: 2 });
        for (const id of ['a', 'b', 'c', 'd', 'e']) await list.revoke('members', { kind: 'session', id });
        await revocations.sync();
        expect(list.requests.filter((r) => r.lane === 'members').map((r) => r.after)).toEqual([0, 2, 4]);
        expect(revocations.status()).toMatchObject({ ready: true });
      });

      it('fetches on its own once started, and stops when told', async () => {
        const revocations = createRevocationPuller({
          appId: APP,
          lanes: laneUrls(),
          jwksUrl: REVOCATION_JWKS_URL,
          fetch: list.fetch,
          intervalMs: 5,
        }).start();
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        await waitFor(() => revocations.status().lanes.some((l) => l.lane === 'members' && l.seq === 1));
        revocations.stop();
        const count = list.requests.length;
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(list.requests.length).toBe(count);
      });

      it('stops for good when stopped, even after a restart while a fetch was running', async () => {
        let calls = 0;
        let release: () => void = () => {};
        const revocations = createRevocationPuller({
          appId: APP,
          lanes: laneUrls(['members']),
          jwksUrl: REVOCATION_JWKS_URL,
          intervalMs: 5,
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            await new Promise<void>((resolve) => (release = resolve));
            return list.fetch(input, init);
          }) as typeof fetch,
        });
        revocations.start();
        revocations.stop();
        revocations.start();
        const running = revocations.sync();
        release();
        await running;
        revocations.stop();
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(calls).toBe(1);
      });

      it('catches up in the background when checks find it behind, without start()', async () => {
        const revocations = puller({ intervalMs: 2000 });
        expect(await verifyToken(revocations)).toBe('accepted');
        await list.revoke('members', { kind: 'person', id: 'user-alice' });
        clock += 2500;
        // This check still answers from the copy, and starts a fetch.
        expect(await verifyToken(revocations)).toBe('accepted');
        await waitFor(() => revocations.status().lanes.some((l) => l.lane === 'members' && l.seq === 1));
        expect(await verifyToken(revocations)).toBe('revoked');
      });
    });

    describe('what an entry takes away', () => {
      it('a token, by its id', async () => {
        await list.revoke('sessions', { kind: 'token', id: 'tok-stolen' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ jti: 'tok-stolen' }))).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ jti: 'tok-other' }))).toBe('accepted');
      });

      it('every token of an ended session', async () => {
        await list.revoke('sessions', { kind: 'session', id: 'sess-1' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ sid: 'sess-1' }))).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ sid: 'sess-2' }))).toBe('accepted');
      });

      it('a key', async () => {
        await list.revoke('sessions', { kind: 'key', id: KEYS.app.sub });
        const revocations = puller();
        const v = verifierWith(revocations);
        expect(outcome(await v.verify({ type: 'key', value: 'k-app' }))).toBe('revoked');
        expect(outcome(await v.verify({ type: 'key', value: 'k-personal' }))).toBe('accepted');
      });

      it('tokens issued to a client', async () => {
        await list.revoke('sessions', { kind: 'client', id: 'client-cli' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ client_id: 'client-cli' }))).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ client_id: 'client-web' }))).toBe('accepted');
      });

      it("a person's access everywhere, including the personal keys they made", async () => {
        await list.revoke('sessions', { kind: 'person', id: 'user-bob' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-alpha' }), { subject: 'user-bob' })).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-beta' }), { subject: 'user-bob' })).toBe('revoked');
        expect(outcome(await verifierWith(revocations).verify({ type: 'key', value: 'k-personal' }))).toBe('revoked');
        expect(await verifyToken(revocations)).toBe('accepted');
      });

      it("a person's access to one workspace, from a point in time", async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob', workspace: 'ws-alpha' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-alpha' }), { subject: 'user-bob' })).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-beta' }), { subject: 'user-bob' })).toBe('accepted');
        // Bob added back later gets a new token, issued after the cutoff.
        const later = nowSeconds() + 10;
        expect(
          await verifyToken(revocations, personClaims({ tid: 'ws-alpha' }), { subject: 'user-bob', issuedAt: later }),
        ).toBe('accepted');
      });

      it('refuses a credential that does not say when it was issued, when an entry with a cutoff names it', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob', workspace: 'ws-alpha', before: 1 });
        const revocations = puller();
        expect(
          await verifyToken(revocations, personClaims({ tid: 'ws-alpha' }), { subject: 'user-bob', issuedAt: null }),
        ).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-alpha' }), { subject: 'user-bob' })).toBe('accepted');
      });

      it('everything bound to a workspace', async () => {
        await list.revoke('members', { kind: 'workspace', id: 'ws-alpha' });
        const revocations = puller();
        expect(await verifyToken(revocations, jobClaims(), { subject: 'job-1' })).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-beta' }))).toBe('accepted');
      });

      it('tokens carrying a role in a workspace', async () => {
        await list.revoke('members', { kind: 'role', id: 'ADMIN', workspace: 'ws-alpha' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ role: 'ADMIN' }))).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ role: 'MEMBER' }))).toBe('accepted');
        expect(await verifyToken(revocations, personClaims({ role: 'ADMIN', tid: 'ws-beta' }))).toBe('accepted');
      });

      it("a new billing version for a workspace or the whole app, so tokens carrying the old plan are renewed", async () => {
        await list.revoke('billing', { kind: 'billing', scope: 'workspace', id: 'ws-alpha', version: 8 });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-alpha' }))).toBe('revoked');
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-beta' }))).toBe('accepted');
        await list.revoke('billing', { kind: 'billing', scope: 'app', version: 3 });
        await revocations.sync();
        expect(await verifyToken(revocations, personClaims({ tid: 'ws-beta' }))).toBe('revoked');
      });

      it('a change of ownership refuses no credential by itself, and reaches the listeners', async () => {
        await list.revoke('apps', { kind: 'ownership', id: 'app-shop' });
        const seen: RevocationEntry[] = [];
        const revocations = puller({ onEntry: (entry) => seen.push(entry) });
        expect(await verifyToken(revocations)).toBe('accepted');
        expect(seen).toMatchObject([{ lane: 'apps', seq: 1, kind: 'ownership', id: 'app-shop' }]);
      });

      it('keeps pulling when a listener throws', async () => {
        await list.revoke('members', { kind: 'session', id: 's-1' });
        await list.revoke('members', { kind: 'session', id: 's-2' });
        const revocations = puller({
          onEntry: () => {
            throw new Error('listener bug');
          },
        });
        await revocations.sync();
        expect(revocations.status().lanes.find((l) => l.lane === 'members')).toMatchObject({ seq: 2, problem: null });
      });
    });

    describe('principle 6: taking access away works within seconds, everywhere', () => {
      it('principle 6: a revocation written after the copy loaded is refused on the next fetch', async () => {
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('accepted');
        await list.revoke('members', { kind: 'person', id: 'user-bob', workspace: 'ws-alpha' });
        await revocations.sync();
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('revoked');
      });

      it('principle 6: a copy that falls too far behind refuses instead of allowing, and recovers when it catches up', async () => {
        const revocations = puller({ maxLagMs: 60_000 });
        expect(await verifyToken(revocations)).toBe('accepted');

        list.setDown(true);
        clock += 30_000;
        expect(await verifyToken(revocations)).toBe('accepted');
        clock += 31_000;
        expect(await verifyToken(revocations)).toBe('unavailable');
        await expect(revocations.check(fakeActor())).rejects.toThrow(/behind/);
        expect(revocations.status().lanes[0].error).toMatch(/fetch failed/);

        list.setDown(false);
        clock += 5_000;
        expect(await verifyToken(revocations)).toBe('accepted');
      });

      it('principle 6: a stricter limit, for writes and sensitive actions, refuses sooner', async () => {
        const revocations = puller();
        await revocations.sync();
        list.setDown(true);
        clock += 45_000;
        expect(await verifyToken(revocations)).toBe('accepted');
        const strict = verifierWith(revocations, revocations.checkWithin(30_000));
        const token = await mint(ring.app, personClaims());
        expect(outcome(await strict.verify({ type: 'token', value: token }))).toBe('unavailable');
      });

      it('principle 6: a copy that misses an entry refuses instead of allowing, until the entry arrives', async () => {
        const revocations = puller();
        await list.revoke('members', { kind: 'person', id: 'user-carol' });
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        await list.revoke('members', { kind: 'person', id: 'user-dave' });
        // The list loses entry 2 on the way.
        list.state.serve = (lane, page, head) =>
          lane === 'members' ? { entries: page.filter((e) => e.seq !== 2).map((e) => e.jws), head } : null;

        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('unavailable');
        expect(await verifyToken(revocations)).toBe('unavailable');
        expect(revocations.status().lanes.find((l) => l.lane === 'members')).toMatchObject({
          seq: 1,
          problem: expect.stringMatching(/gap after entry 1/),
        });

        list.state.serve = null;
        clock += 2_000;
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('revoked');
        expect(await verifyToken(revocations)).toBe('accepted');
      });

      it('principle 6: a list that says it holds entries but sends none is refused', async () => {
        const revocations = puller();
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        list.state.serve = (lane, _page, head) => (lane === 'members' ? { entries: [], head } : null);
        expect(await verifyToken(revocations)).toBe('unavailable');
      });

      it('principle 6: a list that goes backwards is refused', async () => {
        const revocations = puller();
        await list.revoke('members', { kind: 'person', id: 'user-carol' });
        await list.revoke('members', { kind: 'person', id: 'user-dave' });
        await revocations.sync();
        list.state.serve = (lane) => (lane === 'members' ? { entries: [], head: 1 } : null);
        clock += 2_000;
        await revocations.sync();
        await expect(revocations.check(fakeActor())).rejects.toThrow(/went backwards/);
      });
    });

    describe('principle 5: only signed data is a fact', () => {
      /** Serve `replace(entries)` in place of the members lane's real entries. */
      function serveMembers(replace: (jws: string[]) => Promise<unknown[]> | unknown[]) {
        let served: unknown[] | null = null;
        list.state.serve = (lane, page, head) =>
          lane === 'members' && served ? { entries: served, head } : null;
        return async () => {
          served = await replace(list.entries('members').map((e) => e.jws));
        };
      }

      async function expectRejected(revocations: RevocationPuller, problem: RegExp) {
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('unavailable');
        expect(await verifyToken(revocations)).toBe('unavailable');
        const lane = revocations.status().lanes.find((l) => l.lane === 'members');
        expect(lane?.seq).toBe(0);
        expect(lane?.problem).toMatch(problem);
      }

      it('principle 5: an entry whose payload was altered is rejected, and what it says is not applied', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob', workspace: 'ws-alpha' });
        const load = serveMembers((jws) => [alterEntry(jws[0], (p) => (p.id = 'user-alice'))]);
        await load();
        await expectRejected(puller(), /signature does not match/);
      });

      it('principle 5: an unsigned entry is rejected', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        const load = serveMembers(() => [
          unsignedEntry({ v: 1, app: APP, lane: 'members', seq: 1, at: Date.now(), kind: 'person', id: 'user-bob', before: Date.now() }),
        ]);
        await load();
        await expectRejected(puller(), /unsigned or signed with the wrong algorithm/);
      });

      it("principle 5: an entry signed with another lane's key is rejected", async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob' }, keys.billing);
        await expectRejected(puller(), /another lane's key/);
      });

      it('principle 5: an entry signed with a key that is not published is rejected', async () => {
        const stranger = await makeLaneKey('members', 'members-key-unpublished');
        await list.revoke('members', { kind: 'person', id: 'user-bob' }, stranger);
        await expectRejected(puller(), /not published/);
      });

      it("principle 5: an entry signed with a published key's id but another key is rejected", async () => {
        const impostor = await makeLaneKey('members', keys.members.kid);
        await list.revoke('members', { kind: 'person', id: 'user-bob' }, impostor);
        await expectRejected(puller(), /signature does not match/);
      });

      it('principle 5: an entry signed with HMAC, using the published key as the secret, is rejected', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        const load = serveMembers(async (jws) => {
          const [, payload] = jws[0].split('.');
          const secret = new TextEncoder().encode(JSON.stringify(keys.members.publicJwk));
          const forged = await new CompactSign(new TextEncoder().encode(JSON.stringify(decodeSegment(payload))))
            .setProtectedHeader({ alg: 'HS256', kid: keys.members.kid, typ: 'revocation+jws' })
            .sign(secret);
          return [forged];
        });
        await load();
        await expectRejected(puller(), /unsigned or signed with the wrong algorithm/);
      });

      it('principle 5: a signed entry for another app is rejected', async () => {
        const otherApp = fakeRevocationList(keys, OTHER_APP);
        const theirs = await otherApp.revoke('members', { kind: 'person', id: 'user-bob' });
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        const load = serveMembers(() => [theirs.jws]);
        await load();
        await expectRejected(puller(), /another app/);
      });

      it('principle 5: a signed entry that is not a revocation entry is rejected', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        const load = serveMembers(async () => [
          await signEntry(keys.members, { v: 1, app: APP, lane: 'members', seq: 1, at: 1, kind: 'person', id: 'user-bob', before: 1 }, { typ: 'JWT' }),
        ]);
        await load();
        await expectRejected(puller(), /not a revocation entry/);
      });

      it('principle 5: a signed entry in a shape this version does not read is rejected, not skipped', async () => {
        await list.revoke('members', { kind: 'everything', id: 'user-bob' });
        await expectRejected(puller(), /format this version reads/);
      });

      it('principle 5: a key published without a lane cannot sign entries', async () => {
        const unbound = { ...keys.members.publicJwk };
        delete unbound.lane;
        list.setKeys({ keys: [unbound] });
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        await expectRejected(puller(), /not published/);
      });
    });

    describe('the published keys', () => {
      it('takes the lane keys from the same key set as the token keys, and ignores the token keys', async () => {
        list.setKeys({ keys: [...ring.jwks.keys, ...Object.values(keys).map((k) => k.publicJwk)] });
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('revoked');
      });

      it('fetches the key set again for a key it has not seen, so a lane key can be rotated', async () => {
        const revocations = puller();
        await list.revoke('members', { kind: 'person', id: 'user-carol' });
        await revocations.sync();
        expect(list.keySetFetches).toBe(1);

        const next = await makeLaneKey('members', 'members-key-2');
        list.setKeys({ keys: [...list.jwks.keys, next.publicJwk] });
        await list.revoke('members', { kind: 'person', id: 'user-bob' }, next);
        clock += 31_000;
        await revocations.sync();
        expect(list.keySetFetches).toBe(2);
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('revoked');
      });

      it('accepts the key set itself instead of its URL', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        const revocations = puller({ jwksUrl: undefined, jwks: list.jwks });
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('revoked');
        expect(list.keySetFetches).toBe(0);
      });

      it('only falls behind, rather than distrusting the list, while the key set cannot be loaded', async () => {
        const revocations = puller({ jwksUrl: 'https://auth.example.test/missing-keys.json' });
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        await revocations.sync();
        const lane = revocations.status().lanes.find((l) => l.lane === 'members');
        expect(lane).toMatchObject({ seq: 0, problem: null, error: expect.stringMatching(/keys could not be loaded/) });
        expect(await verifyToken(revocations)).toBe('unavailable');
      });
    });

    describe('setting it up', () => {
      it('refuses to start without the app, the lanes or the keys', () => {
        const base = { appId: APP, lanes: laneUrls(), jwksUrl: REVOCATION_JWKS_URL };
        expect(() => createRevocationPuller({ ...base, appId: '' })).toThrow(TypeError);
        expect(() => createRevocationPuller({ ...base, lanes: {} })).toThrow(TypeError);
        expect(() => createRevocationPuller({ ...base, lanes: { members: '' } })).toThrow(TypeError);
        expect(() => createRevocationPuller({ ...base, jwksUrl: undefined })).toThrow(TypeError);
        expect(() => puller().checkWithin(0)).toThrow(TypeError);
      });

      it('sends the configured headers with every list fetch, and never to the key set', async () => {
        await list.revoke('members', { kind: 'session', id: 's-1' });
        const seen: (string | null)[] = [];
        const revocations = puller({
          headers: { 'x-api-key': 'k-app' },
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            seen.push(new Headers(init?.headers).get('x-api-key'));
            return list.fetch(input, init);
          }) as typeof fetch,
        });
        await revocations.sync();
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set(['k-app', null]));
      });
    });
  });
}

/** An Actor for checks that only need the list's state. */
function fakeActor() {
  return {
    kind: 'person' as const,
    id: 'user-zed',
    appId: APP,
    workspaceId: null,
    privileges: [],
    scopes: [],
    personId: 'user-zed',
    jobId: null,
    role: null,
    credential: { type: 'token' as const, checkedBy: 'signature' as const, expiresAt: null, issuedAt: nowSeconds(), tokenId: null, sessionId: null },
    claims: {},
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
