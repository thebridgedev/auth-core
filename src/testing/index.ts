/**
 * @nebulr-group/bridge-auth-core/testing
 *
 * A fake Bridge issuer in memory, for testing code built on the browser SDK
 * without a network: discovery, sign-in with the workspace step, sign-up
 * with its email link, password recovery, invites, refresh with rotation,
 * sign-out, accounts, flags, billing, usage and Live. Pass its `fetch` (and its
 * `websocket` for Live) to `createBridge`.
 *
 * Its tokens are shaped like Bridge's but not signed: they are for code
 * that reads who is signed in, never for a token check. It answers the way
 * Bridge does, including its refusals, but it is not Bridge: test against a
 * real Bridge before you ship.
 */

export interface FakePerson {
  readonly id: string;
  readonly email: string;
  password: string;
  firstName: string | null;
  lastName: string | null;
  readonly workspaces: { id: string; name: string; role: string }[];
}

export interface FakeIssuerOptions {
  readonly appId?: string;
  readonly origin?: string;
  /** `published`: metadata lists every endpoint (`bridge_endpoints`). `standard`: only the standard fields. @default 'published' */
  readonly metadata?: 'published' | 'standard';
  readonly accessTokenSeconds?: number;
  /** How long a replaced refresh token still works. @default 30 */
  readonly refreshGraceSeconds?: number;
  /** The clock, in ms. @default Date.now */
  readonly now?: () => number;
  /** The sign-in methods the app offers, as its sign-in options list them. @default ['password', 'magicLink'] */
  readonly methods?: readonly string[];
  /**
   * The app's registered sign-in returns: with any, the app uses the hosted
   * sign-in page, its metadata lists `sign_in_page` (`<origin>/sign-in/<app>/`)
   * and `sign_in_requests`, and a request names one of them exactly (a
   * loopback IP on any port). @default none
   */
  readonly returns?: readonly string[];
}

/** A Child App's sign-in request, held by the issuer: its challenge, return and state. */
interface SignInRequest {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly state: string;
  /** Where an email link sent on it goes. */
  readonly linkAddress: string;
  readonly expiresAt: number;
  used: boolean;
}

interface Session {
  readonly id: string;
  readonly user: string;
  workspace: string | null;
  ended: boolean;
}

interface Code {
  readonly user: string;
  readonly workspace: string | null;
  readonly challenge: string;
  /** The registered return it was made for: traded only with the same `redirect_uri`. */
  readonly redirectUri?: string;
  used: boolean;
  session: string | null;
}

interface LiveFrame {
  readonly seq: number;
  readonly cursor: string;
  readonly notice: { type: string; record: string | null; version: number | null; time: string; workspace: string | null };
}

