/**
 * Every Bridge endpoint this SDK calls, in one table.
 *
 * A route names one of the issuer's published endpoints (`at`, a key of
 * `bridge_endpoints["2"]` in the issuer's metadata) and what goes after it.
 * The SDK never builds an address from a base URL and an app id: the issuer
 * says where each endpoint is, and the SDK appends only the route's own path.
 *
 * `contract` is the same route as Bridge's API contract writes it, for the
 * contract test, which checks that every route here is one Bridge promises
 * at version 2. A route marked `pending` is one Bridge does not serve yet;
 * the SDK refuses it with `not-offered` until the issuer lists it.
 */

/** The version of Bridge's public API this SDK speaks. Every call is pinned to it. */
export const API_VERSION = '2';

/** The issuer's published endpoints, as `bridge_endpoints["2"]` names them. */
export type EndpointName =
  | 'sign_in'
  | 'token'
  | 'revoke'
  | 'introspect'
  | 'jwks'
  | 'sign_up'
  | 'sign_up_verify'
  | 'password_forgot'
  | 'password'
  | 'sign_out'
  | 'sessions'
  | 'sign_in_options'
  | 'sign_in_requests'
  | 'magic_link'
  | 'magic_link_verify'
  | 'passkey_sign_in_options'
  | 'passkey_sign_in'
  | 'passkey_setup_link'
  | 'passkey_setup_options'
  | 'passkey_setup'
  | 'passkeys'
  | 'invites'
  | 'invite_preview'
  | 'accounts'
  | 'billing'
  | 'flags'
  | 'flags_visitor'
  | 'live'
  | 'live_visitor'
  | 'live_connection'
  | 'events_and_logs';

/** Where each endpoint is in Bridge's API contract. */
export const CONTRACT_PATHS: Readonly<Record<EndpointName, string>> = {
  sign_in: '/v2/identity-access/apps/{appId}/sign-in',
  token: '/v2/identity-access/apps/{appId}/token',
  revoke: '/v2/identity-access/apps/{appId}/revoke',
  introspect: '/v2/identity-access/apps/{appId}/introspect',
  jwks: '/v2/identity-access/apps/{appId}/jwks.json',
  sign_up: '/v2/identity-access/apps/{appId}/sign-up',
  sign_up_verify: '/v2/identity-access/apps/{appId}/sign-up/verify',
  password_forgot: '/v2/identity-access/apps/{appId}/password/forgot',
  password: '/v2/identity-access/apps/{appId}/password',
  sign_out: '/v2/identity-access/sign-out',
  sessions: '/v2/identity-access/sessions',
  sign_in_options: '/v2/identity-access/apps/{appId}/sign-in-options',
  sign_in_requests: '/v2/identity-access/apps/{appId}/sign-in-requests',
  magic_link: '/v2/identity-access/apps/{appId}/magic-link',
  magic_link_verify: '/v2/identity-access/apps/{appId}/magic-link/verify',
  passkey_sign_in_options: '/v2/identity-access/apps/{appId}/passkeys/sign-in/options',
  passkey_sign_in: '/v2/identity-access/apps/{appId}/passkeys/sign-in',
  passkey_setup_link: '/v2/identity-access/apps/{appId}/passkeys/setup-link',
  passkey_setup_options: '/v2/identity-access/apps/{appId}/passkeys/setup/options',
  passkey_setup: '/v2/identity-access/apps/{appId}/passkeys/setup',
  passkeys: '/v2/identity-access/passkeys',
  invites: '/v2/identity-access/invites',
  invite_preview: '/v2/identity-access/apps/{appId}/invites/preview',
  accounts: '/v2/accounts',
  billing: '/v2/billing',
  flags: '/v2/flags',
  flags_visitor: '/v2/flags/apps/{appId}',
  live: '/v2/live',
  live_visitor: '/v2/live/apps/{appId}',
  live_connection: '/v2/live/apps/{appId}/connection',
  events_and_logs: '/v2/events-and-logs',
};

export interface Route {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly at: EndpointName;
  /** What goes after the endpoint's address, with `{name}` for each parameter. */
  readonly path: string;
  /** Set while Bridge does not serve this route yet: what it is waiting for. */
  readonly pending?: string;
}

function route(method: Route['method'], at: EndpointName, path = '', pending?: string): Route {
  return pending === undefined ? { method, at, path } : { method, at, path, pending };
}

