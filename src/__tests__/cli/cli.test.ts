// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCallback,
  chooseSessionStore,
  createBridgeCli,
  FileSessionStore,
  KeychainWithFileStore,
  MacKeychainStore,
  canOpenBrowser,
  type BridgeCliOptions,
  type Runner,
  type StoredCliSession,
} from '../../cli/index.js';
import { pkceChallenge } from '../../core/util.js';

/**
 * The CLI sign-in helper against a fake issuer that answers as the contract
 * for an app's own CLI says: sign-in requests on a loopback return, the code
 * trade, short codes (RFC 8628), refresh with rotation, and revoke.
 */

const ORIGIN = 'https://bridge.test';
const APP = 'app-acme';
const ISSUER = `${ORIGIN}/identity-access/apps/${APP}`;
const AT = `${ORIGIN}/v2/identity-access/apps/${APP}`;
const PAGE = `${ORIGIN}/sign-in/${APP}/`;

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'PS256', typ: 'at+jwt' })}.${part(claims)}.sig`;
}

interface FakeOptions {
  device?: boolean;
  /** What each device poll answers, in turn: an OAuth error, or 'ok'. */
  polls?: string[];
  deviceRefused?: boolean;
  /** The refresh grant answers this error. */
  refreshError?: string;
  revokeDown?: boolean;
  /** How the fake browser comes back: changes to the callback's query. */
  callback?: (query: URLSearchParams) => void;
}

function fakeIssuer(options: FakeOptions = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const requests = new Map<string, { redirect_uri: string; state: string; code_challenge: string }>();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let refreshCount = 0;
  let accessCount = 0;
  const polls = [...(options.polls ?? [])];

  const answer = (status: number, body: unknown) => Response.json(body, { status });
  const tokens = () => {
    accessCount += 1;
    refreshCount += 1;
    return {
      access_token: jwt({ iss: ISSUER, aud: `${ORIGIN}/api`, sub: 'usr-anna', aid: APP, tid: 'ws-acme', privileges: ['invoices:read'], scope: 'management', email: 'anna@acme.test', n: accessCount }),
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: `rt-${String(refreshCount)}`,
      id_token: jwt({ iss: ISSUER, sub: 'usr-anna', email: 'anna@acme.test', name: 'Anna Berg' }),
      workspace: { id: 'ws-acme', name: 'Acme' },
    };
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, body });
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        token_endpoint: `${AT}/token`,
        revocation_endpoint: `${AT}/revoke`,
        jwks_uri: `${AT}/jwks.json`,
        bridge_app: APP,
        bridge_access_token_audience: `${ORIGIN}/api`,
        ...(options.device ? { device_authorization_endpoint: `${AT}/device-authorization` } : {}),
        bridge_endpoints: {
          '2': {
            sign_in: `${AT}/sign-in`,
            token: `${AT}/token`,
            revoke: `${AT}/revoke`,
            accounts: `${ORIGIN}/v2/accounts`,
            sign_in_requests: `${AT}/sign-in-requests`,
            sign_in_page: PAGE,
            ...(options.device ? { device_authorization: `${AT}/device-authorization` } : {}),
          },
        },
      });
    }
    if (url.pathname === `/v2/identity-access/apps/${APP}/sign-in-requests`) {
      const id = `req-${String(requests.size + 1)}`;
      requests.set(id, body as never);
      return answer(201, { request: id, expires_in: 600 });
    }
    if (url.pathname === `/v2/identity-access/apps/${APP}/device-authorization`) {
      if (options.deviceRefused) return answer(400, { error: 'unauthorized_client', error_description: 'This app does not allow sign-in with a short code. Sign in through the browser.' });
      return answer(200, { device_code: 'dc-1', user_code: 'BCDF-GHJK', verification_uri: `${PAGE}device/`, verification_uri_complete: `${PAGE}device/?code=BCDF-GHJK`, expires_in: 600, interval: 5 });
    }
    if (url.pathname === `/v2/identity-access/apps/${APP}/token`) {
      if (body['grant_type'] === 'authorization_code') {
        const code = codes.get(String(body['code']));
        if (!code || (await pkceChallenge(String(body['code_verifier']))) !== code.challenge || body['redirect_uri'] !== code.redirect) return answer(400, { error: 'invalid_grant' });
        codes.delete(String(body['code']));
        return answer(200, tokens());
      }
      if (body['grant_type'] === 'refresh_token') {
        if (options.refreshError) return answer(400, { error: options.refreshError });
        if (body['refresh_token'] !== `rt-${String(refreshCount)}`) return answer(400, { error: 'invalid_grant' });
        return answer(200, tokens());
      }
      if (body['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
        const next = polls.shift() ?? 'ok';
        return next === 'ok' ? answer(200, tokens()) : answer(400, { error: next });
      }
      return answer(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === `/v2/identity-access/apps/${APP}/revoke`) {
      if (options.revokeDown) throw new TypeError('fetch failed');
      return new Response(null, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  /** The person's browser: opens the page, signs in, and is sent back to the loopback. */
  const browser = async (pageUrl: string) => {
    const id = new URL(pageUrl).searchParams.get('request') ?? '';
    const held = requests.get(id);
    if (!held) return false;
    const code = `code-${id}`;
    codes.set(code, { challenge: held.code_challenge, redirect: held.redirect_uri });
    const query = new URLSearchParams({ code, state: held.state, iss: ISSUER });
    options.callback?.(query);
    // Not awaited by the CLI: the browser follows the redirect on its own.
    void fetch(`${held.redirect_uri}?${query.toString()}`).catch(() => undefined);
    return true;
  };

  return { fetchFn, browser, calls, requests, refreshTokens: () => refreshCount };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeCli(fake: ReturnType<typeof fakeIssuer>, extra: Partial<BridgeCliOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-test-'));
  dirs.push(dir);
  const configDir = join(dir, 'acme');
  const printed: string[] = [];
  const slept: number[] = [];
  const cli = createBridgeCli({
    issuer: ISSUER,
    name: 'acme',
    configDir,
    store: 'file',
    fetch: fake.fetchFn,
    openBrowser: fake.browser,
    canOpenBrowser: () => true,
    print: (message) => printed.push(message),
    sleep: async (ms) => {
      slept.push(ms);
    },
    timeoutMs: 5000,
    ...extra,
  });
  return { cli, configDir, printed, slept };
}

describe('CLI helper: browser sign-in through a loopback', () => {
  it('starts a sign-in request on 127.0.0.1/callback with S256 and a state, opens the page, trades the code, keeps the session', async () => {
    const fake = fakeIssuer();
    const { cli, configDir, printed } = await makeCli(fake);
    const me = await cli.login();
    const started = fake.calls.find((call) => call.path.endsWith('/sign-in-requests'))!.body;
    expect(started['redirect_uri']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(started['code_challenge_method']).toBe('S256');
    expect(String(started['code_challenge'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(started['state']).length).toBeGreaterThanOrEqual(8);
    expect(started['client_id']).toBe(APP);
    expect(printed.join('\n')).toContain(`${PAGE}?request=req-1`);
    const traded = fake.calls.find((call) => call.body['grant_type'] === 'authorization_code')!.body;
    expect(traded['redirect_uri']).toBe(started['redirect_uri']);
    expect(me).toMatchObject({ issuer: ISSUER, appId: APP, userId: 'usr-anna', email: 'anna@acme.test', name: 'Anna Berg', workspace: { id: 'ws-acme', name: 'Acme' }, privileges: ['invoices:read'], mayDelete: false });
    expect(await cli.whoami()).toEqual(me);
    // The private file: 0600 in a 0700 directory, and no ID token kept.
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    const file = join(configDir, 'sessions.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(await readFile(file, 'utf8'))[ISSUER] as StoredCliSession;
    expect(kept.refreshToken).toBe('rt-1');
    expect(JSON.stringify(kept)).not.toContain('id_token');
  });

  it.each([
    ['another state', (q: URLSearchParams) => q.set('state', 'someone-elses-state'), 'state_mismatch'],
    ['another issuer', (q: URLSearchParams) => q.set('iss', 'https://evil.test'), 'issuer_mismatch'],
    ['no issuer', (q: URLSearchParams) => q.delete('iss'), 'issuer_missing'],
    ['a refusal', (q: URLSearchParams) => {
      q.delete('code');
      q.set('error', 'access_denied');
    }, 'access_denied'],
  ])('refuses a return with %s and trades nothing', async (_, change, code) => {
    const fake = fakeIssuer({ callback: change });
    const { cli } = await makeCli(fake);
    await expect(cli.login()).rejects.toMatchObject({ code });
    expect(fake.calls.some((call) => call.body['grant_type'] === 'authorization_code')).toBe(false);
    expect(await cli.whoami()).toBeNull();
  });

  it('times out with a clear message when the browser never comes back', async () => {
    const fake = fakeIssuer();
    const { cli } = await makeCli(fake, { openBrowser: async () => false, timeoutMs: 100 });
    await expect(cli.login()).rejects.toMatchObject({ kind: 'flow-expired', code: 'timeout' });
  });
});

describe('CLI helper: checking the browser return', () => {
  const expected = { state: 'state-12345678', issuer: ISSUER };
  it('gives the code only for the same state and issuer', () => {
    expect(checkCallback({ code: 'c', state: 'state-12345678', iss: ISSUER }, expected)).toEqual({ code: 'c' });
    expect(() => checkCallback({ code: 'c', iss: ISSUER }, expected)).toThrow(/state/);
    expect(() => checkCallback({ error: 'access_denied', state: 'other' }, expected)).toThrow(/state/);
    expect(() => checkCallback({ state: 'state-12345678', iss: ISSUER }, expected)).toThrow(/without a code/);
  });
});

describe('CLI helper: short codes (RFC 8628)', () => {
  it('polls through authorization_pending and slow_down (five seconds more) to the tokens', async () => {
    const fake = fakeIssuer({ device: true, polls: ['authorization_pending', 'slow_down', 'authorization_pending', 'ok'] });
    const { cli, printed, slept } = await makeCli(fake);
    const me = await cli.login({ code: true });
    expect(me.email).toBe('anna@acme.test');
    expect(slept).toEqual([5000, 5000, 10000, 10000]);
    expect(printed.join('\n')).toContain('BCDF-GHJK');
    expect(printed.join('\n')).toContain(`${PAGE}device/`);
    expect(fake.calls.some((call) => call.path.endsWith('/sign-in-requests'))).toBe(false);
    const poll = fake.calls.find((call) => call.body['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code')!.body;
    expect(poll).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc-1', client_id: APP });
  });

  it.each([
    ['access_denied', 'cancelled', /refused/],
    ['expired_token', 'flow-expired', /expired/],
    ['invalid_grant', 'flow-expired', /already used/],
  ])('stops on %s with a clear message', async (error, kind, message) => {
    const fake = fakeIssuer({ device: true, polls: ['authorization_pending', error] });
    const { cli } = await makeCli(fake);
    const failure = cli.login({ code: true });
    await expect(failure).rejects.toMatchObject({ kind, code: error });
    await expect(failure).rejects.toThrow(message);
  });

  it('stops when the code runs out locally', async () => {
    let clock = 0;
    const fake = fakeIssuer({ device: true, polls: Array(1000).fill('authorization_pending') });
    const { cli } = await makeCli(fake, { now: () => clock, sleep: async (ms) => void (clock += ms) });
    await expect(cli.login({ code: true })).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('says so when the app does not allow short codes', async () => {
    await expect((await makeCli(fakeIssuer())).cli.login({ code: true })).rejects.toMatchObject({ kind: 'not-offered', code: 'unauthorized_client' });
    const refused = await makeCli(fakeIssuer({ device: true, deviceRefused: true }));
    await expect(refused.cli.login({ code: true })).rejects.toThrow('This app does not allow sign-in with a short code. Sign in through the browser.');
  });

  it('uses a short code when no browser can be opened here and the app allows them', async () => {
    const fake = fakeIssuer({ device: true });
    const { cli } = await makeCli(fake, { canOpenBrowser: () => false });
    await cli.login();
    expect(fake.calls.some((call) => call.path.endsWith('/device-authorization'))).toBe(true);
  });

  it('knows when a browser cannot be opened', () => {
    expect(canOpenBrowser({ SSH_CONNECTION: '1 2 3 4' }, 'darwin')).toBe(false);
    expect(canOpenBrowser({}, 'darwin')).toBe(true);
    expect(canOpenBrowser({}, 'linux')).toBe(false);
    expect(canOpenBrowser({ DISPLAY: ':0' }, 'linux')).toBe(true);
  });
});

describe('CLI helper: renewal', () => {
  it('gives the kept token while it is good for more than a minute, and renews within a minute of expiry, rotating the refresh token', async () => {
    let clock = 1_000_000;
    const fake = fakeIssuer();
    const { cli, configDir } = await makeCli(fake, { now: () => clock });
    await cli.login();
    const first = await cli.getAccessToken();
    expect(fake.calls.filter((call) => call.body['grant_type'] === 'refresh_token')).toHaveLength(0);
    clock += 900_000 - 59_000;
    const renewed = await cli.getAccessToken();
    expect(renewed).not.toBe(first);
    const refresh = fake.calls.filter((call) => call.body['grant_type'] === 'refresh_token');
    expect(refresh.map((call) => call.body)).toEqual([{ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: APP }]);
    const kept = JSON.parse(await readFile(join(configDir, 'sessions.json'), 'utf8'))[ISSUER] as StoredCliSession;
    expect(kept.refreshToken).toBe('rt-2');
    expect(kept.person.name).toBe('Anna Berg');
  });

  it('renews once for many calls at the same time', async () => {
    let clock = 1_000_000;
    const fake = fakeIssuer();
    const { cli } = await makeCli(fake, { now: () => clock });
    await cli.login();
    clock += 900_000;
    const tokens = await Promise.all([cli.getAccessToken(), cli.getAccessToken(), cli.getAccessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.calls.filter((call) => call.body['grant_type'] === 'refresh_token')).toHaveLength(1);
  });

  it('forgets a session Bridge ended and says to sign in again', async () => {
    let clock = 1_000_000;
    const fake = fakeIssuer({ refreshError: 'invalid_grant' });
    const { cli } = await makeCli(fake, { now: () => clock });
    await cli.login();
    clock += 900_000;
    await expect(cli.getAccessToken()).rejects.toMatchObject({ kind: 'signed-out', code: 'session_ended', message: expect.stringContaining('acme login') });
    expect(await cli.whoami()).toBeNull();
  });

  it('is signed-out before any login', async () => {
    const { cli } = await makeCli(fakeIssuer());
    await expect(cli.getAccessToken()).rejects.toMatchObject({ kind: 'signed-out', code: 'not_signed_in' });
    expect(await cli.whoami()).toBeNull();
  });

  it('fetch adds the token, and after a 401 renews once and tries again', async () => {
    const fake = fakeIssuer();
    const seen: string[] = [];
    const api = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith('https://acme.example/')) {
        seen.push(request.headers.get('authorization') ?? '');
        return new Response(null, { status: seen.length === 1 ? 401 : 200 });
      }
      return fake.fetchFn(input, init);
    }) as typeof fetch;
    const { cli } = await makeCli(fake, { fetch: api });
    await cli.login();
    const response = await cli.fetch('https://acme.example/api/invoices');
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every((value) => value.startsWith('Bearer '))).toBe(true);
  });
});

describe('CLI helper: sign-out', () => {
  it('revokes the refresh token and forgets the session', async () => {
    const fake = fakeIssuer();
    const { cli } = await makeCli(fake);
    await cli.login();
    expect(await cli.logout()).toEqual({ signedOut: true, revoked: true });
    expect(fake.calls.find((call) => call.path.endsWith('/revoke'))!.body).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token', client_id: APP });
    expect(await cli.whoami()).toBeNull();
    expect(await cli.logout()).toEqual({ signedOut: false, revoked: false, reason: 'not signed in' });
  });

  it('forgets the session here even when Bridge cannot be reached, and says so', async () => {
    const fake = fakeIssuer({ revokeDown: true });
    const { cli } = await makeCli(fake);
    await cli.login();
    const result = await cli.logout();
    expect(result).toMatchObject({ signedOut: true, revoked: false });
    expect(result.reason).toMatch(/reach/);
    expect(await cli.whoami()).toBeNull();
  });
});

describe('CLI helper: where tokens are kept', () => {
  const session: StoredCliSession = {
    issuer: ISSUER,
    appId: APP,
    accessToken: 'at',
    accessTokenExpiresAt: 1,
    refreshToken: 'rt',
    workspace: null,
    person: { id: 'usr-anna', email: null, name: null },
    signedInAt: 1,
  };

  function fakeKeychain(options: { refuse?: boolean; cut?: boolean } = {}) {
    const entries = new Map<string, string>();
    const runs: { command: string; args: readonly string[]; input?: string }[] = [];
    const run: Runner = async (command, args, input) => {
      runs.push({ command, args, ...(input === undefined ? {} : { input }) });
      if (args[0] === '-i') {
        if (options.refuse) return { code: 1, stdout: '', stderr: 'security: error' };
        const match = /-s (\S+) -a "([^"]+)" .* -w "([^"]+)"/.exec(input ?? '');
        if (match) entries.set(`${match[1]}|${match[2]}`, options.cut ? match[3].slice(0, 20) : match[3]);
        return { code: 0, stdout: '', stderr: '' };
      }
      const key = `${String(args[2])}|${String(args[4])}`;
      if (args[0] === 'find-generic-password') return entries.has(key) ? { code: 0, stdout: `${entries.get(key)!}\n`, stderr: '' } : { code: 44, stdout: '', stderr: '' };
      if (args[0] === 'delete-generic-password') entries.delete(key);
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, runs, entries };
  }

  it('uses the macOS keychain when there is one, a file otherwise, and the file when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-store-'));
    dirs.push(dir);
    expect(chooseSessionStore({ service: 'acme', dir, platform: 'darwin', hasProgram: () => true })).toBeInstanceOf(KeychainWithFileStore);
    expect(chooseSessionStore({ service: 'acme', dir, platform: 'darwin', hasProgram: () => false })).toBeInstanceOf(FileSessionStore);
    expect(chooseSessionStore({ service: 'acme', dir, platform: 'darwin', kind: 'file', hasProgram: () => true })).toBeInstanceOf(FileSessionStore);
    expect(chooseSessionStore({ service: 'acme', dir, platform: 'linux', env: {} })).toBeInstanceOf(FileSessionStore);
    expect(() => chooseSessionStore({ service: 'acme', dir, platform: 'win32', kind: 'keychain' })).toThrow(/no keychain/);
  });

  it('keeps the session in the keychain under the CLI name and the issuer, the secret on stdin only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-store-'));
    dirs.push(dir);
    const keychain = fakeKeychain();
    const store = new KeychainWithFileStore(new MacKeychainStore('acme', keychain.run), new FileSessionStore(dir), () => undefined);
    await store.write(session);
    expect(await store.read(ISSUER)).toEqual(session);
    const write = keychain.runs.find((run) => run.args[0] === '-i')!;
    expect(write.args).toEqual(['-i']);
    expect(write.input).toContain(`-s acme -a "${ISSUER}"`);
    expect(keychain.runs.every((run) => !run.args.join(' ').includes('"rt"'))).toBe(true);
    await expect(stat(join(dir, 'sessions.json'))).rejects.toThrow();
    await store.remove(ISSUER);
    expect(await store.read(ISSUER)).toBeNull();
  });

  it.each([
    ['refuses it', { refuse: true }],
    ['cuts it short', { cut: true }],
  ])('falls back to the private file when the keychain %s, and says so', async (_, behaviour) => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-store-'));
    dirs.push(dir);
    const warnings: string[] = [];
    const store = new KeychainWithFileStore(new MacKeychainStore('acme', fakeKeychain(behaviour).run), new FileSessionStore(dir), (message) => warnings.push(message));
    await store.write(session);
    expect(await store.read(ISSUER)).toEqual(session);
    expect(warnings.join(' ')).toContain('sessions.json');
    expect((await stat(join(dir, 'sessions.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a CLI name a keychain entry cannot carry', () => {
    expect(() => createBridgeCli({ issuer: ISSUER, name: 'acme "x"' })).toThrow(/name/);
    expect(() => createBridgeCli({ issuer: 'http://acme.example', name: 'acme' })).toThrow(/https/);
  });
});