export interface FakeSocket {
  readonly url: string;
  readonly protocols: readonly string[];
  readonly sent: unknown[];
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeInvite {
  readonly id: string;
  readonly email: string;
  role: string;
  state: 'open' | 'accepted' | 'revoked';
  expiresAt: string;
  invitedBy: string | null;
  createdAt: string;
  /** The link's token, as Bridge emails it: `<workspace>_<secret>`. Bridge keeps only its digest; the fake keeps it to answer. */
  token: string;
  readonly workspace: { readonly id: string; readonly name: string };
}

/** How long an invite works. */
const INVITE_DAYS = 30;

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function base64url(text: string): string {
  return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(typ: string, claims: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ }))}.${base64url(JSON.stringify(claims))}.`;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const secret = () => crypto.randomUUID().replace(/-/g, '');

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204 || body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const oauth = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });
const problem = (status: number, kind: string, detail: string) =>
  json(status, { type: `urn:bridge:problem:${kind}`, title: kind, status, detail }, { 'content-type': 'application/problem+json' });

export function createFakeIssuer(options: FakeIssuerOptions = {}) {
  const appId = options.appId ?? 'app-test';
  const origin = options.origin ?? 'https://bridge.test';
  const now = options.now ?? Date.now;
  const accessSeconds = options.accessTokenSeconds ?? 300;
  const graceMs = (options.refreshGraceSeconds ?? 30) * 1000;
  const issuer = `${origin}/identity-access/apps/${appId}`;
  const at = `${origin}/v2/identity-access/apps/${appId}`;

  const people = new Map<string, FakePerson>();
  const sessions = new Map<string, Session>();
  const accessTokens = new Map<string, { session: string; user: string; workspace: string | null; exp: number }>();
  const refreshTokens = new Map<string, { session: string; rotatedAt: number | null }>();
  const codes = new Map<string, Code>();
  const flows = new Map<string, { user: string; challenge: string; request?: SignInRequest }>();
  const returns = options.returns ?? [];
  const signInRequests = new Map<string, SignInRequest>();
  const methods = options.methods ?? ['password', 'magicLink'];
  // Passkeys: each ceremony's challenge, used once; each registered passkey, by its credential id.
  const passkeyChallenges = new Map<string, { purpose: 'sign-in' | 'register'; pkce?: string; email?: string | null; user?: string; link?: string; request?: SignInRequest }>();
  const passkeys = new Map<string, { id: string; user: string; name: string; createdAt: string; lastUsedAt: string | null }>();
  const links = new Map<string, { purpose: 'sign-up' | 'reset' | 'magic-link' | 'passkey-setup'; email: string; challenge?: string; request?: SignInRequest; expiresAt?: number; signUp?: { password: string; firstName: string | null; lastName: string | null; workspace: string | boolean | null } }>();
  const sentLinks: { to: string; purpose: string; token: string }[] = [];
  const requests: RecordedRequest[] = [];
  const invites: FakeInvite[] = [];
  const usage: unknown[] = [];
  let flagResults: Record<string, unknown>[] = [];
  let flagsRevision = 1;
  let visitorFlags: Record<string, unknown>[] = [];
  let facts: Record<string, unknown> = { plan: null, status: 'none', access: 'needs_plan', features: {}, limits: {}, usage: {}, periodStart: null, periodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, waiting: null, locked: false };
  let plans: Record<string, unknown>[] = [];
  const checkouts = new Set<string>();
  const live = { history: new Map<string, LiveFrame[]>(), sockets: [] as FakeSocket[], subscribed: new Map<FakeSocket, Map<string, string>>(), offered: true, lost: new Set<string>() };
  let nextId = 1;
  const id = (prefix: string) => `${prefix}${String(nextId++).padStart(4, '0')}`;

  function metadata(): Record<string, unknown> {
    const standard = {
      issuer,
      authorization_challenge_endpoint: `${at}/sign-in`,
      token_endpoint: `${at}/token`,
      revocation_endpoint: `${at}/revoke`,
      introspection_endpoint: `${at}/introspect`,
      jwks_uri: `${at}/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      code_challenge_methods_supported: ['S256'],
    };
    if (options.metadata === 'standard') return standard;
    const v2 = `${origin}/v2`;
    return {
      ...standard,
      bridge_app: appId,
      bridge_api_version: 2,
      bridge_access_token_audience: `${origin}/api`,
      bridge_revocation_lanes: Object.fromEntries(['identity-access', 'accounts', 'billing', 'app-registry'].map((lane) => [lane, `${v2}/${lane}/apps/${appId}/revocations/${lane}`])),
      bridge_endpoints: {
        '2': {
          sign_in: `${at}/sign-in`,
          token: `${at}/token`,
          revoke: `${at}/revoke`,
          introspect: `${at}/introspect`,
          jwks: `${at}/jwks.json`,
          sign_in_options: `${at}/sign-in-options`,
          sign_up: `${at}/sign-up`,
          sign_up_verify: `${at}/sign-up/verify`,
          ...(returns.length === 0 ? {} : { sign_in_page: `${origin}/sign-in/${appId}/`, sign_in_requests: `${at}/sign-in-requests` }),
          magic_link: `${at}/magic-link`,
          magic_link_verify: `${at}/magic-link/verify`,
          passkey_sign_in_options: `${at}/passkeys/sign-in/options`,
          passkey_sign_in: `${at}/passkeys/sign-in`,
          passkey_setup_link: `${at}/passkeys/setup-link`,
          passkey_setup_options: `${at}/passkeys/setup/options`,
          passkey_setup: `${at}/passkeys/setup`,
          passkeys: `${v2}/identity-access/passkeys`,
          password_forgot: `${at}/password/forgot`,
          password: `${at}/password`,
          sign_out: `${v2}/identity-access/sign-out`,
          sessions: `${v2}/identity-access/sessions`,
          accounts: `${v2}/accounts`,
          billing: `${v2}/billing`,
          flags: `${v2}/flags`,
          flags_visitor: `${v2}/flags/apps/${appId}`,
          live: `${v2}/live`,
          live_visitor: `${v2}/live/apps/${appId}`,
          ...(live.offered ? { live_connection: `${v2}/live/apps/${appId}/connection` } : {}),
          events_and_logs: `${v2}/events-and-logs`,
          invites: `${v2}/identity-access/invites`,
          invite_preview: `${at}/invites/preview`,
        },
      },
    };
  }

  function issueTokens(session: Session, withRefresh = true) {
    const person = people.get(session.user) as FakePerson;
    const membership = person.workspaces.find((each) => each.id === session.workspace) ?? null;
    const exp = Math.floor(now() / 1000) + accessSeconds;
    const access = fakeJwt('at+jwt', {
      iss: issuer, aud: `${origin}/api`, sub: person.id, aid: appId, sid: session.id, jti: secret(), exp,
      ...(membership === null ? {} : { tid: membership.id, wst: 'active' }),
      email: person.email, email_verified: true,
    });
    accessTokens.set(access, { session: session.id, user: person.id, workspace: session.workspace, exp: exp * 1000 });
    const idToken = fakeJwt('JWT', { iss: issuer, aud: appId, sub: person.id, aid: appId, sid: session.id, email: person.email, email_verified: true, exp });
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: accessSeconds, id_token: idToken, ...(membership === null ? {} : { workspace: membership.id }) };
    if (withRefresh) {
      const refresh = secret();
      refreshTokens.set(refresh, { session: session.id, rotatedAt: null });
      body['refresh_token'] = refresh;
    }
    return json(200, body, { 'cache-control': 'no-store' });
  }

  function endSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session !== undefined) session.ended = true;
    for (const [token, record] of refreshTokens) if (record.session === sessionId) refreshTokens.delete(token);
  }

  /** A registered return, exactly, or a registered loopback IP's on any port (RFC 8252, 7.3). */
  function isReturn(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    if (returns.includes(value)) return true;
    const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}(\/.*)$/.exec(value);
    return loopback !== null && returns.includes(`http://${loopback[1]}${loopback[2]}`);
  }

  /** The request a step names, open now: undefined when it names none, a refusal when it is gone. */
  function openRequest(body: Record<string, unknown>): SignInRequest | Response | undefined {
    if (body['request'] === undefined) return undefined;
    const found = signInRequests.get(String(body['request']));
    if (found === undefined || found.used || found.expiresAt <= now()) return oauth(400, 'invalid_request_uri', { error_description: 'The sign-in request has expired or was already used.' });
    return found;
  }

  function toWorkspace(person: FakePerson, challenge: string, requested: string | null, request?: SignInRequest): Response {
    let workspace = requested;
    if (workspace === null) {
      if (person.workspaces.length > 1) {
        const flow = secret();
        flows.set(flow, { user: person.id, challenge, ...(request === undefined ? {} : { request }) });
        return json(200, { next: 'workspace', flow, workspaces: person.workspaces.map((each) => ({ id: each.id, name: each.name, logo: null })) });
      }
      workspace = person.workspaces[0]?.id ?? null;
    }
    if (workspace !== null && !person.workspaces.some((each) => each.id === workspace)) return oauth(403, 'access_denied', { reason: 'not_a_member' });
    const code = secret();
    if (request !== undefined) {
      codes.set(code, { user: person.id, workspace, challenge: request.challenge, redirectUri: request.redirectUri, used: false, session: null });
      return json(200, { code, redirect_uri: request.redirectUri, state: request.state });
    }
    codes.set(code, { user: person.id, workspace, challenge, used: false, session: null });
    return json(200, { code });
  }

  /** Makes an invite, or sends it again with a new token (the old one stops working), and "emails" its link. */
  function makeInvite(email: string, workspace: { id: string; name: string }, role: string, invitedBy: string | null) {
    const address = email.toLowerCase();
    const token = `${workspace.id}_${secret()}`;
    const fields = { role, state: 'open' as const, expiresAt: new Date(now() + INVITE_DAYS * 86_400_000).toISOString(), invitedBy, token };
    let invite = invites.find((each) => each.email === address && each.workspace.id === workspace.id);
    if (invite === undefined) {
      invite = { id: id('inv'), email: address, workspace, createdAt: new Date(now()).toISOString(), ...fields };
      invites.push(invite);
    } else {
      Object.assign(invite, fields);
    }
    const known = [...people.values()].some((each) => each.email === address);
    sentLinks.push({ to: address, purpose: known ? 'invite-existing' : 'invite-new', token });
    return invite;
  }

  const inviteView = (invite: FakeInvite) => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    state: invite.state === 'open' && Date.parse(invite.expiresAt) <= now() ? 'expired' : invite.state,
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    createdAt: invite.createdAt,
  });

  /** The invite a token is for while it works, or why it does not: as Bridge, a token that names none reads as expired. */
  function inviteFor(token: unknown): FakeInvite | 'invite_revoked' | 'invite_used' | 'invite_expired' {
    const invite = invites.find((each) => each.token === token);
    if (invite === undefined) return 'invite_expired';
    if (invite.state === 'revoked') return 'invite_revoked';
    if (invite.state === 'accepted') return 'invite_used';
    if (Date.parse(invite.expiresAt) <= now()) return 'invite_expired';
    return invite;
  }

  const inviteRefused = (reason: 'invite_revoked' | 'invite_used' | 'invite_expired') =>
    oauth(410, reason, { error_description: reason === 'invite_revoked' ? 'This invite was revoked.' : reason === 'invite_used' ? 'This invite was used already.' : 'This invite has expired; ask for a new one.' });

  function join(person: FakePerson, invite: FakeInvite): void {
    person.workspaces.push({ id: invite.workspace.id, name: invite.workspace.name, role: invite.role });
    invite.state = 'accepted';
  }

  function personOf(headers: Headers): { session: Session; person: FakePerson } | null {
    const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const record = accessTokens.get(token);
    if (record === undefined || record.exp <= now()) return null;
    const session = sessions.get(record.session);
    if (session === undefined || session.ended) return null;
    return { session: { ...session, workspace: record.workspace }, person: people.get(record.user) as FakePerson };
  }

  const unauthorized = () => problem(401, 'credential-refused', 'The token is not valid.');

  /** A ceremony's options, its challenge kept to be used once. */
  function passkeyOptions(purpose: 'sign-in' | 'register', record: { pkce?: string; email?: string | null; user?: string; link?: string }): Response {
    const challenge = secret();
    passkeyChallenges.set(challenge, { purpose, ...record });
    if (purpose === 'sign-in') return json(200, { options: { challenge, rpId: 'localhost', userVerification: 'required', timeout: 300_000, allowCredentials: [] } });
    const person = people.get(record.user as string) as FakePerson;
    const excludeCredentials = [...passkeys.values()].filter((each) => each.user === person.id).map((each) => ({ id: each.id, type: 'public-key' }));
    return json(200, { options: { challenge, rp: { id: 'localhost', name: 'localhost' }, user: { id: base64url(person.id), name: person.email, displayName: person.email }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 300_000, attestation: 'none', excludeCredentials, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } });
  }

  /** Spends the challenge an authenticator's answer signed, once: its record, or null. */
  function spentChallenge(response: unknown, purpose: 'sign-in' | 'register') {
    const client = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
    let challenge: unknown;
    try {
      challenge = (JSON.parse(atob(String(client).replace(/-/g, '+').replace(/_/g, '/'))) as { challenge?: unknown }).challenge;
    } catch {
      return null;
    }
    const record = passkeyChallenges.get(String(challenge));
    passkeyChallenges.delete(String(challenge));
    return record?.purpose === purpose ? record : null;
  }

  /** Keeps the passkey an authenticator made, or refuses one registered already. */
  function keepPasskey(response: unknown, user: string, name: unknown): Response | { id: string } {
    const credential = String((response as { id?: unknown } | null)?.id);
    if (passkeys.has(credential)) return oauth(409, 'passkey_exists', { error_description: 'This device has a passkey for the app already.' });
    passkeys.set(credential, { id: credential, user, name: typeof name === 'string' && name !== '' ? name : 'Passkey', createdAt: new Date(now()).toISOString(), lastUsedAt: null });
    return { id: credential };
  }
  const passkeyView = (each: { id: string; name: string; createdAt: string; lastUsedAt: string | null }) => ({ id: each.id, name: each.name, createdAt: each.createdAt, lastUsedAt: each.lastUsedAt, deviceType: 'multiDevice', backedUp: true, aaguid: '00000000-0000-0000-0000-000000000000' });

  function channelsFor(who: { session: Session; person: FakePerson } | null) {
    const channels = [{ kind: 'app', name: `/app/${appId}` }];
    if (who !== null) {
      channels.push({ kind: 'account', name: `/account/${appId}/${who.person.id}/1` });
      if (who.session.workspace !== null) channels.push({ kind: 'workspace', name: `/workspace/${appId}/${who.session.workspace}/1` });
    }
    return channels.map((channel) => {
      const frames = live.history.get(channel.name) ?? [];
      return { ...channel, cursor: `${channel.name}#${String(frames.at(-1)?.seq ?? 0)}` };
    });
  }

  function historyFrom(cursor: string) {
    const [name, seq] = cursor.split('#');
    if (live.lost.delete(name ?? '')) return { fetchAgain: true, reason: 'gap' };
    const frames = (live.history.get(name ?? '') ?? []).filter((frame) => frame.seq > Number(seq));
    return { fetchAgain: false, notices: frames, cursor: frames.at(-1)?.cursor ?? cursor };
  }

  async function handle(method: string, url: URL, headers: Headers, body: Record<string, unknown>): Promise<Response> {
    const path = url.pathname;
    if (method === 'GET' && path === `/identity-access/apps/${appId}/.well-known/openid-configuration`) return json(200, metadata());

    if (path.startsWith(`/v2/identity-access/apps/${appId}/`)) {
      const route = path.slice(`/v2/identity-access/apps/${appId}`.length);
      if (route === '/sign-in') {
        if (typeof body['flow'] === 'string') {
          const flow = flows.get(body['flow']);
          flows.delete(body['flow']);
          if (flow === undefined) return oauth(400, 'flow_expired');
          return toWorkspace(people.get(flow.user) as FakePerson, flow.challenge, String(body['workspace']), flow.request);
        }
        const request = openRequest(body);
        if (request instanceof Response) return request;
        if (request === undefined && (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string')) return oauth(400, 'invalid_request');
        if (request !== undefined && (body['code_challenge'] !== undefined || body['redirect_uri'] !== undefined)) return oauth(400, 'invalid_request');
        const person = [...people.values()].find((each) => each.email === String(body['email']).toLowerCase());
        if (person === undefined || person.password !== body['password']) return oauth(400, 'wrong_credentials');
        if (request !== undefined) request.used = true;
        return toWorkspace(person, request?.challenge ?? String(body['code_challenge']), typeof body['workspace'] === 'string' ? body['workspace'] : null, request);
      }
      if (route === '/sign-in-requests' && returns.length > 0) {
        if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body['code_challenge'])) return oauth(400, 'invalid_request');
        if (typeof body['state'] !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(body['state'])) return oauth(400, 'invalid_request');
        if (!isReturn(body['redirect_uri'])) return oauth(400, 'invalid_request', { error_description: "redirect_uri is not one of the app's registered sign-in returns." });
        const id = secret();
        signInRequests.set(id, { challenge: body['code_challenge'], redirectUri: body['redirect_uri'], state: body['state'], linkAddress: typeof body['link_address'] === 'string' ? body['link_address'] : `${origin}/sign-in/${appId}/`, expiresAt: now() + 10 * 60 * 1000, used: false });
        return json(201, { request: id, expires_in: 600 });
      }
      if (route === '/sign-in-options' && method === 'GET') return json(200, { app: { id: appId }, signUp: true, methods, ...(methods.includes('password') ? { password: { minLength: 8, maxLength: 128 } } : {}) });
      if (route === '/magic-link') {
        if (!methods.includes('magicLink')) return oauth(403, 'method_disabled');
        const request = openRequest(body);
        if (request instanceof Response) return request;
        // The asking device's challenge, on a sign-in request too: it binds the link to that device.
        if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string') return oauth(400, 'invalid_request');
        const email = String(body['email']).toLowerCase();
        if ([...people.values()].some((each) => each.email === email)) {
          // Only the newest link of an address works.
          for (const [token, link] of links) if (link.purpose === 'magic-link' && link.email === email) links.delete(token);
          const token = secret();
          links.set(token, { purpose: 'magic-link', email, challenge: String(body['code_challenge']), ...(request === undefined ? {} : { request }), expiresAt: now() + 15 * 60 * 1000 });
          sentLinks.push({ to: email, purpose: 'magic-link', token });
        }
        return json(202, { next: 'verify_email' });
      }
      if (route === '/magic-link/verify') {
        const link = links.get(String(body['token']));
        if (link?.purpose !== 'magic-link' || (link.expiresAt ?? 0) <= now()) return oauth(400, 'invalid_link');
        // Only the device that asked opens it; a link sent on a sign-in request also opens with that request's app's verifier.
        const presented = typeof body['code_verifier'] === 'string' ? await s256(body['code_verifier']) : null;
        if (presented === null || (presented !== link.challenge && presented !== link.request?.challenge)) return oauth(400, 'wrong_device', { error_description: 'Open the link on the device you asked for it on.' });
        if (link.request?.used === true) return oauth(400, 'invalid_request_uri', { error_description: 'The sign-in request has expired or was already used.' });
        links.delete(String(body['token']));
        if (link.request !== undefined) link.request.used = true;
        const person = [...people.values()].find((each) => each.email === link.email) as FakePerson;
        return toWorkspace(person, link.request?.challenge ?? (link.challenge as string), null, link.request);
      }
      if (route.startsWith('/passkeys/') && !methods.includes('passkeys')) return oauth(403, 'method_disabled', { error_description: 'The app does not offer passkey sign-in.' });
      if (route === '/passkeys/sign-in/options') {
        const request = openRequest(body);
        if (request instanceof Response) return request;
        if (request === undefined && (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string')) return oauth(400, 'invalid_request');
        return passkeyOptions('sign-in', { pkce: request?.challenge ?? String(body['code_challenge']), email: typeof body['email'] === 'string' ? body['email'].toLowerCase() : null, ...(request === undefined ? {} : { request }) });
      }
      if (route === '/passkeys/sign-in') {
        const record = spentChallenge(body['response'], 'sign-in');
        if (record === null) return oauth(400, 'invalid_challenge', { error_description: 'The passkey request expired or was used already. Start again.' });
        const passkey = passkeys.get(String((body['response'] as { id?: unknown }).id));
        if (passkey === undefined) return oauth(400, 'unknown_passkey', { error_description: 'This passkey is not registered for the app.' });
        const person = people.get(passkey.user) as FakePerson;
        if (record.email != null && record.email !== person.email) return oauth(400, 'passkey_refused', { error_description: 'The passkey could not be verified.' });
        passkey.lastUsedAt = new Date(now()).toISOString();
        if (record.request?.used === true) return oauth(400, 'invalid_request_uri');
        if (record.request !== undefined) record.request.used = true;
        return toWorkspace(person, record.pkce as string, typeof body['workspace'] === 'string' ? body['workspace'] : null, record.request);
      }
      if (route === '/passkeys/setup-link') {
        const email = String(body['email']).toLowerCase();
        if ([...people.values()].some((each) => each.email === email)) {
          const token = secret();
          links.set(token, { purpose: 'passkey-setup', email, challenge: String(body['code_challenge']), expiresAt: now() + 24 * 3600 * 1000 });
          sentLinks.push({ to: email, purpose: 'passkey-setup', token });
        }
        return json(202, { next: 'verify_email' });
      }
      if (route === '/passkeys/setup/options' || route === '/passkeys/setup') {
        const link = links.get(String(body['token']));
        if (link?.purpose !== 'passkey-setup' || (link.expiresAt ?? 0) <= now()) return oauth(400, 'invalid_link');
        if (typeof body['code_verifier'] !== 'string' || (await s256(body['code_verifier'])) !== link.challenge) return oauth(400, 'wrong_device', { error_description: 'Open the link on the device you asked for it on.' });
        const person = [...people.values()].find((each) => each.email === link.email) as FakePerson;
        if (route === '/passkeys/setup/options') return passkeyOptions('register', { user: person.id, link: String(body['token']) });
        const record = spentChallenge(body['response'], 'register');
        if (record?.link !== body['token']) return oauth(400, 'invalid_challenge');
        const kept = keepPasskey(body['response'], person.id, body['name']);
        if (kept instanceof Response) return kept;
        links.delete(String(body['token']));
        return toWorkspace(person, link.challenge as string, null);
      }
      if (route === '/token') {
        if (body['grant_type'] === 'authorization_code') {
          const code = codes.get(String(body['code']));
          if (code === undefined || code.used || (await s256(String(body['code_verifier']))) !== code.challenge || (code.redirectUri !== undefined && body['redirect_uri'] !== code.redirectUri)) {
            if (code?.used && code.session !== null) endSession(code.session);
            return oauth(400, 'invalid_grant', { error_description: 'The code is not valid.' });
          }
          code.used = true;
          const session: Session = { id: id('ses'), user: code.user, workspace: code.workspace, ended: false };
          sessions.set(session.id, session);
          code.session = session.id;
          return issueTokens(session);
        }
        if (body['grant_type'] === 'refresh_token') {
          const record = refreshTokens.get(String(body['refresh_token']));
          const session = record === undefined ? undefined : sessions.get(record.session);
          if (record === undefined || session === undefined || session.ended) return oauth(400, 'invalid_grant', { error_description: 'The session has ended; sign in again.' });
          if (record.rotatedAt !== null && now() - record.rotatedAt > graceMs) {
            endSession(session.id);
            return oauth(400, 'invalid_grant', { error_description: 'The refresh token was already used; the session has ended.' });
          }
          if (typeof body['workspace'] === 'string') {
            const person = people.get(session.user) as FakePerson;
            if (!person.workspaces.some((each) => each.id === body['workspace'])) return oauth(403, 'access_denied', { reason: 'not_a_member' });
            session.workspace = body['workspace'];
          }
          record.rotatedAt ??= now();
          return issueTokens(session);
        }
        return oauth(400, 'unsupported_grant_type');
      }
      if (route === '/revoke') {
        const record = refreshTokens.get(String(body['token']));
        if (record !== undefined) endSession(record.session);
        return json(200, {});
      }
      if (route === '/invites/preview' && method === 'POST') {
        const found = inviteFor(body['token']);
        if (typeof found === 'string') return json(200, { state: found === 'invite_revoked' ? 'revoked' : found === 'invite_used' ? 'used' : 'expired' });
        return json(200, { state: 'open', workspace: { name: found.workspace.name, logo: null }, account: [...people.values()].some((each) => each.email === found.email) });
      }
      if (route === '/sign-up' && body['invite'] !== undefined) {
        if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string') return oauth(400, 'invalid_request');
        if (body['workspace'] !== undefined) return oauth(400, 'invalid_request', { error_description: 'A sign-up from an invite joins the inviting workspace, and makes none of its own.' });
        const found = inviteFor(body['invite']);
        if (typeof found === 'string') return inviteRefused(found);
        if (body['email'] !== undefined && String(body['email']).toLowerCase() !== found.email) return oauth(403, 'invite_for_another_address', { error_description: 'This invite is for another email address.' });
        if ([...people.values()].some((each) => each.email === found.email)) return oauth(409, 'account_exists', { error_description: 'This address has an account already: sign in, then accept the invite.' });
        const person = addPerson({ email: found.email, password: String(body['password']), firstName: (body['firstName'] as string) ?? null, lastName: (body['lastName'] as string) ?? null });
        join(person, found);
        return toWorkspace(person, body['code_challenge'], found.workspace.id);
      }
      if (route === '/sign-up') {
        const email = String(body['email']).toLowerCase();
        const token = secret();
        const request = openRequest(body);
        if (request instanceof Response) return request;
        if (![...people.values()].some((each) => each.email === email)) {
          links.set(token, { purpose: 'sign-up', email, challenge: String(body['code_challenge']), ...(request === undefined ? {} : { request }), signUp: { password: String(body['password']), firstName: (body['firstName'] as string) ?? null, lastName: (body['lastName'] as string) ?? null, workspace: (body['workspace'] as string | boolean) ?? null } });
          sentLinks.push({ to: email, purpose: 'verify-sign-up', token });
        } else {
          sentLinks.push({ to: email, purpose: 'account-exists', token: '' });
        }
        return json(202, { next: 'verify_email' });
      }
      if (route === '/sign-up/verify') {
        const link = links.get(String(body['token']));
        if (link?.purpose !== 'sign-up' || link.signUp === undefined) return oauth(400, 'invalid_link');
        if (typeof body['code_verifier'] !== 'string' || (await s256(body['code_verifier'])) !== link.challenge) return oauth(400, 'wrong_device', { error_description: 'Open the link on the device you signed up on.' });
        if (link.request?.used === true) return oauth(400, 'invalid_request_uri');
        links.delete(String(body['token']));
        if (link.request !== undefined) link.request.used = true;
        const workspaces = link.signUp.workspace === null ? [] : [{ id: id('ws'), name: typeof link.signUp.workspace === 'string' ? link.signUp.workspace : '', role: 'OWNER' }];
        const person = addPerson({ email: link.email, password: link.signUp.password, firstName: link.signUp.firstName, lastName: link.signUp.lastName, workspaces });
        return toWorkspace(person, link.challenge as string, workspaces[0]?.id ?? null, link.request);
      }
      if (route === '/password/forgot') {
        const email = String(body['email']).toLowerCase();
        if ([...people.values()].some((each) => each.email === email)) {
          const token = secret();
          links.set(token, { purpose: 'reset', email });
          sentLinks.push({ to: email, purpose: 'reset-password', token });
        }
        return json(202, { next: 'verify_email' });
      }
      if (route === '/password') {
        const link = links.get(String(body['token']));
        if (link?.purpose !== 'reset') return oauth(400, 'invalid_link');
        links.delete(String(body['token']));
        const person = [...people.values()].find((each) => each.email === link.email) as FakePerson;
        person.password = String(body['password']);
        for (const session of sessions.values()) if (session.user === person.id) endSession(session.id);
        return json(200, { done: true });
      }
      return problem(404, 'not-found', 'No such route.');
    }

    if (method === 'POST' && path === '/v2/identity-access/sign-out') {
      const who = personOf(headers);
      if (who === null) return unauthorized();
      endSession(who.session.id);
      return json(200, { ended: true });
    }

    if (path === `/v2/live/apps/${appId}/connection`) return json(200, { kind: 'appsync-events', endpoint: 'wss://live.bridge.test/event/realtime', host: 'live-http.bridge.test', region: 'test-1' });
    if (path === `/v2/live/apps/${appId}/channels`) return json(200, { channels: channelsFor(null) });
    if (path === `/v2/live/apps/${appId}/history`) return json(200, historyFrom(url.searchParams.get('cursor') ?? `/app/${appId}#0`));
    if (method === 'POST' && path === `/v2/flags/apps/${appId}/ofrep/v1/evaluate/flags`) return json(200, { flags: visitorFlags }, { etag: `"v${String(flagsRevision)}"` });

    if (method === 'POST' && path === '/v2/billing/usage') {
      if (headers.get('x-api-key') === null) return problem(401, 'credential-missing', 'This route needs a token or a key.');
      const reports = (body['reports'] as unknown[]) ?? [];
      usage.push(...reports);
      return json(201, { counted: reports.length, deduped: 0, outcomes: [] });
    }

    // Everything below is for a signed-in person.
    const who = personOf(headers);
    if (who === null) return unauthorized();
    const { person, session } = who;
    const workspaceRequired = () => (session.workspace === null ? problem(403, 'workspace-required', 'Choose a workspace first.') : null);

    if (path === '/v2/identity-access/passkeys' && method === 'GET') return json(200, [...passkeys.values()].filter((each) => each.user === person.id).reverse().map(passkeyView));
    if (path === '/v2/identity-access/passkeys/options' && method === 'POST') {
      if (!methods.includes('passkeys')) return oauth(403, 'method_disabled');
      return passkeyOptions('register', { user: person.id });
    }
    if (path === '/v2/identity-access/passkeys' && method === 'POST') {
      const record = spentChallenge(body['response'], 'register');
      if (record?.user !== person.id || record.link !== undefined) return oauth(400, 'invalid_challenge');
      const kept = keepPasskey(body['response'], person.id, body['name']);
      return kept instanceof Response ? kept : json(201, passkeyView(passkeys.get(kept.id) as { id: string; name: string; createdAt: string; lastUsedAt: string | null }));
    }
    const passkeyMatch = path.match(/^\/v2\/identity-access\/passkeys\/([^/]+)$/);
    if (passkeyMatch !== null && method === 'DELETE') {
      const found = passkeys.get(decodeURIComponent(passkeyMatch[1] as string));
      if (found?.user !== person.id) return problem(404, 'not-found', '');
      const mine = [...passkeys.values()].filter((each) => each.user === person.id);
      if (mine.length === 1 && !methods.includes('password') && !methods.includes('magicLink')) return oauth(409, 'last_sign_in_method', { error_description: 'This passkey is the only way left to sign in. Add another first.' });
      passkeys.delete(found.id);
      return new Response(null, { status: 204 });
    }
    if (path === '/v2/accounts/me' && method === 'GET') {
      return json(200, { id: person.id, email: person.email, firstName: person.firstName, lastName: person.lastName, phoneNumber: null, onboarded: false, consentsToPrivacyPolicy: false, suspended: false, workspaces: person.workspaces.map((each) => ({ id: each.id, name: each.name, logo: null, member: `mem-${each.id}`, role: each.role, status: 'active' })) });
    }
    if (path === '/v2/accounts/me' && method === 'PATCH') {
      if (typeof body['firstName'] === 'string') person.firstName = body['firstName'];
      if (typeof body['lastName'] === 'string') person.lastName = body['lastName'];
      return json(200, { id: person.id, email: person.email, firstName: person.firstName, lastName: person.lastName });
    }
    if (path === '/v2/accounts/workspaces' && method === 'POST') {
      const made = { id: id('ws'), name: String(body['name'] ?? ''), role: 'OWNER' };
      person.workspaces.push(made);
      return json(201, { id: made.id, name: made.name, logo: null, state: 'active' });
    }
    if (path === '/v2/accounts/members' && method === 'GET') {
      return workspaceRequired() ?? json(200, [...people.values()].filter((each) => each.workspaces.some((w) => w.id === session.workspace)).map((each) => ({ id: `mem-${each.id}`, user: { id: each.id, email: each.email, firstName: each.firstName, lastName: each.lastName }, role: each.workspaces.find((w) => w.id === session.workspace)?.role, teams: [], status: 'active', customParams: {}, ownerOffered: false, lastSignIn: null, joinedAt: null })));
    }
    if (path === '/v2/identity-access/invites/accept' && method === 'POST') {
      const found = inviteFor(body['token']);
      if (typeof found === 'string') return inviteRefused(found);
      if (found.email !== person.email) return oauth(403, 'invite_for_another_address', { error_description: 'This invite is for another email address.' });
      if (person.workspaces.some((each) => each.id === found.workspace.id)) return oauth(409, 'already_member', { error_description: 'You are a member of this workspace already.' });
      join(person, found);
      return json(200, { workspace: { id: found.workspace.id, name: found.workspace.name }, member: { id: `mem-${person.id}`, role: found.role } });
    }
    const here = () => invites.filter((each) => each.workspace.id === session.workspace);
    if (path === '/v2/accounts/invites' && method === 'GET') return workspaceRequired() ?? json(200, here().filter((each) => each.state === 'open').map(inviteView));
    if (path === '/v2/accounts/invites' && method === 'POST') {
      const required = workspaceRequired();
      if (required !== null) return required;
      const role = String(body['role'] ?? 'MEMBER');
      if (role === 'OWNER') return problem(409, 'granting-owner', 'Invite people with another role; an Owner then offers them the Owner role.');
      const email = String(body['email']).toLowerCase();
      if ([...people.values()].some((each) => each.email === email && each.workspaces.some((w) => w.id === session.workspace))) return problem(409, 'invites', 'This person is a member already.');
      const membership = person.workspaces.find((each) => each.id === session.workspace) as { id: string; name: string };
      return json(201, inviteView(makeInvite(email, { id: membership.id, name: membership.name }, role, person.id)));
    }
    const inviteMatch = path.match(/^\/v2\/accounts\/invites\/([^/]+)$/);
    if (inviteMatch !== null && method === 'DELETE') {
      const found = here().find((each) => each.id === inviteMatch[1] && each.state === 'open');
      if (found === undefined) return problem(404, 'not-found', '');
      found.state = 'revoked';
      return json(200, { revoked: true });
    }
    if (path === '/v2/accounts/roles' && method === 'GET') return json(200, [{ key: 'OWNER', name: 'Owner', privileges: [] }, { key: 'MEMBER', name: 'Member', privileges: [] }].filter((role) => url.searchParams.get('assignable') !== 'true' || role.key !== 'OWNER'));

    if (path === '/v2/flags/ofrep/v1/evaluate/flags' && method === 'POST') {
      const etag = `"r${String(flagsRevision)}:${person.id}:${session.workspace ?? ''}"`;
      if (headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return json(200, { flags: flagResults }, { etag });
    }

    if (path === '/v2/billing/plans' && method === 'GET') return json(200, plans);
    if (path === '/v2/billing/payer' && method === 'GET') return workspaceRequired() ?? json(200, facts);
    if (path === '/v2/billing/payer/usage' && method === 'GET') return json(200, { periodStart: new Date(now()).toISOString(), periodEnd: new Date(now() + 30 * 86_400_000).toISOString(), metrics: [] });
    if (path === '/v2/billing/payer/plan' && method === 'POST') {
      const plan = plans.find((each) => each['key'] === body['plan']);
      if (plan === undefined) return problem(400, 'bad-request', 'No such plan.');
      if (plan['free'] === true) {
        facts = { ...facts, plan: { key: plan['key'], name: plan['name'] }, status: 'active', access: 'ok' };
        return json(200, { status: 'changed' });
      }
      const checkout = `cs_${secret()}`;
      checkouts.add(checkout);
      facts = { ...facts, waiting: { plan: plan['key'], waitsFor: 'payment', at: null } };
      return json(200, { status: 'payment_required', checkout: { session: checkout, url: `https://checkout.bridge.test/${checkout}` } });
    }
    const confirm = path.match(/^\/v2\/billing\/payer\/checkouts\/([^/]+)\/confirm$/);
    if (confirm !== null && method === 'POST') {
      if (!checkouts.has(confirm[1] as string)) return problem(404, 'not-found', '');
      const waiting = facts['waiting'] as { plan: string } | null;
      const plan = plans.find((each) => each['key'] === waiting?.plan);
      facts = { ...facts, plan: plan === undefined ? null : { key: plan['key'], name: plan['name'] }, status: 'active', access: 'ok', waiting: null };
      return json(200, facts);
    }
    if (path === '/v2/billing/payer/portal' && method === 'GET') return json(200, { url: 'https://portal.bridge.test/session' });

    if (path === '/v2/live/channels' && method === 'GET') return json(200, { channels: channelsFor(who) });
    if (path === '/v2/live/history' && method === 'GET') return json(200, historyFrom(url.searchParams.get('cursor') ?? ''));

    return problem(404, 'not-found', 'No such route.');
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.text();
    let body: Record<string, unknown> = {};
    try {
      body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return problem(400, 'bad-request', 'The body is not JSON.');
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    requests.push({ method: request.method, path: url.pathname + url.search, headers, body: raw === '' ? undefined : body });
    return handle(request.method, url, request.headers, body);
  }) as typeof fetch;

  function addPerson(person: { email: string; password: string; firstName?: string | null; lastName?: string | null; workspaces?: { id: string; name: string; role?: string }[] }): FakePerson {
    const made: FakePerson = {
      id: id('usr'),
      email: person.email.toLowerCase(),
      password: person.password,
      firstName: person.firstName ?? null,
      lastName: person.lastName ?? null,
      workspaces: (person.workspaces ?? []).map((each) => ({ id: each.id, name: each.name, role: each.role ?? 'MEMBER' })),
    };
    people.set(made.id, made);
    return made;
  }

  /** Makes a socket factory that speaks Live's socket protocol and delivers what `publish` sends. */
  const websocket = (url: string, protocols: string[]): FakeSocket => {
    const socket: FakeSocket = {
      url,
      protocols,
      sent: [],
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        const message = JSON.parse(data) as { type: string; id?: string; channel?: string; authorization?: { Authorization?: string } };
        socket.sent.push(message);
        const reply = (value: unknown) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(value) }));
        if (message.type === 'connection_init') reply({ type: 'connection_ack', connectionTimeoutMs: 300_000 });
        if (message.type === 'subscribe' && message.id !== undefined && message.channel !== undefined) {
          const token = message.authorization?.Authorization?.replace(/^Bearer /, '') ?? '';
          const who = token === 'anonymous' ? null : personOf(new Headers({ authorization: `Bearer ${token}` }));
          if (!channelsFor(who).some((channel) => channel.name === message.channel)) {
            reply({ type: 'subscribe_error', id: message.id, errors: [{ errorType: 'UnauthorizedException' }] });
            return;
          }
          const map = live.subscribed.get(socket) ?? new Map<string, string>();
          map.set(message.channel, message.id);
          live.subscribed.set(socket, map);
          reply({ type: 'subscribe_success', id: message.id });
        }
      },
      close() {
        live.sockets.splice(live.sockets.indexOf(socket), 1);
        live.subscribed.delete(socket);
        queueMicrotask(() => socket.onclose?.());
      },
    };
    live.sockets.push(socket);
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };

  return {
    issuer,
    appId,
    fetch: fakeFetch,
    websocket,
    requests,
    addPerson,
    /** The person, by email. */
    person: (email: string) => [...people.values()].find((each) => each.email === email.toLowerCase()),
    /**
     * The last email link sent to an address for a purpose (`verify-sign-up`,
     * `reset-password`, `invite-new`, `invite-existing`; `invite` for either
     * invite), or null.
     */
    lastLink(to: string, purpose: string): string | null {
      const matches = (sent: string) => sent === purpose || (purpose === 'invite' && sent.startsWith('invite-'));
      return [...sentLinks].reverse().find((each) => each.to === to.toLowerCase() && matches(each.purpose))?.token ?? null;
    },
    /**
     * Invites an address into a workspace, as a member who may invite would,
     * and returns the link's token. Sending again to the same address gives a
     * new token, and the old one stops working.
     */
    invite(email: string, workspace: { id: string; name: string }, role = 'MEMBER'): string {
      return makeInvite(email, workspace, role, null).token;
    },
    /** The invites, as the workspace's list shows them, with every state. */
    invites: () => invites.map(inviteView),
    /** Makes an address's invites out of date, as if their 30 days had passed. */
    expireInvites(email: string): void {
      for (const each of invites) if (each.email === email.toLowerCase()) each.expiresAt = new Date(now() - 1000).toISOString();
    },
    sentLinks,
    /** Sets the signed-in results of every flag: `{ key: value }` or full OFREP results. */
    setFlags(results: Record<string, unknown>, visitor: Record<string, unknown> = {}): void {
      const shape = (entries: Record<string, unknown>) => Object.entries(entries).map(([key, value]) => (value !== null && typeof value === 'object' && 'reason' in (value as object) ? { key, ...(value as object) } : { key, value, reason: 'TARGETING_MATCH', variant: String(value), metadata: {} }));
      flagResults = shape(results);
      visitorFlags = shape(visitor);
      flagsRevision += 1;
    },
    setPlans(given: Record<string, unknown>[]): void {
      plans = given;
    },
    setFacts(given: Record<string, unknown>): void {
      facts = { ...facts, ...given };
    },
    usage,
    /** Ends a session as Bridge would: its refresh tokens stop working at once. */
    endSession,
    sessions: () => [...sessions.values()],
    /** Turns the Live connection endpoint off, as an issuer that does not offer it yet. */
    withoutLiveConnection(): void {
      live.offered = false;
    },
    /** Sends a notice on a channel, by its name: to every socket that joined it, and into its history. */
    publish(channel: string, notice: { type: string; record?: string | null; workspace?: string | null }): void {
      const frames = live.history.get(channel) ?? [];
      const seq = (frames.at(-1)?.seq ?? 0) + 1;
      const frame: LiveFrame = { seq, cursor: `${channel}#${String(seq)}`, notice: { type: notice.type, record: notice.record ?? null, version: null, time: new Date(now()).toISOString(), workspace: notice.workspace ?? null } };
      frames.push(frame);
      live.history.set(channel, frames);
      for (const [socket, map] of live.subscribed) {
        const subscription = map.get(channel);
        if (subscription !== undefined) queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'data', id: subscription, event: [JSON.stringify(frame)] }) }));
      }
    },
    /** Puts a notice into a channel's history without sending it, as if the socket missed it. */
    publishSilently(channel: string, notice: { type: string }): void {
      const frames = live.history.get(channel) ?? [];
      const seq = (frames.at(-1)?.seq ?? 0) + 1;
      frames.push({ seq, cursor: `${channel}#${String(seq)}`, notice: { type: notice.type, record: null, version: null, time: new Date(now()).toISOString(), workspace: null } });
      live.history.set(channel, frames);
    },
    /** Makes the next history read of a channel answer that it cannot fill the gap. */
    loseHistory(channel: string): void {
      live.lost.add(channel);
    },
    sockets: live.sockets,
  };
}

