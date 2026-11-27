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
  password: string | null;
  firstName: string | null;
  lastName: string | null;
  readonly workspaces: { id: string; name: string; role: string; mfa?: boolean }[];
  /** The phone number the text-message second step goes to; none until set up. */
  phone?: string | null;
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
  /**
   * An app in production whose sign-in request returns to the person's own machine (localhost): the answer carries
   * `confirm_return: true`, so the page asks for a click before going back. @default false
   */
  readonly confirmReturn?: boolean;
  /**
   * The app's own sign-in page. Set, the passkey options asked for from Bridge's hosted page (an `Origin` that is the
   * metadata's `sign_in_page`) are refused with 409 `passkey_on_app_page` and this address. @default none
   */
  readonly passkeysBelongTo?: string;
  /** When a passkey is offered, as the app's settings say it: after a sign-in another way, and made automatically. @default both on */
  readonly passkeyOffer?: { readonly afterSignIn: boolean; readonly automatic: boolean };
  /**
   * Routes that want a recent sign-in, as `"METHOD /v2/path"`: called with a
   * token whose sign-in is older than `maxAgeSeconds` they answer 401
   * `identity-recheck`, as Bridge's do. See `signedInLongAgo`. @default none
   */
  readonly recheck?: { readonly routes: readonly string[]; readonly maxAgeSeconds?: number };
  /** The social providers the app offers (`google`, `github`, …), as its sign-in options list them. @default none */
  readonly social?: readonly string[];
  /**
   * Whether the app offers the text-message second step: a workspace with `mfa: true` then asks for a code after the
   * sign-in, sent to the person's phone (`lastText`), or a number to set up first. @default true
   */
  readonly secondStep?: boolean;
  /**
   * Where the app's users sign in, as its sign-in options publish it: `{ location, main, path, emailLinks,
   * url, signedOutUrl }`. @default none (an app from before the setting)
   */
  readonly signIn?: Readonly<Record<string, unknown>>;
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
  /** When the person last signed in or confirmed it is them, in ms: the tokens' `auth_time`. */
  authTime: number;
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
  const accessTokens = new Map<string, { session: string; user: string; workspace: string | null; exp: number; authTime: number; refused?: true }>();
  /** Per session, the latest sign-in time (ms, in whole seconds) one of its tokens carried. */
  const claimedAuthTimes = new Map<string, number>();
  /**
   * The sign-in time a confirmation gives the session: now, and always later
   * than any sign-in time its tokens carried. On Bridge the refusal itself
   * means the sign-in is old; here `signedInLongAgo` makes it old without
   * changing the time the tokens already given carry, so a confirmation within
   * the same second as the sign-in would otherwise not look like a renewal.
   */
  const confirmedAuthTime = (session: string) => Math.max(now(), (claimedAuthTimes.get(session) ?? -Infinity) + 1000);
  const refreshTokens = new Map<string, { session: string; rotatedAt: number | null }>();
  // Tokens given before this time are refused too: a lock's revocation entry takes effect a little after it is written.
  let refuseGivenBefore = 0;
  const codes = new Map<string, Code>();
  const flows = new Map<string, { user: string; challenge: string; request?: SignInRequest }>();
  const socialStates = new Map<string, { provider: string; intent: string; challenge: string; returnPage: string; request?: SignInRequest; used: boolean }>();
  /** Links waiting for their person: the handle, the address's person (null for an address with none), the provider and the device's challenge. */
  const waitingLinks = new Map<string, { person: string | null; provider: string; challenge: string; used: boolean }>();
  /** The providers linked to each person by a waiting link. */
  const linked = new Map<string, string[]>();
  const socialCodes = new Map<string, { email: string; verified: boolean; unconfirmed: boolean; state: string }>();
  const secondSteps = new Map<string, { user: string; challenge: string; workspace: string; request?: SignInRequest; code: string | null; tries: number; settingUp: string | null }>();
  const sentTexts: { to: string; code: string }[] = [];
  const social = options.social ?? [];
  const returns = options.returns ?? [];
  const signInRequests = new Map<string, SignInRequest>();
  const methods = options.methods ?? ['password', 'magicLink'];
  const recentOnly = new Set(options.recheck?.routes ?? []);
  const recentMs = (options.recheck?.maxAgeSeconds ?? 300) * 1000;
  // Passkeys: each ceremony's challenge, used once; each registered passkey, by its credential id.
  const passkeyChallenges = new Map<string, { purpose: 'sign-in' | 'register' | 'recheck'; pkce?: string; email?: string | null; user?: string; link?: string; request?: SignInRequest }>();
  const passkeys = new Map<string, { id: string; user: string; name: string; createdAt: string; lastUsedAt: string | null; usable?: boolean }>();
  // The passkey offer's answers, per person: Not now until a time, or Don't ask again.
  const passkeyOffer = options.passkeyOffer ?? { afterSignIn: true, automatic: true };
  const offerAnswers = new Map<string, { until: number; never: boolean }>();
  const offerFor = (user: string) => {
    const answered = offerAnswers.get(user);
    if (!methods.includes('passkeys') || [...passkeys.values()].some((each) => each.user === user) || answered?.never === true) return { offer: false, automatic: false };
    return { offer: passkeyOffer.afterSignIn && (answered === undefined || answered.until <= now()), automatic: passkeyOffer.automatic };
  };
  const links = new Map<string, { purpose: 'sign-up' | 'reset' | 'magic-link' | 'passkey-setup' | 'recheck'; email: string; afterReset?: boolean; session?: string; challenge?: string; request?: SignInRequest; expiresAt?: number; signUp?: { password: string; firstName: string | null; lastName: string | null; workspace: string | boolean | null } }>();
  /** People whose password breaks the app's rules since it went to production, and which rules. */
  const mustChange = new Map<string, readonly string[]>();
  const sentLinks: { to: string; purpose: string; token: string }[] = [];
  const requests: RecordedRequest[] = [];
  const invites: FakeInvite[] = [];
  const usage: unknown[] = [];
  /** What the quota read answers for each metric: a snapshot, or null for a metric the plan sets no limit on. */
  const quotas = new Map<string, object | null>();
  const quotaReads: string[] = [];
  let flagResults: Record<string, unknown>[] = [];
  let flagsRevision = 1;
  let visitorFlags: Record<string, unknown>[] = [];
  const forcedAnswers = new Map<string, { status: number; body: unknown }>();
  const planChoices: { plan: string; returnUrl: string | null }[] = [];
  const portalReturns: (string | null)[] = [];
  let checkoutOrigins: string[] | null = null;
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
          account_password: `${v2}/identity-access/password`,
          social_start: `${at}/social/start`,
          social_finish: `${at}/social/finish`,
          social_link: `${v2}/identity-access/social/link`,
          second_step: `${at}/second-step`,
          recheck: `${v2}/identity-access/recheck`,
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
    const claimed = Math.floor(session.authTime / 1000) * 1000;
    claimedAuthTimes.set(session.id, Math.max(claimedAuthTimes.get(session.id) ?? -Infinity, claimed));
    const access = fakeJwt('at+jwt', {
      iss: issuer, aud: `${origin}/api`, sub: person.id, aid: appId, sid: session.id, jti: secret(), exp, auth_time: Math.floor(session.authTime / 1000),
      ...(membership === null ? {} : { tid: membership.id, wst: 'active' }),
      email: person.email, email_verified: true,
    });
    accessTokens.set(access, { session: session.id, user: person.id, workspace: session.workspace, exp: exp * 1000, authTime: session.authTime, ...(now() < refuseGivenBefore ? { refused: true as const } : {}) });
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

  /** Sends a new code to the second step's number, as Bridge's text message does. */
  function textCode(handle: string, phone: string): Response {
    const step = secondSteps.get(handle);
    if (step === undefined) return oauth(400, 'flow_expired');
    step.code = String(100000 + Math.floor(Math.random() * 900000));
    step.tries = 0;
    sentTexts.push({ to: phone, code: step.code });
    return json(200, { next: 'second_step', flow: handle, phone: `${phone.slice(0, 3)} •••• ${phone.slice(-2)}`, sent: true });
  }

  function toWorkspace(person: FakePerson, challenge: string, requested: string | null, request?: SignInRequest, sms = false): Response {
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
    // A workspace that requires a second step: a code by text message first, on an app that offers it.
    if (workspace !== null && !sms && person.workspaces.some((each) => each.id === workspace && each.mfa === true)) {
      if (options.secondStep === false) return oauth(403, 'insufficient_user_authentication', { needs: 'second_step' });
      const handle = secret();
      secondSteps.set(handle, { user: person.id, challenge, workspace, ...(request === undefined ? {} : { request }), code: null, tries: 0, settingUp: null });
      if (person.phone == null) return json(200, { next: 'second_step_setup', flow: handle });
      return textCode(handle, person.phone);
    }
    const code = secret();
    if (request !== undefined) {
      codes.set(code, { user: person.id, workspace, challenge: request.challenge, redirectUri: request.redirectUri, used: false, session: null });
      return json(200, { code, redirect_uri: request.redirectUri, state: request.state, ...(options.confirmReturn === true ? { confirm_return: true } : {}) });
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

  function personOf(headers: Headers): { session: Session; person: FakePerson; authTime: number } | null {
    const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const record = accessTokens.get(token);
    if (record === undefined || record.exp <= now() || record.refused === true) return null;
    const session = sessions.get(record.session);
    if (session === undefined || session.ended) return null;
    return { session: { ...session, workspace: record.workspace }, person: people.get(record.user) as FakePerson, authTime: record.authTime };
  }

  const unauthorized = () => problem(401, 'credential-refused', 'The token is not valid.');

  /** A ceremony's options, its challenge kept to be used once. */
  function passkeyOptions(purpose: 'sign-in' | 'register' | 'recheck', record: { pkce?: string; email?: string | null; user?: string; link?: string }): Response {
    const challenge = secret();
    passkeyChallenges.set(challenge, { purpose, ...record });
    if (purpose === 'sign-in') return json(200, { options: { challenge, rpId: 'localhost', userVerification: 'required', timeout: 300_000, allowCredentials: [] } });
    if (purpose === 'recheck') {
      const allowCredentials = [...passkeys.values()].filter((each) => each.user === record.user).map((each) => ({ id: each.id, type: 'public-key' }));
      return json(200, { options: { challenge, rpId: 'localhost', userVerification: 'required', timeout: 300_000, allowCredentials } });
    }
    const person = people.get(record.user as string) as FakePerson;
    const excludeCredentials = [...passkeys.values()].filter((each) => each.user === person.id).map((each) => ({ id: each.id, type: 'public-key' }));
    return json(200, { options: { challenge, rp: { id: 'localhost', name: 'localhost' }, user: { id: base64url(person.id), name: person.email, displayName: person.email }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 300_000, attestation: 'none', excludeCredentials, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } });
  }

  /** Spends the challenge an authenticator's answer signed, once: its record, or null. */
  function spentChallenge(response: unknown, purpose: 'sign-in' | 'register' | 'recheck') {
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
  const passkeyView = (each: { id: string; name: string; createdAt: string; lastUsedAt: string | null; usable?: boolean; user?: string }) => ({ id: each.id, name: each.name, createdAt: each.createdAt, lastUsedAt: each.lastUsedAt, deviceType: 'multiDevice', backedUp: true, aaguid: '00000000-0000-0000-0000-000000000000', authenticator: { name: 'Passkey', icon: null }, credentialId: each.id, rpId: 'localhost', userHandle: base64url(each.user ?? ''), usable: each.usable !== false });

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
        const broken = mustChange.get(person.email);
        if (broken !== undefined) {
          // The password is right, but no longer enough: no code, a link to choose a new one, and the request not spent.
          const token = secret();
          links.set(token, { purpose: 'reset', email: person.email });
          sentLinks.push({ to: person.email, purpose: 'reset-password', token });
          return oauth(403, 'password_change_required', { error_description: "This app's password rules changed and your password no longer meets them. A link to choose a new one was sent to your address.", failed: broken, next: 'reset_password' });
        }
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
      if (route === '/sign-in-options' && method === 'GET') return json(200, { app: { id: appId }, signUp: true, methods, social, ...(methods.includes('password') ? { password: { minLength: 8, maxLength: 128 } } : {}), ...(methods.includes('passkeys') ? { passkeyOffer } : {}), ...(options.signIn === undefined ? {} : { signIn: options.signIn }) });
      if (route === '/social/start') {
        const provider = String(body['provider']);
        if (!social.includes(provider)) return oauth(403, 'method_disabled');
        const request = openRequest(body);
        if (request instanceof Response) return request;
        if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string' || typeof body['return_page'] !== 'string') return oauth(400, 'invalid_request');
        const state = secret();
        socialStates.set(state, { provider, intent: body['intent'] === 'sign-up' ? 'sign-up' : 'sign-in', challenge: body['code_challenge'], returnPage: body['return_page'], ...(request === undefined ? {} : { request }), used: false });
        return json(200, { url: `${origin}/provider/${provider}/authorize?state=${state}` }, { 'cache-control': 'no-store' });
      }
      if (route === '/social/finish') {
        const state = socialStates.get(String(body['state']));
        const said = socialCodes.get(String(body['code']));
        if (state === undefined || state.used || said === undefined || said.state !== String(body['state'])) return oauth(400, 'invalid_link');
        const presented = typeof body['code_verifier'] === 'string' ? await s256(body['code_verifier']) : null;
        if (presented !== state.challenge) return oauth(400, 'wrong_device', { error_description: 'Finish signing in in the browser you started in.' });
        state.used = true;
        if (said.unconfirmed) {
          // A provider that gives an address without saying it confirmed it (Facebook): never linked to an account that holds it, and a
          // sign-up is proved by Bridge's own link first, which only this device's verifier finishes.
          // An address that has an account is never linked: it is answered as a password sign-up answers it (the same step, and the
          // email says the account exists), so nothing tells the page which it is.
          // Link required: either way the answer carries a handle; only one for an address with an account links anything.
          const holder = [...people.values()].find((each) => each.email === said.email) ?? null;
          const link = secret();
          waitingLinks.set(link, { person: holder?.id ?? null, provider: state.provider, challenge: state.challenge, used: false });
          if (holder !== null) {
            sentLinks.push({ to: said.email, purpose: 'account-exists', token: '' });
            return json(202, { next: 'verify_email', email: said.email, link });
          }
          if (state.intent !== 'sign-up') return oauth(400, 'no_account', { error_description: 'There is no account for this address yet. Sign up first.' });
          const token = secret();
          links.set(token, { purpose: 'sign-up', email: said.email, challenge: state.challenge, ...(state.request === undefined ? {} : { request: state.request }), signUp: { password: secret(), firstName: null, lastName: null, workspace: null } });
          sentLinks.push({ to: said.email, purpose: 'verify-sign-up', token });
          return json(202, { next: 'verify_email', email: said.email, link });
        }
        if (!said.verified) return oauth(400, 'email_not_verified', { error_description: "Your account's email address is not verified there." });
        let person = [...people.values()].find((each) => each.email === said.email);
        if (person === undefined) {
          if (state.intent !== 'sign-up') return oauth(400, 'no_account', { error_description: 'There is no account for this address yet. Sign up first.' });
          person = addPerson({ email: said.email, password: secret(), workspaces: [{ id: id('ws'), name: `${said.email}'s workspace`, role: 'OWNER' }] });
        }
        if (state.request !== undefined) state.request.used = true;
        return toWorkspace(person, state.request?.challenge ?? state.challenge, null, state.request);
      }
      if (route.startsWith('/second-step')) {
        const handle = String(body['flow']);
        const step = secondSteps.get(handle);
        if (step === undefined) return oauth(400, 'flow_expired');
        const person = people.get(step.user) as FakePerson;
        if (route === '/second-step/setup') {
          const phone = String(body['phone']).replace(/[\s\-().]/g, '');
          if (!/^\+[1-9]\d{6,14}$/.test(phone)) return oauth(400, 'invalid_phone', { error_description: 'Enter your phone number with its country code, such as +46 70 123 45 67.' });
          step.settingUp = phone;
          return textCode(handle, phone);
        }
        if (route === '/second-step/resend') return textCode(handle, step.settingUp ?? person.phone ?? '');
        if (route === '/second-step/reset') {
          if (body['backup_code'] !== 'BACK-UPCO-DE12') return oauth(400, 'wrong_backup_code', { error_description: 'The backup code is not right.' });
          person.phone = null;
          return json(200, { next: 'second_step_setup', flow: handle });
        }
        if (step.code === null || step.tries >= 5) return oauth(400, 'code_expired', { error_description: 'The code has expired or was tried too many times. Ask for a new one.' });
        step.tries += 1;
        if (body['code'] !== step.code) return oauth(400, 'wrong_code', { error_description: 'The code is not right.', tries_left: 5 - step.tries });
        secondSteps.delete(handle);
        const setUp = step.settingUp !== null;
        if (setUp) person.phone = step.settingUp;
        const answer = toWorkspace(person, step.challenge, step.workspace, step.request, true);
        if (!setUp) return answer;
        return json(answer.status, { ...((await answer.json()) as object), backup_code: 'BACK-UPCO-DE12' });
      }
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
        // A link to confirm it is you: on the device that asked, it renews its session and makes none.
        if (link?.purpose === 'recheck' && (link.expiresAt ?? 0) > now()) {
          const presented = typeof body['code_verifier'] === 'string' ? await s256(body['code_verifier']) : null;
          if (presented !== link.challenge) return oauth(400, 'wrong_device', { error_description: 'Open the link on the device you asked for it on.' });
          links.delete(String(body['token']));
          const renewed = sessions.get(link.session as string);
          if (renewed === undefined || renewed.ended) return oauth(400, 'invalid_link');
          renewed.authTime = confirmedAuthTime(renewed.id);
          return json(200, { rechecked: true }, { 'cache-control': 'no-store' });
        }
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
        if (options.passkeysBelongTo !== undefined && headers.get('origin') === origin) {
          return oauth(409, 'passkey_on_app_page', { error_description: "Passkeys belong to the app's own domain. Continue on the app's sign-in page.", sign_in_url: options.passkeysBelongTo });
        }
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
        // After a reset: one passkey, and nobody signed in.
        if (link.afterReset === true) return json(201, { done: true, passkey: passkeyView({ ...(passkeys.get(kept.id) as { id: string; name: string; createdAt: string; lastUsedAt: string | null }), user: person.id }) });
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
          const session: Session = { id: id('ses'), user: code.user, workspace: code.workspace, ended: false, authTime: now() };
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
        if (typeof body['code_verifier'] !== 'string' || (await s256(body['code_verifier'])) !== link.challenge) return oauth(400, 'wrong_device', { error_description: 'This link finishes the sign-up only in the browser where it was started. Open it there, or sign up again here.' });
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
        mustChange.delete(person.email);
        for (const session of sessions.values()) if (session.user === person.id) endSession(session.id);
        // A reset that named this browser's challenge hands back a pass for one passkey here, when one would be offered.
        if (typeof body['code_challenge'] === 'string' && offerFor(person.id).offer) {
          const pass = secret();
          links.set(pass, { purpose: 'passkey-setup', email: person.email, challenge: body['code_challenge'], expiresAt: now() + 10 * 60 * 1000, afterReset: true });
          return json(200, { done: true, passkeyPass: pass });
        }
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
    if (recentOnly.has(`${method} ${path}`) && now() - who.authTime > recentMs) return problem(401, 'identity-recheck', 'Sign in again to confirm it is you.');
    if (path === '/v2/identity-access/recheck' && method === 'POST') {
      const confirmed = () => {
        const open = sessions.get(session.id);
        if (open !== undefined) open.authTime = confirmedAuthTime(open.id);
        return new Response(null, { status: 204 });
      };
      if (typeof body['password'] === 'string') {
        if (!methods.includes('password')) return oauth(403, 'method_disabled');
        return body['password'] === person.password ? confirmed() : oauth(400, 'wrong_credentials');
      }
      const record = spentChallenge(body['passkey'], 'recheck');
      if (record?.user !== person.id) return oauth(400, 'invalid_challenge', { error_description: 'The passkey request expired or was used already. Start again.' });
      const passkey = passkeys.get(String((body['passkey'] as { id?: unknown } | null)?.id));
      if (passkey?.user !== person.id) return oauth(400, 'unknown_passkey', { error_description: 'This passkey is not registered for the app.' });
      passkey.lastUsedAt = new Date(now()).toISOString();
      return confirmed();
    }
    if (path === '/v2/identity-access/recheck/passkey-options' && method === 'POST') {
      if (!methods.includes('passkeys')) return oauth(403, 'method_disabled');
      if (![...passkeys.values()].some((each) => each.user === person.id)) return oauth(409, 'no_passkey', { error_description: 'You have no passkey for the app yet. Confirm it is you another way.' });
      return passkeyOptions('recheck', { user: person.id });
    }
    if (path === '/v2/identity-access/recheck/email' && method === 'POST') {
      if (!methods.includes('magicLink')) return oauth(403, 'method_disabled');
      if (body['code_challenge_method'] !== 'S256' || typeof body['code_challenge'] !== 'string') return oauth(400, 'invalid_request');
      const token = secret();
      links.set(token, { purpose: 'recheck', email: person.email, challenge: body['code_challenge'], session: session.id, expiresAt: now() + 15 * 60 * 1000 });
      sentLinks.push({ to: person.email, purpose: 'magic-link', token });
      return json(202, { next: 'verify_email' });
    }
    const forced = forcedAnswers.get(path);
    if (forced !== undefined) return json(forced.status, forced.body);
    const workspaceRequired = () => (session.workspace === null ? problem(403, 'workspace-required', 'Choose a workspace first.') : null);

    if (path === '/v2/identity-access/passkeys' && method === 'GET') return json(200, [...passkeys.values()].filter((each) => each.user === person.id).reverse().map(passkeyView));
    if (path === '/v2/identity-access/passkeys/options' && method === 'POST') {
      if (!methods.includes('passkeys')) return oauth(403, 'method_disabled');
      if (body['automatic'] === true && !offerFor(person.id).automatic) return oauth(409, 'no_automatic_passkey');
      return passkeyOptions('register', { user: person.id });
    }
    if (path === '/v2/identity-access/passkeys/offer' && method === 'GET') return json(200, offerFor(person.id));
    if (path === '/v2/identity-access/password' && method === 'GET') {
      const has = [...passkeys.values()].some((each) => each.user === person.id);
      return json(200, person.password === null ? { set: false, removable: false } : has ? { set: true, removable: true } : { set: true, removable: false, why: 'no_passkey' });
    }
    if (path === '/v2/identity-access/password' && method === 'DELETE') {
      if (person.password === null) return oauth(409, 'no_password');
      if (![...passkeys.values()].some((each) => each.user === person.id)) return oauth(409, 'no_passkey', { error_description: 'Add a passkey first.' });
      person.password = null;
      for (const other of sessions.values()) if (other.user === person.id && other.id !== session.id) endSession(other.id);
      return json(200, { done: true });
    }
    if (path === '/v2/identity-access/passkeys/offer' && method === 'POST') {
      if (body['action'] !== 'later' && body['action'] !== 'never') return oauth(400, 'invalid_request');
      offerAnswers.set(person.id, body['action'] === 'never' ? { until: 0, never: true } : { until: now() + 30 * 24 * 3600 * 1000, never: offerAnswers.get(person.id)?.never === true });
      return json(200, { done: true });
    }
    if (path === '/v2/identity-access/passkeys' && method === 'POST') {
      const record = spentChallenge(body['response'], 'register');
      if (record?.user !== person.id || record.link !== undefined) return oauth(400, 'invalid_challenge');
      const kept = keepPasskey(body['response'], person.id, body['name']);
      return kept instanceof Response ? kept : json(201, passkeyView(passkeys.get(kept.id) as { id: string; name: string; createdAt: string; lastUsedAt: string | null }));
    }
    if (path === '/v2/identity-access/social/link' && method === 'POST') {
      const waiting = waitingLinks.get(String(body['link']));
      const presented = typeof body['code_verifier'] === 'string' ? await s256(body['code_verifier']) : null;
      if (waiting === undefined || waiting.used || waiting.person !== person.id || presented !== waiting.challenge) return oauth(400, 'invalid_link', { error_description: 'This link to connect your account has expired or was already used.' });
      waiting.used = true;
      linked.set(person.id, [...(linked.get(person.id) ?? []), waiting.provider]);
      const names: Record<string, string> = { google: 'Google', linkedin: 'LinkedIn', facebook: 'Facebook', github: 'GitHub', azure: 'Microsoft' };
      return json(200, { linked: waiting.provider, name: names[waiting.provider] ?? waiting.provider });
    }
    const passkeyMatch = path.match(/^\/v2\/identity-access\/passkeys\/([^/]+)$/);
    if (passkeyMatch !== null && method === 'PATCH') {
      const found = passkeys.get(decodeURIComponent(passkeyMatch[1] as string));
      if (found?.user !== person.id) return problem(404, 'not-found', '');
      if (typeof body['name'] !== 'string' || body['name'].trim() === '' || body['name'].length > 64) return problem(400, 'invalid', 'name is 1 to 64 characters.');
      found.name = body['name'].trim();
      return json(200, passkeyView(found));
    }
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
    // The lock is read by every person of the workspace, whatever their role: only the gate, nothing of the payment.
    if (path === '/v2/billing/payer/gate' && method === 'GET') {
      const { locked, access, status, cancelAtPeriodEnd, trialEnd, retry } = facts;
      return workspaceRequired() ?? json(200, { locked, access, status, cancelAtPeriodEnd, trialEnd, retry: retry ?? null });
    }
    if (path === '/v2/billing/payer/usage' && method === 'GET') return json(200, { periodStart: new Date(now()).toISOString(), periodEnd: new Date(now() + 30 * 86_400_000).toISOString(), metrics: [] });
    const quotaRead = path.match(/^\/v2\/billing\/usage\/quota\/([^/]+)$/);
    if (quotaRead !== null && method === 'GET') {
      const metric = decodeURIComponent(quotaRead[1]!);
      quotaReads.push(metric);
      return workspaceRequired() ?? json(200, quotas.get(metric) ?? null);
    }
    if (path === '/v2/billing/payer/plan' && method === 'POST') {
      const plan = plans.find((each) => each['key'] === body['plan']);
      if (plan === undefined) return problem(400, 'bad-request', 'No such plan.');
      const returnUrl = typeof body['returnUrl'] === 'string' ? body['returnUrl'] : null;
      planChoices.push({ plan: String(plan['key']), returnUrl });
      const held = facts['plan'] as { key: string } | null;
      const waitingNow = facts['waiting'] as { plan: string; waitsFor: string } | null;
      // The plan the person holds, asked for again while a downgrade waits for the period's end: kept, the change dropped.
      if (held?.key === plan['key'] && waitingNow?.waitsFor === 'period_end' && body['currency'] === undefined && body['interval'] === undefined) {
        facts = { ...facts, waiting: null };
        return json(200, { status: 'changed' });
      }
      if (held?.key === plan['key']) return problem(409, 'conflict', 'The payer is on this plan already.');
      const heldPlan = held === null ? undefined : plans.find((each) => each['key'] === held.key);
      const paying = heldPlan !== undefined && heldPlan['free'] !== true;
      const amountOf = (each: Record<string, unknown>) => ((each['prices'] as { amount: number }[] | undefined)?.[0]?.amount ?? 0);
      const periodEnd = typeof facts['periodEnd'] === 'string' ? (facts['periodEnd'] as string) : new Date(now() + 30 * 86_400_000).toISOString();
      if (paying && (plan['free'] === true || amountOf(plan) < amountOf(heldPlan))) {
        facts = { ...facts, waiting: { plan: plan['key'], waitsFor: 'period_end', at: periodEnd } };
        return json(200, { status: 'scheduled' });
      }
      if (plan['free'] === true) {
        facts = { ...facts, plan: { key: plan['key'], name: plan['name'] }, status: 'active', access: 'ok' };
        return json(200, { status: 'changed' });
      }
      // The payment provider runs the paid subscription: a dearer plan is charged now, and applies once paid.
      if (paying) {
        facts = { ...facts, waiting: { plan: plan['key'], waitsFor: 'payment', at: null } };
        return json(200, { status: 'waiting_for_payment' });
      }
      if (checkoutOrigins !== null) {
        if (returnUrl === null) return problem(409, 'conflict', 'no-return-url: Billing was not told where the payer comes back to after checkout.');
        const origin = (() => { try { return new URL(returnUrl).origin; } catch { return null; } })();
        if (origin === null || !checkoutOrigins.includes(origin)) return problem(409, 'conflict', `return-url-not-registered: ${origin ?? returnUrl} is not one of the app's registered browser origins, so a payer is not sent back to it.`);
      }
      const checkout = `cs_${secret()}`;
      checkouts.add(checkout);
      facts = { ...facts, waiting: { plan: plan['key'], waitsFor: 'payment', at: null } };
      return json(200, { status: 'payment_required', checkout: { session: checkout, url: `https://checkout.bridge.test/${checkout}` } });
    }
    // Bridge reads the subscription from the payment provider again; here the facts are what they are.
    if (path === '/v2/billing/payer/refresh' && method === 'POST') return workspaceRequired() ?? json(200, facts);
    const confirm = path.match(/^\/v2\/billing\/payer\/checkouts\/([^/]+)\/confirm$/);
    if (confirm !== null && method === 'POST') {
      if (!checkouts.has(confirm[1] as string)) return problem(404, 'not-found', '');
      const waiting = facts['waiting'] as { plan: string } | null;
      const plan = plans.find((each) => each['key'] === waiting?.plan);
      facts = { ...facts, plan: plan === undefined ? null : { key: plan['key'], name: plan['name'] }, status: 'active', access: 'ok', waiting: null };
      return json(200, facts);
    }
    if (path === '/v2/billing/payer/portal' && method === 'GET') {
      portalReturns.push(url.searchParams.get('returnUrl'));
      return json(200, { url: 'https://portal.bridge.test/session' });
    }

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

  function addPerson(person: { email: string; password: string; firstName?: string | null; lastName?: string | null; phone?: string | null; workspaces?: { id: string; name: string; role?: string; mfa?: boolean }[] }): FakePerson {
    const made: FakePerson = {
      id: id('usr'),
      email: person.email.toLowerCase(),
      password: person.password,
      firstName: person.firstName ?? null,
      lastName: person.lastName ?? null,
      workspaces: (person.workspaces ?? []).map((each) => ({ id: each.id, name: each.name, role: each.role ?? 'MEMBER', ...(each.mfa === true ? { mfa: true } : {}) })),
      phone: person.phone ?? null,
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
    /**
     * The person at a social provider: answers the provider's address from `social.start` as the provider would after
     * they signed in there, with the fragment the app's page gets back (`#bridge=social&state=…&code=…`).
     */
    /** The providers linked to a person by a waiting link, in order. */
    linkedProviders(email: string): readonly string[] {
      const person = [...people.values()].find((each) => each.email === email.toLowerCase());
      return person === undefined ? [] : (linked.get(person.id) ?? []);
    },
    socialReturn(url: string, person: { email: string; verified?: boolean; unconfirmed?: boolean }): string {
      const state = String(new URL(url).searchParams.get('state'));
      const found = socialStates.get(state);
      if (found === undefined) throw new Error('No social sign-in started with this address.');
      const code = secret();
      socialCodes.set(code, { email: person.email.toLowerCase(), verified: person.verified !== false, unconfirmed: person.unconfirmed === true, state });
      return `${found.returnPage}#${new URLSearchParams({ bridge: 'social', state, code }).toString()}`;
    },
    /** The last second-step code texted to a number, or null. The backup code every setup gives is `BACK-UPCO-DE12`. */
    lastText: (to: string): string | null => [...sentTexts].reverse().find((each) => each.to === to)?.code ?? null,
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
    /**
     * Every session, and every token already given, signed in an hour ago:
     * routes in `recheck` refuse them until the person confirms it is them.
     * The tokens already given keep the sign-in time they carry; a
     * confirmation is always later than it, as it is on Bridge.
     */
    signedInLongAgo(): void {
      const then = now() - 3_600_000;
      for (const each of sessions.values()) each.authTime = then;
      for (const each of accessTokens.values()) each.authTime = then;
    },
    /**
     * Refuses every access token given so far, as Bridge does once a
     * workspace's plan or a person's role changes: calls and joins with one
     * answer 401 until the SDK renews it. Refresh tokens keep working.
     */
    refuseTokensSoFar(): void {
      for (const each of accessTokens.values()) each.refused = true;
    },
    /**
     * Refuses every access token given so far and every one given in the next
     * `ms`, as Bridge does after a lock: its revocation entry covers tokens
     * issued until a little after the lock (for clock skew), so a token
     * renewed at once is refused as well. Refresh tokens keep working.
     */
    refuseTokensFor(ms: number): void {
      for (const each of accessTokens.values()) each.refused = true;
      refuseGivenBefore = now() + ms;
    },
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
    /** Every plan the person chose, with the return address the call carried. */
    planChoices,
    /** The return address each billing portal call carried (null: none). */
    portalReturns,
    /** Makes a checkout need a return address on one of these origins, as Bridge does (`null`: none is checked). */
    requireCheckoutReturnOn(origins: readonly string[] | null): void {
      checkoutOrigins = origins === null ? null : [...origins];
    },
    /** The payment for the plan the person is waiting for goes through: they are on it. */
    settlePayment(): void {
      const waiting = facts['waiting'] as { plan: string } | null;
      const plan = plans.find((each) => each['key'] === waiting?.plan);
      if (plan === undefined) return;
      facts = { ...facts, plan: { key: plan['key'], name: plan['name'] }, status: 'active', access: 'ok', waiting: null };
    },
    /** The payment for the plan the person is waiting for fails: the subscription is past due. */
    failPayment(): void {
      facts = { ...facts, status: 'past_due', access: 'payment_due' };
    },
    /** Answers every call of a path (such as `/v2/billing/payer/plan`) with this status and body, until `null` clears it. */
    answerWith(path: string, status: number | null, body: unknown = {}): void {
      if (status === null) forcedAnswers.delete(path);
      else forcedAnswers.set(path, { status, body });
    },
    usage,
    /** Sets what the quota read answers for a metric (`null`: the plan sets no limit on it). */
    setQuota(metric: string, read: object | null): void {
      quotas.set(metric, read);
    },
    /** The metrics the quota read was asked for, in order. */
    quotaReads,
    /** Ends a session as Bridge would: its refresh tokens stop working at once. */
    endSession,
    /** Marks every passkey made so far as made for another domain than the app's own: the list says `usable: false`. */
    retirePasskeys(): void {
      for (const passkey of passkeys.values()) passkey.usable = false;
    },
    /** From now on a person's password is refused as breaking the app's rules: 403 `password_change_required`, with a link sent. */
    requirePasswordChange(email: string, failed: readonly string[] = ['minLength']): void {
      mustChange.set(email.toLowerCase(), failed);
    },
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
    /** Sends something on a channel that is not a notice this SDK can read (a newer shape, or garbage), as a newer Bridge might. */
    sendUnreadable(channel: string, event: unknown): void {
      for (const [socket, map] of live.subscribed) {
        const subscription = map.get(channel);
        if (subscription !== undefined) queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'data', id: subscription, event: [typeof event === 'string' ? event : JSON.stringify(event)] }) }));
      }
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
export function fakeWebAuthn(options: { supported?: boolean; autofill?: boolean; automatic?: boolean } = {}) {
  /** How each passkey was made: `true` for one the browser made on its own (conditional create). */
  const automaticallyMade: boolean[] = [];
  const made: string[] = [];
  /** What the page told the browser through the Signal API, in order. */
  const signals: { kind: 'unknown' | 'accepted' | 'details'; rpId: string; credentialId?: string; userId?: string; ids?: readonly string[]; name?: string; displayName?: string }[] = [];
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
    signals,
    signal: {
      unknownCredential: (rpId: string, credentialId: string) => Promise.resolve(void signals.push({ kind: 'unknown', rpId, credentialId })),
      allAcceptedCredentials: (rpId: string, userId: string, ids: readonly string[]) => Promise.resolve(void signals.push({ kind: 'accepted', rpId, userId, ids: [...ids] })),
      currentUserDetails: (rpId: string, userId: string, name: string, displayName: string) => Promise.resolve(void signals.push({ kind: 'details', rpId, userId, name, displayName })),
    },
    supported: () => options.supported ?? true,
    autofillSupported: () => Promise.resolve(options.autofill ?? true),
    automaticSupported: () => Promise.resolve(options.automatic ?? false),
    automaticallyMade,
    create(given: Record<string, unknown>, automatic = false): Promise<Record<string, unknown>> {
      refuseIfCancelled();
      const id = secret();
      made.push(id);
      automaticallyMade.push(automatic);
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