export const ROUTES = {
  // Identity and Access: before a token.
  signIn: route('POST', 'sign_in'),
  token: route('POST', 'token'),
  revoke: route('POST', 'revoke'),
  introspect: route('POST', 'introspect'),
  jwks: route('GET', 'jwks'),
  signUp: route('POST', 'sign_up'),
  signUpVerify: route('POST', 'sign_up_verify'),
  passwordForgot: route('POST', 'password_forgot'),
  passwordSet: route('POST', 'password'),
  signInOptions: route('GET', 'sign_in_options'),
  signInRequest: route('POST', 'sign_in_requests'),
  magicLink: route('POST', 'magic_link'),
  magicLinkVerify: route('POST', 'magic_link_verify'),
  passkeySignInOptions: route('POST', 'passkey_sign_in_options'),
  passkeySignIn: route('POST', 'passkey_sign_in'),
  passkeySetupLink: route('POST', 'passkey_setup_link'),
  passkeySetupOptions: route('POST', 'passkey_setup_options'),
  passkeySetup: route('POST', 'passkey_setup'),
  invitePreview: route('POST', 'invite_preview'),

  // Identity and Access: the signed-in person accepts an invite.
  inviteAccept: route('POST', 'invites', '/accept'),

  // Identity and Access: the signed-in person.
  signOut: route('POST', 'sign_out'),
  sessions: route('GET', 'sessions'),
  sessionEnd: route('DELETE', 'sessions', '/{sessionId}'),
  passkeys: route('GET', 'passkeys'),
  passkeyOptions: route('POST', 'passkeys', '/options'),
  passkeyAdd: route('POST', 'passkeys'),
  passkeyRemove: route('DELETE', 'passkeys', '/{passkeyId}'),

  // Accounts.
  me: route('GET', 'accounts', '/me'),
  meUpdate: route('PATCH', 'accounts', '/me'),
  workspaces: route('GET', 'accounts', '/workspaces'),
  workspaceCreate: route('POST', 'accounts', '/workspaces'),
  workspace: route('GET', 'accounts', '/workspace'),
  workspaceUpdate: route('PATCH', 'accounts', '/workspace'),
  members: route('GET', 'accounts', '/members'),
  member: route('GET', 'accounts', '/members/{memberId}'),
  memberUpdate: route('PATCH', 'accounts', '/members/{memberId}'),
  memberRemove: route('DELETE', 'accounts', '/members/{memberId}'),
  memberDeletionPreview: route('GET', 'accounts', '/members/{memberId}/deletion-preview'),
  invites: route('GET', 'accounts', '/invites'),
  inviteCreate: route('POST', 'accounts', '/invites'),
  inviteRevoke: route('DELETE', 'accounts', '/invites/{inviteId}'),
  roles: route('GET', 'accounts', '/roles'),

  // Billing: the payer, the signed-in person's workspace.
  plans: route('GET', 'billing', '/plans'),
  payer: route('GET', 'billing', '/payer'),
  payerUsage: route('GET', 'billing', '/payer/usage'),
  payerPlan: route('POST', 'billing', '/payer/plan'),
  payerTrial: route('POST', 'billing', '/payer/trial'),
  payerCancel: route('POST', 'billing', '/payer/cancel'),
  payerReactivate: route('POST', 'billing', '/payer/reactivate'),
  payerRefresh: route('POST', 'billing', '/payer/refresh'),
  checkoutConfirm: route('POST', 'billing', '/payer/checkouts/{session}/confirm'),
  portal: route('GET', 'billing', '/payer/portal'),
  // The app's server: "count this".
  usageReport: route('POST', 'billing', '/usage'),

  // Flags, over OFREP: results only, never rules.
  flagsEvaluate: route('POST', 'flags', '/ofrep/v1/evaluate/flags'),
  flagEvaluate: route('POST', 'flags', '/ofrep/v1/evaluate/flags/{key}'),
  flagsVisitorEvaluate: route('POST', 'flags_visitor', '/ofrep/v1/evaluate/flags'),

  // Live.
  liveChannels: route('GET', 'live', '/channels'),
  liveHistory: route('GET', 'live', '/history'),
  liveVisitorChannels: route('GET', 'live_visitor', '/channels'),
  liveVisitorHistory: route('GET', 'live_visitor', '/history'),
  liveConnection: route('GET', 'live_connection'),
} as const satisfies Readonly<Record<string, Route>>;

export type RouteName = keyof typeof ROUTES;

/** The revocation list's lanes a server follows, each served by its own part of Bridge. */
export const REVOCATION_LANES = ['identity-access', 'accounts', 'billing', 'app-registry'] as const;
export type RevocationLane = (typeof REVOCATION_LANES)[number];

/** Each lane as Bridge's API contract writes it. */
export const LANE_CONTRACT_PATHS: Readonly<Record<RevocationLane, string>> = {
  'identity-access': '/v2/identity-access/apps/{appId}/revocations/{lane}',
  accounts: '/v2/accounts/apps/{appId}/revocations/{lane}',
  billing: '/v2/billing/apps/{appId}/revocations/{lane}',
  'app-registry': '/v2/app-registry/apps/{appId}/revocations/{lane}',
};

/** Fills a route's `{name}` parameters, each encoded. */
export function fillPath(path: string, params: Readonly<Record<string, string>> = {}): string {
  return path.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new TypeError(`The route needs "${name}".`);
    return encodeURIComponent(value);
  });
}
