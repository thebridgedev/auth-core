/**
 * The credential verifier's conformance suite.
 *
 * One shared set of token and key tests. Every runtime the verifier ships to
 * runs all of it: `conformance.node.test.ts` on Node, `conformance.edge.test.ts`
 * in an edge runtime. A runtime is supported when every case passes.
 *
 * Tests named `principle N: …` prove one of the architecture's principles and
 * are counted by name.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCredentialVerifier,
  CredentialRefusedError,
  type CredentialVerifierOptions,
  type Verification,
} from '../../verifier/index.js';
import {
  APP,
  AUDIENCE,
  BRIDGE_APP,
  INTROSPECTION_URL,
  ISSUER,
  KEYS,
  OTHER_APP,
  fakeIntrospection,
  hmacWithPublicKey,
  jobClaims,
  makeKeyRing,
  mint,
  personClaims,
  tamper,
  unsigned,
  type KeyRing,
} from './fixtures.js';

function refusalOf(result: Verification) {
  expect(result.ok).toBe(false);
  return result.ok ? undefined : result.refusal.reason;
}

function actorOf(result: Verification) {
  if (!result.ok) throw new Error(`expected an Actor, got a refusal: ${result.refusal.reason}`);
  return result.actor;
}

export function defineConformanceSuite(runtime: string): void {
  describe(`credential verifier conformance (${runtime})`, () => {
    let ring: KeyRing;
    const introspection = fakeIntrospection({
      'k-personal': { body: KEYS.personal },
      'k-personal-job': { body: KEYS.personalForOneJob },
      'k-service-account': { body: KEYS.serviceAccount },
      'k-app': { body: KEYS.app },
      'k-service': { body: KEYS.service },
      'k-legacy-app': { body: KEYS.legacyAppWide },
      'k-legacy-ws': { body: KEYS.legacyWorkspace },
      'k-other-app': { body: KEYS.otherApp },
      'k-expired': { body: { ...KEYS.personal, exp: 1_000_000 } },
      'k-not-a-key': { body: { ...KEYS.app, type: 'refresh' } },
      'k-unknown-kind': { body: { ...KEYS.app, kind: 'superuser' } },
      'k-personal-no-member': { body: { ...KEYS.personal, userId: null } },
      'k-service-account-no-ws': { body: { ...KEYS.serviceAccount, tenantId: null } },
      'k-app-with-ws': { body: { ...KEYS.app, tenantId: 'ws-alpha' } },
      'k-job-on-app-key': { body: { ...KEYS.app, jobId: 'export-42' } },
      'k-bad-privileges': { body: { ...KEYS.app, privileges: 'everything' } },
      'k-down': { network: 'down' },
      'k-500': { status: 500 },
      'k-garbage': { text: 'not json' },
    });

    function verifier(overrides: Partial<CredentialVerifierOptions> = {}) {
      return createCredentialVerifier({
        appId: APP,
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: ring.jwks,
        introspectionUrl: INTROSPECTION_URL,
        fetch: introspection.fetch,
        revocationCheck: 'none',
        ...overrides,
      });
    }

    beforeAll(async () => {
      ring = await makeKeyRing();
    });

    describe('people and jobs, by token', () => {
      it("turns a person's token into a person Actor", async () => {
        const token = await mint(ring.app, personClaims({ jti: 'tok-1', sid: 'sess-1' }));
        const actor = actorOf(await verifier().verify({ type: 'token', value: token }));

        expect(actor.kind).toBe('person');
        expect(actor.id).toBe('user-alice');
        expect(actor.personId).toBe('user-alice');
        expect(actor.appId).toBe(APP);
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.privileges).toEqual(['invoices:read', 'invoices:write']);
        expect(actor.scopes).toEqual(['invoices:read', 'invoices:write']);
        expect(actor.role).toBe('ADMIN');
        expect(actor.jobId).toBeNull();
        expect(actor.credential).toMatchObject({
          type: 'token',
          checkedBy: 'signature',
          tokenId: 'tok-1',
          sessionId: 'sess-1',
        });
        expect(typeof actor.credential.expiresAt).toBe('number');
        expect(actor.claims.email).toBe('alice@acme.test');
      });

      it('accepts a person signed in without a workspace, and gives them none', async () => {
        const token = await mint(ring.app, personClaims({ tid: undefined }));
        const actor = actorOf(await verifier().verify({ type: 'token', value: token }));
        expect(actor.workspaceId).toBeNull();
      });

      it('accepts an access token typed at+jwt, in either spelling', async () => {
        for (const typ of ['at+jwt', 'application/at+jwt', 'AT+JWT']) {
          const token = await mint(ring.app, personClaims(), { typ });
          expect([typ, actorOf(await verifier().verify({ type: 'token', value: token })).id]).toEqual([typ, 'user-alice']);
        }
      });

      it("turns a job's token into a job Actor bound to one workspace", async () => {
        const token = await mint(ring.app, jobClaims(), { subject: 'job-nightly-usage' });
        const actor = actorOf(await verifier().verify({ type: 'token', value: token }));

        expect(actor.kind).toBe('job');
        expect(actor.id).toBe('job-nightly-usage');
        expect(actor.jobId).toBe('job-nightly-usage');
        expect(actor.personId).toBeNull();
        expect(actor.role).toBeNull();
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.privileges).toEqual(['reports:export']);
      });

      it("refuses a job's token that names no workspace", async () => {
        const token = await mint(ring.app, jobClaims({ tid: undefined }), { subject: 'job-x' });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('invalid_claims');
      });

      it('refuses a token of a kind this verifier does not know', async () => {
        const token = await mint(ring.app, personClaims({ kind: 'superuser' }));
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('wrong_type');
        const arrayKind = await mint(ring.app, personClaims({ kind: ['job'] }));
        expect(refusalOf(await verifier().verify({ type: 'token', value: arrayKind }))).toBe('wrong_type');
        const protoKind = await mint(ring.app, personClaims({ kind: 'constructor' }));
        expect(refusalOf(await verifier().verify({ type: 'token', value: protoKind }))).toBe('wrong_type');
      });

      it('refuses a plain JWT, an untyped token or an ID token as an access token, even signed with the app\'s key', async () => {
        const cases: Array<[string, string | null]> = [
          ['a plain JWT', 'JWT'],
          ['an untyped token', null],
          ['an ID token', 'id+jwt'],
          ['a logout token', 'logout+jwt'],
        ];
        for (const [name, typ] of cases) {
          const token = await mint(ring.app, personClaims(), { typ });
          expect([name, refusalOf(await verifier().verify({ type: 'token', value: token }))]).toEqual([name, 'wrong_type']);
        }
      });

      it('refuses a token that does not name its app (an ID or refresh token, for example)', async () => {
        const token = await mint(ring.app, personClaims({ aid: undefined }));
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('invalid_claims');
      });

      it('refuses malformed privileges, scopes or workspace', async () => {
        for (const bad of [{ privileges: 'admin' }, { privileges: [1, 2] }, { scope: ['a'] }, { tid: 42 }]) {
          const token = await mint(ring.app, personClaims(bad));
          expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('invalid_claims');
        }
      });
    });

    describe('the audience', () => {
      it('must be configured: a verifier without one refuses to start, and never falls back to the app id', () => {
        const options = { appId: APP, issuer: ISSUER, jwks: ring.jwks, revocationCheck: 'none' } as CredentialVerifierOptions;
        expect(() => createCredentialVerifier(options)).toThrow(/audience/);
        expect(() => createCredentialVerifier({ ...options, audience: '' })).toThrow(/audience/);
      });

      it('refuses a token whose only audience is the app id when the API is the audience', async () => {
        const token = await mint(ring.app, personClaims(), { audience: APP });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('wrong_audience');
      });

      it('accepts a token that names the configured audience among others', async () => {
        const token = await mint(ring.app, personClaims(), { audience: ['https://other-api.example.test', AUDIENCE] });
        expect(actorOf(await verifier().verify({ type: 'token', value: token })).id).toBe('user-alice');
      });
    });

    describe('every kind of key, by introspection', () => {
      it('turns a personal key into a personal_key Actor acting for its member', async () => {
        const actor = actorOf(await verifier().verify({ type: 'key', value: 'k-personal' }));
        expect(actor.kind).toBe('personal_key');
        expect(actor.id).toBe('key-bob-reports');
        expect(actor.personId).toBe('user-bob');
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.privileges).toEqual(['reports:read']);
        expect(actor.jobId).toBeNull();
        expect(actor.credential).toMatchObject({ type: 'key', checkedBy: 'introspection', expiresAt: 4102444800 });
      });

      it('turns a personal key made for one job into an Actor narrowed to that job', async () => {
        const actor = actorOf(await verifier().verify({ type: 'key', value: 'k-personal-job' }));
        expect(actor.kind).toBe('personal_key');
        expect(actor.personId).toBe('user-alice');
        expect(actor.jobId).toBe('export-42');
        expect(actor.workspaceId).toBe('ws-alpha');
      });

      it('turns a service account key into an Actor bound to its workspace', async () => {
        const actor = actorOf(await verifier().verify({ type: 'key', value: 'k-service-account' }));
        expect(actor.kind).toBe('service_account_key');
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.personId).toBeNull();
      });

      it('turns an app key into an Actor that reaches the whole app', async () => {
        const actor = actorOf(await verifier().verify({ type: 'key', value: 'k-app' }));
        expect(actor.kind).toBe('app_key');
        expect(actor.appId).toBe(APP);
        expect(actor.workspaceId).toBeNull();
        expect(actor.personId).toBeNull();
      });

      it("accepts a Bridge service's key only where its app is trusted for services", async () => {
        expect(refusalOf(await verifier().verify({ type: 'key', value: 'k-service' }))).toBe('not_accepted');

        const trusting = verifier({ trustedServiceAppId: BRIDGE_APP });
        const actor = actorOf(await trusting.verify({ type: 'key', value: 'k-service' }));
        expect(actor.kind).toBe('service');
        expect(actor.appId).toBe(BRIDGE_APP);
        expect(actor.workspaceId).toBeNull();

        const trustingAnother = verifier({ trustedServiceAppId: OTHER_APP });
        expect(refusalOf(await trustingAnother.verify({ type: 'key', value: 'k-service' }))).toBe('wrong_app');
      });

      it('reads answers that do not say which kind of key: workspace-bound is a service account key, app-wide is an app key', async () => {
        const appWide = actorOf(await verifier().verify({ type: 'key', value: 'k-legacy-app' }));
        expect(appWide.kind).toBe('app_key');
        expect(appWide.workspaceId).toBeNull();
        const bound = actorOf(await verifier().verify({ type: 'key', value: 'k-legacy-ws' }));
        expect(bound.kind).toBe('service_account_key');
        expect(bound.workspaceId).toBe('ws-alpha');
      });

      it('refuses an inactive or unknown key', async () => {
        expect(refusalOf(await verifier().verify({ type: 'key', value: 'k-nobody-made-this' }))).toBe('inactive');
      });

      it('refuses an expired key even if the issuer still calls it active', async () => {
        expect(refusalOf(await verifier().verify({ type: 'key', value: 'k-expired' }))).toBe('expired');
      });

      it('refuses answers that do not describe a valid key', async () => {
        const cases: Array<[string, string]> = [
          ['k-not-a-key', 'wrong_type'],
          ['k-unknown-kind', 'wrong_type'],
          ['k-personal-no-member', 'invalid_claims'],
          ['k-service-account-no-ws', 'invalid_claims'],
          ['k-app-with-ws', 'invalid_claims'],
          ['k-job-on-app-key', 'invalid_claims'],
          ['k-bad-privileges', 'invalid_claims'],
        ];
        for (const [key, reason] of cases) {
          expect([key, refusalOf(await verifier().verify({ type: 'key', value: key }))]).toEqual([key, reason]);
        }
      });

      it('refuses, never accepts, when the issuer cannot be asked', async () => {
        for (const key of ['k-down', 'k-500', 'k-garbage']) {
          expect(refusalOf(await verifier().verify({ type: 'key', value: key }))).toBe('unavailable');
        }
      });

      it('refuses keys when no introspection endpoint is set up', async () => {
        const tokensOnly = verifier({ introspectionUrl: undefined });
        expect(refusalOf(await tokensOnly.verify({ type: 'key', value: 'k-app' }))).toBe('not_accepted');
      });
    });

    describe('refusals', () => {
      it('refuses an expired token', async () => {
        const token = await mint(ring.app, personClaims(), { expiresIn: Math.floor(Date.now() / 1000) - 60 });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('expired');
      });

      it('refuses a token that is not valid yet', async () => {
        const token = await mint(ring.app, personClaims(), { notBefore: '10m' });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('not_yet_valid');
      });

      it('allows a configured clock difference', async () => {
        const token = await mint(ring.app, personClaims(), { expiresIn: Math.floor(Date.now() / 1000) - 5 });
        const tolerant = verifier({ clockToleranceSeconds: 30 });
        expect(actorOf(await tolerant.verify({ type: 'token', value: token })).id).toBe('user-alice');
      });

      it('refuses a token without an expiry or a subject', async () => {
        const noExp = await mint(ring.app, personClaims(), { expiresIn: null });
        const noSub = await mint(ring.app, personClaims(), { subject: null });
        expect(refusalOf(await verifier().verify({ type: 'token', value: noExp }))).toBe('invalid_claims');
        expect(refusalOf(await verifier().verify({ type: 'token', value: noSub }))).toBe('invalid_claims');
      });

      it('refuses a token from another issuer', async () => {
        const token = await mint(ring.app, personClaims(), { issuer: 'https://evil.example.test' });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('wrong_issuer');
      });

      it('refuses a missing or malformed credential', async () => {
        const v = verifier();
        expect(refusalOf(await v.verify(null))).toBe('missing');
        expect(refusalOf(await v.verify({ type: 'token', value: '' }))).toBe('missing');
        expect(refusalOf(await v.verify({ type: 'token', value: 'not-a-token' }))).toBe('malformed');
        expect(refusalOf(await v.verify({ type: 'token', value: 'a.b.c' }))).toBe('malformed');
        expect(refusalOf(await v.verify({ type: 'cookie', value: 'x' } as never))).toBe('malformed');
      });

      it('never puts the credential in a refusal', async () => {
        const token = await mint(ring.app, personClaims(), { issuer: 'https://evil.example.test' });
        const result = await verifier().verify({ type: 'token', value: token });
        expect(JSON.stringify(result)).not.toContain(token.split('.')[1]);
      });

      it('verifyOrThrow returns the Actor, or throws a refusal that says why', async () => {
        const good = await mint(ring.app, personClaims());
        expect((await verifier().verifyOrThrow({ type: 'token', value: good })).id).toBe('user-alice');

        const expired = await mint(ring.app, personClaims(), { expiresIn: Math.floor(Date.now() / 1000) - 60 });
        const error = await verifier()
          .verifyOrThrow({ type: 'token', value: expired })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CredentialRefusedError);
        expect((error as CredentialRefusedError).reason).toBe('expired');
      });
    });

    describe('revocation', () => {
      it('refuses to start until it is told how revocation is checked: never a silent no-op', () => {
        const options = { appId: APP, issuer: ISSUER, audience: AUDIENCE, jwks: ring.jwks } as CredentialVerifierOptions;
        expect(() => createCredentialVerifier(options)).toThrow(/revocationCheck/);
        expect(() =>
          createCredentialVerifier({ ...options, revocationCheck: 'off' as unknown as 'none' }),
        ).toThrow(TypeError);
      });

      it("with 'none', refuses nothing for revocation", async () => {
        const token = await mint(ring.app, personClaims());
        expect(actorOf(await verifier({ revocationCheck: 'none' }).verify({ type: 'token', value: token })).id).toBe(
          'user-alice',
        );
      });

      it('refuses with `revoked` when the revocation check says access was taken away', async () => {
        const token = await mint(ring.app, personClaims({ sid: 'sess-ended' }));
        const seen: string[] = [];
        const v = verifier({
          revocationCheck: (actor) => {
            seen.push(actor.credential.sessionId ?? '');
            return actor.credential.sessionId === 'sess-ended'
              ? { revoked: true, message: 'The session was ended.' }
              : { revoked: false };
          },
        });
        const result = await v.verify({ type: 'token', value: token });
        expect(refusalOf(result)).toBe('revoked');
        expect(seen).toEqual(['sess-ended']);

        const keyResult = await v.verify({ type: 'key', value: 'k-app' });
        expect(keyResult.ok).toBe(true);
      });

      it('refuses, never accepts, when the revocation check fails', async () => {
        const token = await mint(ring.app, personClaims());
        const v = verifier({
          revocationCheck: () => {
            throw new Error('list unreachable');
          },
        });
        expect(refusalOf(await v.verify({ type: 'token', value: token }))).toBe('unavailable');
      });
    });

    describe('principle 1: who is calling comes only from the token', () => {
      it('principle 1: a request whose headers name another person, app or workspace still gets the token\'s identity', async () => {
        const token = await mint(ring.app, personClaims());
        const result = await verifier().verifyRequest({
          headers: {
            authorization: `Bearer ${token}`,
            'x-tenant-id': 'ws-beta',
            'x-workspace-id': 'ws-beta',
            'x-app-id': OTHER_APP,
            'x-user-id': 'user-mallory',
            'x-forwarded-user': 'user-mallory',
            'x-bridge-actor': JSON.stringify({ kind: 'app_key', id: 'mallory', workspaceId: null }),
          },
        });
        const actor = actorOf(result);
        expect(actor.id).toBe('user-alice');
        expect(actor.personId).toBe('user-alice');
        expect(actor.appId).toBe(APP);
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.privileges).toEqual(['invoices:read', 'invoices:write']);
      });

      it("principle 1: a request whose body names another person, app or workspace still gets the token's identity, and the body is never read", async () => {
        const token = await mint(ring.app, personClaims());
        const request = new Request('https://api.acme.test/invoices?workspaceId=ws-beta&userId=user-mallory', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: 'user-mallory', workspaceId: 'ws-beta', appId: OTHER_APP, privileges: ['*'] }),
        });
        const actor = actorOf(await verifier().verifyRequest(request));
        expect(actor.id).toBe('user-alice');
        expect(actor.appId).toBe(APP);
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.privileges).not.toContain('*');
        expect(request.bodyUsed).toBe(false);
      });

      it("principle 1: a key's caller context comes from the key, whatever workspace the request names", async () => {
        const actor = actorOf(
          await verifier().verifyRequest({
            headers: { 'x-api-key': 'k-service-account', 'x-tenant-id': 'ws-beta', 'x-app-id': OTHER_APP },
          }),
        );
        expect(actor.kind).toBe('service_account_key');
        expect(actor.workspaceId).toBe('ws-alpha');
        expect(actor.appId).toBe(APP);
      });

      it('principle 1: a person signed in without a workspace does not pick one up from the request', async () => {
        const token = await mint(ring.app, personClaims({ tid: undefined }));
        const actor = actorOf(
          await verifier().verifyRequest({ headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'ws-beta' } }),
        );
        expect(actor.workspaceId).toBeNull();
      });

      it('principle 1: a request that names a caller but carries no credential gets no Actor', async () => {
        const result = await verifier().verifyRequest({
          headers: { 'x-user-id': 'user-alice', 'x-tenant-id': 'ws-alpha', 'x-app-id': APP },
        });
        expect(refusalOf(result)).toBe('missing');
      });

      it('principle 1: the Actor cannot be changed after it is built', async () => {
        const token = await mint(ring.app, personClaims());
        const actor = actorOf(await verifier().verify({ type: 'token', value: token }));
        expect(Object.isFrozen(actor)).toBe(true);
        expect(Object.isFrozen(actor.privileges)).toBe(true);
        expect(Object.isFrozen(actor.claims)).toBe(true);
        expect(Object.isFrozen(actor.credential)).toBe(true);
        expect(() => {
          (actor as { workspaceId: string | null }).workspaceId = 'ws-beta';
        }).toThrow();
        expect(() => {
          (actor.privileges as string[]).push('admin');
        }).toThrow();
        expect(actor.workspaceId).toBe('ws-alpha');
      });
    });

    describe('principle 5: only signed data is a fact', () => {
      it('principle 5: a token with a changed payload is refused', async () => {
        const token = await mint(ring.app, personClaims());
        const otherWorkspace = tamper(token, (c) => {
          c.tid = 'ws-beta';
        });
        const morePrivileges = tamper(token, (c) => {
          (c.privileges as string[]).push('admin:everything');
        });
        const otherPerson = tamper(token, (c) => {
          c.sub = 'user-mallory';
        });
        for (const forged of [otherWorkspace, morePrivileges, otherPerson]) {
          expect(refusalOf(await verifier().verify({ type: 'token', value: forged }))).toBe('bad_signature');
        }
      });

      it('principle 5: a token with no signature (alg: none) is refused', async () => {
        const forged = unsigned({
          ...personClaims(),
          iss: ISSUER,
          aud: APP,
          sub: 'user-mallory',
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        expect(refusalOf(await verifier().verify({ type: 'token', value: forged }))).toBe('wrong_algorithm');
      });

      it('principle 5: a token signed with a wrong algorithm is refused, even by the right key', async () => {
        const rs256 = await mint(ring.app, personClaims(), { alg: 'RS256' });
        expect(refusalOf(await verifier().verify({ type: 'token', value: rs256 }))).toBe('wrong_algorithm');
        const hs256 = await hmacWithPublicKey(ring.app, personClaims());
        expect(refusalOf(await verifier().verify({ type: 'token', value: hs256 }))).toBe('wrong_algorithm');
      });

      it('principle 5: a token for the wrong audience is refused', async () => {
        const token = await mint(ring.app, personClaims(), { audience: 'https://other-api.example.test' });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('wrong_audience');
      });

      it("principle 5: a token signed with another app's key is refused", async () => {
        const otherKid = await mint(ring.otherApp, personClaims());
        expect(refusalOf(await verifier().verify({ type: 'token', value: otherKid }))).toBe('unknown_key');
        // Another app's key that claims the app's own key id still fails the signature.
        const sameKid = await mint(ring.otherAppSameKid, personClaims());
        expect(refusalOf(await verifier().verify({ type: 'token', value: sameKid }))).toBe('bad_signature');
      });

      it('principle 5: a token issued for another app is refused, even when it names this API as its audience', async () => {
        const token = await mint(ring.app, personClaims({ aid: OTHER_APP }), { audience: [AUDIENCE, OTHER_APP] });
        expect(refusalOf(await verifier().verify({ type: 'token', value: token }))).toBe('wrong_app');
      });

      it('principle 5: a key issued for another app is refused', async () => {
        expect(refusalOf(await verifier().verify({ type: 'key', value: 'k-other-app' }))).toBe('wrong_app');
      });
    });
  });
}