export type FakeIssuer = ReturnType<typeof createFakeIssuer>;

/**
 * A stand-in for the browser's passkey dialog, for tests: pass it as
 * `webauthn` to `createBridge`. It makes a passkey on `create` and answers
 * `get` with the newest one it made (or the one `use` picked), the way a
 * person picking their passkey would. `cancelNext()` makes the next
 * ceremony fail as a closed dialog does. It signs nothing: use it with the
 * fake issuer, never against Bridge.
 */
export function fakeWebAuthn(options: { supported?: boolean; autofill?: boolean } = {}) {
  const made: string[] = [];
  let picked: string | null = null;
  let cancel = false;
  const client = (type: string, challenge: unknown) => base64url(JSON.stringify({ type, challenge, origin: 'http://localhost' }));
  const refuseIfCancelled = () => {
    if (!cancel) return;
    cancel = false;
    throw Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
  };
  return {
    made,
    supported: () => options.supported ?? true,
    autofillSupported: () => Promise.resolve(options.autofill ?? true),
    create(given: Record<string, unknown>): Promise<Record<string, unknown>> {
      refuseIfCancelled();
      const id = secret();
      made.push(id);
      return Promise.resolve({ id, rawId: id, type: 'public-key', response: { clientDataJSON: client('webauthn.create', given['challenge']), attestationObject: 'fake' }, clientExtensionResults: {} });
    },
    get(given: Record<string, unknown>): Promise<Record<string, unknown>> {
      refuseIfCancelled();
      const id = picked ?? made.at(-1);
      if (id === undefined) return Promise.reject(Object.assign(new Error('No passkey on this device.'), { name: 'NotAllowedError' }));
      return Promise.resolve({ id, rawId: id, type: 'public-key', response: { clientDataJSON: client('webauthn.get', given['challenge']), authenticatorData: 'fake', signature: 'fake' }, clientExtensionResults: {} });
    },
    cancel(): void {},
    /** The next ceremony fails as if the person closed the dialog. */
    cancelNext(): void {
      cancel = true;
    },
    /** Answers sign-ins with this passkey (a credential id from `made`), as a person picking it would. */
    use(id: string): void {
      picked = id;
    },
  };
}
