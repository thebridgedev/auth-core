/**
 * The revocation puller's conformance suite, run on Node and in an edge
 * runtime (`revocation.node.test.ts`, `revocation.edge.test.ts`).
 *
 * Tests named `principle N: …` prove one of the architecture's principles:
 * 5, only signed data is a fact; 6, taking access away works within seconds,
 * everywhere.
 */
import { CompactSign } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  AUDIENCE,
  INTROSPECTION_URL,
  ISSUER,
  KEYS,
  OTHER_APP,
  decodeSegment,
  encodeSegment,
  fakeIntrospection,
  jobClaims,
  keyTokenClaims,
  makeKeyRing,
  mint,
  personClaims,
  type KeyRing,
} from './fixtures.js';
import {
  LANES,
  LIST_URL,
  REVOCATION_JWKS_URL,
  alterEntry,
  fakeRevocationList,
  laneUrls,
  makeLaneKey,
  signCheckpoint,
  signEntry,
  unsignedEntry,
  type LaneKey,
} from './revocation-fixtures.js';

function encodeHeader(header: Record<string, unknown>): string {
  return encodeSegment(header);
}

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
      // One clock for the copy and the list, starting now, so cutoffs compare with real token times.
      clock = Date.now();
      list = fakeRevocationList(keys, APP, () => clock);
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
        audience: AUDIENCE,
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
            // Hold every fetch of the revocation list until released; the key set answers at once.
            if (String(input).startsWith(LIST_URL)) {
              calls += 1;
              await new Promise<void>((resolve) => (release = resolve));
            }
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

      it("a token issued for a key, when that key is revoked", async () => {
        await list.revoke('sessions', { kind: 'key', id: KEYS.app.sub });
        const revocations = puller();
        expect(await verifyToken(revocations, keyTokenClaims('app_key'), { subject: KEYS.app.sub })).toBe('revoked');
        expect(await verifyToken(revocations, keyTokenClaims('app_key'), { subject: 'key-acme-other' })).toBe('accepted');
      });

      it("a token issued for a personal key, when the user the key acts for is removed", async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob', workspace: 'ws-alpha' });
        const revocations = puller();
        expect(await verifyToken(revocations, keyTokenClaims('personal_key'), { subject: KEYS.personal.sub })).toBe('revoked');
        expect(
          await verifyToken(revocations, keyTokenClaims('service_account_key'), { subject: KEYS.serviceAccount.sub }),
        ).toBe('accepted');
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

    describe("the revocation list's signed checkpoint", () => {
      /** Serve the members lane's checkpoint through `change`; other lanes as they are. */
      function checkpointOfMembers(change: (payload: Record<string, unknown>) => Promise<unknown> | unknown) {
        list.state.checkpoint = async (lane, payload) => (lane === 'members' ? { jws: await change(payload) } : null);
      }

      async function expectMembersRefused(revocations: RevocationPuller, problem: RegExp) {
        expect(await verifyToken(revocations)).toBe('unavailable');
        expect(revocations.status().lanes.find((l) => l.lane === 'members')?.problem).toMatch(problem);
      }

      it('principle 6 (taking access away works within seconds, everywhere): a cached or replayed page of the revocation list cannot hide a new entry, because the copy counts how far behind it is from the signed checkpoint', async () => {
        const revocations = puller();
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('accepted');

        // From here on, something between the copy and the list keeps answering with that first page.
        const stale = list.lastBody('members');
        list.state.body = (lane, fresh) => (lane === 'members' ? stale : fresh);
        await list.revoke('members', { kind: 'person', id: 'user-bob' });

        clock += 60_000;
        // The copy cannot see the entry yet, but it knows it is a minute behind, not current.
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('accepted');
        expect(revocations.status().lagMs).toBeGreaterThanOrEqual(60_000);
        // A write, held to 30 seconds, is refused already.
        const strict = verifierWith(revocations, revocations.checkWithin(30_000));
        const token = await mint(ring.app, personClaims(), { subject: 'user-bob' });
        expect(outcome(await strict.verify({ type: 'token', value: token }))).toBe('unavailable');

        // Past five minutes, everything is refused.
        clock += 4 * 60_000 + 1_000;
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('unavailable');
        expect(await verifyToken(revocations)).toBe('unavailable');

        // Once real pages come through again, the entry is applied.
        list.state.body = null;
        clock += 2_000;
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-bob' })).toBe('revoked');
        expect(await verifyToken(revocations)).toBe('accepted');
      });

      it('principle 5 (only signed data is a fact): a page of the revocation list without a signed checkpoint is refused', async () => {
        checkpointOfMembers(() => undefined);
        await expectMembersRefused(puller(), /no signed checkpoint/);
      });

      it("principle 5 (only signed data is a fact): a checkpoint whose payload was changed is refused", async () => {
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        checkpointOfMembers(async (payload) => alterEntry(await signCheckpoint(keys.members, payload), (p) => (p.head = 0)));
        await expectMembersRefused(puller(), /checkpoint's signature does not match/);
      });

      it('principle 5 (only signed data is a fact): an unsigned checkpoint is refused', async () => {
        checkpointOfMembers((payload) => unsignedEntry(payload).replace(/^[^.]+/, encodeHeader({ alg: 'none', typ: 'revocation-checkpoint+jws' })));
        await expectMembersRefused(puller(), /checkpoint is unsigned or signed with the wrong algorithm/);
      });

      it("principle 5 (only signed data is a fact): a checkpoint signed with another lane's key is refused", async () => {
        checkpointOfMembers((payload) => signCheckpoint(keys.billing, payload));
        await expectMembersRefused(puller(), /checkpoint is signed with another lane's key/);
      });

      it('principle 5 (only signed data is a fact): a signed entry passed off as a checkpoint is refused', async () => {
        checkpointOfMembers((payload) => signEntry(keys.members, payload));
        await expectMembersRefused(puller(), /checkpoint is not a revocation checkpoint/);
      });

      it('principle 5 (only signed data is a fact): a checkpoint for another lane or another app is refused', async () => {
        checkpointOfMembers((payload) => signCheckpoint(keys.members, { ...payload, lane: 'billing' }));
        await expectMembersRefused(puller(), /checkpoint belongs to another lane/);
        checkpointOfMembers((payload) => signCheckpoint(keys.members, { ...payload, app: OTHER_APP }));
        clock += 2_000;
        await expectMembersRefused(puller(), /checkpoint belongs to another app/);
      });

      it('refuses a checkpoint dated in the future, so a replay cannot stay fresh for longer', async () => {
        checkpointOfMembers((payload) => signCheckpoint(keys.members, { ...payload, at: clock + 60_000 }));
        await expectMembersRefused(puller(), /dated in the future/);
      });

      it('refuses a checkpoint that does not read fully, such as a floor above the head', async () => {
        checkpointOfMembers((payload) => signCheckpoint(keys.members, { ...payload, floor: 5, head: 2 }));
        await expectMembersRefused(puller(), /checkpoint is not in a format this version reads/);
      });

      it('asks for every page of the revocation list with Cache-Control: no-store, whatever headers it is given', async () => {
        await list.revoke('members', { kind: 'session', id: 's-1' });
        const revocations = puller({ headers: { 'Cache-Control': 'max-age=600' } });
        await revocations.sync();
        expect(list.requests.length).toBeGreaterThan(0);
        expect(list.requests.every((r) => r.cacheControl === 'no-store')).toBe(true);
      });
    });

    describe("the revocation list's floor: the oldest entry it still keeps", () => {
      const at = (ms: number) => Math.floor(ms / 1000);

      it('principle 6 (taking access away works within seconds, everywhere): a new copy starts from the floor, applies every entry the revocation list keeps, and refuses credentials the dropped entries could have named', async () => {
        const start = clock;
        await list.revoke('members', { kind: 'person', id: 'user-carol' });
        list.prune('members', 1);
        clock += 10 * 60_000;
        await list.revoke('members', { kind: 'person', id: 'user-bob' });

        const revocations = puller();
        const recent = { issuedAt: at(clock - 60_000) };
        expect(await verifyToken(revocations, personClaims(), recent)).toBe('accepted');
        expect(await verifyToken(revocations, personClaims(), { ...recent, subject: 'user-bob' })).toBe('revoked');
        // Carol's entry is gone; a credential from before it stopped counting is refused all the same.
        expect(await verifyToken(revocations, personClaims(), { issuedAt: at(start), subject: 'user-carol' })).toBe('revoked');

        expect(list.requests.find((r) => r.lane === 'members')?.after).toBe(0);
        expect(revocations.status()).toMatchObject({ ready: true, refusesIssuedBefore: start + 2_000 });
        expect(revocations.status().lanes.find((l) => l.lane === 'members')).toMatchObject({ seq: 2, floor: 2, problem: null });
      });

      it('principle 6 (taking access away works within seconds, everywhere): a copy that fell below the floor refuses until it has reloaded from the floor', async () => {
        const revocations = puller();
        expect(await verifyToken(revocations)).toBe('accepted');

        // While the copy was away, three entries were written and dropped again, then Bob's.
        const start = clock;
        for (const id of ['user-carol', 'user-dave', 'user-erin']) await list.revoke('members', { kind: 'person', id });
        list.prune('members', 3);
        clock += 10 * 60_000;
        await list.revoke('members', { kind: 'person', id: 'user-bob' });

        // The reload does not get through: the copy refuses rather than answer from what it had.
        list.state.serve = (lane, _page, head) => (lane === 'members' ? { entries: [], head } : null);
        const recent = { issuedAt: at(clock - 60_000) };
        expect(await verifyToken(revocations, personClaims(), recent)).toBe('unavailable');

        list.state.serve = null;
        clock += 2_000;
        expect(await verifyToken(revocations, personClaims(), recent)).toBe('accepted');
        expect(await verifyToken(revocations, personClaims(), { ...recent, subject: 'user-bob' })).toBe('revoked');
        expect(await verifyToken(revocations, personClaims(), { issuedAt: at(start), subject: 'user-erin' })).toBe('revoked');
        expect(revocations.status().lanes.find((l) => l.lane === 'members')).toMatchObject({ seq: 4, floor: 4, problem: null });
      });

      it('principle 6 (taking access away works within seconds, everywhere): a copy that fell below the floor refuses until it has reloaded every entry from the floor, even when the revocation list dropped them early', async () => {
        let failReload = false;
        const revocations = puller({
          pageSize: 1,
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (failReload && url.pathname.endsWith('/members') && url.searchParams.get('after') === '4') {
              throw new TypeError('fetch failed');
            }
            return list.fetch(input, init);
          }) as typeof fetch,
        });
        expect(await verifyToken(revocations)).toBe('accepted');

        // Within seconds, three entries are written and dropped, then Bob's and Frank's are written.
        for (const id of ['user-carol', 'user-dave', 'user-erin']) await list.revoke('members', { kind: 'person', id });
        list.prune('members', 3);
        await list.revoke('members', { kind: 'person', id: 'user-bob' });
        await list.revoke('members', { kind: 'person', id: 'user-frank' });
        clock += 10_000;

        // The reload gets Bob's entry but not Frank's: the copy refuses rather than answer half reloaded.
        failReload = true;
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-frank' })).toBe('unavailable');
        expect(revocations.status().lanes.find((l) => l.lane === 'members')?.problem).toMatch(/fell below the oldest entry/);

        failReload = false;
        clock += 2_000;
        expect(await verifyToken(revocations, personClaims(), { subject: 'user-frank' })).toBe('revoked');
        expect(revocations.status().lanes.find((l) => l.lane === 'members')).toMatchObject({ seq: 5, problem: null });
      });

      it('a key checked by the issuer is not refused for being older than the floor: the issuer answers for it live', async () => {
        await list.revoke('members', { kind: 'person', id: 'user-carol' });
        list.prune('members', 1);
        const revocations = puller();
        // The personal key was made an hour ago.
        expect(outcome(await verifierWith(revocations).verify({ type: 'key', value: 'k-personal' }))).toBe('accepted');
      });
    });

    describe('a process that wakes from a freeze', () => {
      it('principle 6 (taking access away works within seconds, everywhere): a process frozen for minutes refreshes its copy of the revocation list before it decides', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        try {
          // A list on the wall clock; the puller follows it on the wall clock too.
          const wall = fakeRevocationList(keys, APP, () => Date.now());
          const revocations = createRevocationPuller({
            appId: APP,
            lanes: laneUrls(),
            jwksUrl: REVOCATION_JWKS_URL,
            fetch: wall.fetch,
          }).start();
          await revocations.sync();
          const token = await mint(ring.app, personClaims(), { subject: 'user-bob' });
          const verifier = verifierWith(revocations);
          expect(outcome(await verifier.verify({ type: 'token', value: token }))).toBe('accepted');

          // Frozen: no timer runs. Meanwhile Bob is removed, and the wall clock moves on three minutes.
          vi.setSystemTime(Date.now() + 60_000);
          await wall.revoke('members', { kind: 'person', id: 'user-bob' });
          vi.setSystemTime(Date.now() + 2 * 60_000);
          const fetchedBefore = wall.requests.length;

          // Woken by a request: the copy is refreshed before the decision, so Bob is refused.
          expect(outcome(await verifier.verify({ type: 'token', value: token }))).toBe('revoked');
          expect(wall.requests.length).toBeGreaterThan(fetchedBefore);
          expect(revocations.status().lagMs).toBeLessThan(1_000);
          revocations.stop();
        } finally {
          vi.useRealTimers();
        }
      });

      it('principle 6 (taking access away works within seconds, everywhere): a process frozen for minutes that cannot refresh is held to the limits: writes refuse after 30 seconds, everything after 5 minutes', async () => {
        const revocations = puller();
        expect(await verifyToken(revocations)).toBe('accepted');
        list.setDown(true);
        const strict = () => verifierWith(revocations, revocations.checkWithin(30_000));

        clock += 2 * 60_000;
        const token = await mint(ring.app, personClaims());
        expect(outcome(await strict().verify({ type: 'token', value: token }))).toBe('unavailable');
        expect(await verifyToken(revocations)).toBe('accepted');
        // It did try to refresh first.
        expect(list.attempts).toBeGreaterThan(LANES.length);
        expect(revocations.status().lanes.every((l) => /fetch failed/.test(l.error ?? ''))).toBe(true);

        clock += 3 * 60_000 + 1_000;
        expect(await verifyToken(revocations)).toBe('unavailable');
      });

      it('does not hold every request while the revocation list is not answering: once a refresh has failed, the copy answers within its limit', async () => {
        const revocations = puller({ maxLagMs: 60_000, timeoutMs: 300 });
        expect(await verifyToken(revocations)).toBe('accepted');
        list.setDown('hang');
        clock += 10_000;
        // The first check finds out, waiting for its refresh to time out.
        expect(await verifyToken(revocations)).toBe('accepted');
        expect(revocations.status().lanes.every((l) => /timed out/.test(l.error ?? ''))).toBe(true);
        // The checks after it answer from the copy at once.
        for (let i = 0; i < 5; i += 1) {
          clock += 500;
          const started = Date.now();
          expect(await verifyToken(revocations)).toBe('accepted');
          expect(Date.now() - started).toBeLessThan(200);
        }
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
