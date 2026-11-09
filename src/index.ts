/**
 * @nebulr-group/bridge-auth-core
 *
 * The Bridge client for the browser (and any JavaScript runtime): sign-in in
 * the Child App's own pages, the session and its tokens, accounts and the
 * team, flag results, billing and Live updates. It needs one setting, the
 * issuer, and reads everything else from the issuer's metadata.
 *
 * Framework plugins build on `createBridge`. Servers use
 * `@nebulr-group/bridge-auth-core/server`.
 */
import { registerInstance } from './instance-guard.js';

registerInstance();

export { createBridge } from './bridge.js';
export type { Bridge, BridgeEvents, BridgeOptions } from './bridge.js';

export { BridgeError, isBridgeError } from './core/errors.js';
export type { BridgeErrorKind, Problem } from './core/errors.js';
export { API_VERSION } from './core/routes.js';
export type { IssuerMetadata } from './core/discovery.js';
export { localStorageAdapter, memoryStorage } from './core/storage.js';
export type { BridgeStorage } from './core/storage.js';
export type { Readable } from './core/util.js';

export type { SessionState, SessionUser, SessionWorkspace, SignedInState, SignedOutReason } from './session.js';
export { readEmailLink, takeEmailLink } from './sign-in.js';
export type { AcceptedInvite, EmailLink, EmailLinkWindow, HandoffInput, HandoffStep, InvitePreview, InviteSignUpInput, SignInInput, SignInOptions, SignInStep, SignUpInput, WorkspaceChoice } from './sign-in.js';
export { HANDOFF_CALLBACK_PATH, handoffReturnUrl, isLoopbackRedirect, readHandoffRequest } from './handoff.js';
export type { HandoffRequest } from './handoff.js';

export type { Invite, Me, MeUpdate, Member, MemberUpdate, MyWorkspace, Page, Role, Workspace, WorkspaceUpdate } from './accounts.js';
export { FlagSet, STANDARD_FLAGS } from './flags.js';
export type { FlagReason, FlagResult, FlagsStatus, Hint } from './flags.js';
export { billingNotice, readCheckoutReturn } from './billing.js';
export type { BillingAccess, BillingFacts, BillingNotice, BillingStatus, Plan, PlanChange, Price, UsageNumbers } from './billing.js';
export { MANY_CHANGED } from './live.js';
export type { LiveNotice, LiveOptions, LiveStatus, WebSocketFactory, WebSocketLike } from './live.js';

export { DEFAULT_RETURN_TO_PARAM, readReturnTo, sanitizeReturnTo, stashReturnTo, takeReturnTo, withReturnTo } from './return-to.js';
export { createTranslator, hasLocale, interpolate, normalizeLocale } from './i18n/index.js';
export type { MessageKey, MessageOverrides, Messages, Translator } from './i18n/index.js';
