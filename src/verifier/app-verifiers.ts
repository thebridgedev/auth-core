import { decodeJwt, type JSONWebKeySet } from 'jose';
import type { Actor } from './actor.js';
import { createIntrospectionClient, type IntrospectionResult } from './key-introspection.js';
import { KEY_SET_NOT_FOUND, createKeySet, type KeySet } from './key-set.js';
import { CredentialRefusedError, refuse, type Refusal } from './refusal.js';
import { readCredentials, type Credential, type HeadersLike } from './request.js';
import { createRevocationPuller, type RevocationListStatus, type RevocationPuller, type RevocationPullerOptions } from './revocation-puller.js';
import type { RevocationCheck, RevocationVerdict } from './revocation.js';
import { checkKeyAnswer, checkToken, isCompactJws, type AppRules, type Verification } from './verifier.js';

/**
 * A verifier for a server that serves many apps.
 *
 * The one-app verifier (`createCredentialVerifier`) is set up for one app.
 * A server that serves many apps cannot set one up per app in advance, and
 * must not let a credential make it do work for an app that does not exist.
 * This verifier:
 *
 * - looks an app up only when a credential names it, and refuses a
 *   credential for an app nobody knows as `unknown_app`, a credential
 *   refusal, never `unavailable`. An app found unknown is remembered for a
 *   while, so a flood of tokens naming it costs one lookup;
 * - fetches each app's signing keys once and keeps them (see `createKeySet`);
 * - starts following an app's revocation list only once a credential for
 *   that app has passed every other check: a token its signature, a key the
 *   issuer's introspection. A forged token naming any app id starts nothing;
 * - follows at most `maxApps` apps, drops an app nobody has called for
 *   `idleMs`, and makes room for a new app by dropping the one called least
 *   recently. It keeps keys for at most `maxApps` apps it does not follow.
 */

/** How one app's credentials are checked. Usually read from where the server keeps its apps. */
export interface AppSettings {
  /** The issuer every token of the app comes from (its `iss`). */
  readonly issuer: string;
  /** The audience every token must name (its `aud`): the API this server protects. Never the app id by default. */
  readonly audience: string;
  /** Where the app's public keys are published (a JSON Web Key Set URL), including its revocation lanes' keys. */
  readonly jwksUrl?: string;
  /** The app's public keys themselves, instead of `jwksUrl`. */
  readonly jwks?: JSONWebKeySet;
  /** Each lane of the app's revocation list and the URL it is served from, or `'none'` to follow no list for this app. */
  readonly revocationLanes: Readonly<Record<string, string>> | 'none';
}

/** The settings of an app, or null when there is no such app. Throws when it cannot tell. */
export type AppSettingsResolver = (appId: string) => AppSettings | null | Promise<AppSettings | null>;

/** How every app's revocation list is followed. The app, its lanes and its keys come from its settings. */
export type AppRevocationOptions = Pick<
  RevocationPullerOptions,
  'intervalMs' | 'freshForMs' | 'maxLagMs' | 'clockToleranceMs' | 'timeoutMs' | 'pageSize' | 'headers' | 'onEntry'
>;

export interface AppVerifiersOptions {
  /** Looks an app up by id. Called only when a credential names an app this verifier does not hold. */
  apps: AppSettingsResolver;
  /** The issuer's key introspection endpoint, one for every app. Without it, keys are refused with `not_accepted`. */
  introspectionUrl?: string;
  /** How long a successful key check is reused. @default 0 */
  introspectionCacheTtlMs?: number;
  /** How long to wait for the introspection endpoint. @default 5000 */
  introspectionTimeoutMs?: number;
  /** The app whose service keys may call across apps. Unset: service keys are refused. */
  trustedServiceAppId?: string;
  /** How many seconds of clock difference to allow on expiry and "not before". @default 0 */
  clockToleranceSeconds?: number;
  /** How long an app's loaded key set is used before it is fetched again. @default 10 minutes */
  jwksCacheTtlMs?: number;
  /** How every app's revocation list is followed. */
  revocation?: AppRevocationOptions;
  /** The most apps whose revocation lists this server follows at once. @default 100 */
  maxApps?: number;
  /** How long an app nobody calls stays followed. @default 900000 (15 minutes) */
  idleMs?: number;
  /** How long an app found unknown is remembered as unknown. @default 60000 */
  unknownAppTtlMs?: number;
  /** The fetch for key sets, the introspection endpoint and the revocation lists. @default the global fetch */
  fetch?: typeof fetch;
  /** Optional debug logger. Never receives a credential. */
  log?: (message: string, details?: Record<string, unknown>) => void;
  /** The clock, in milliseconds. For tests. @default Date.now */
  now?: () => number;
}

export interface AppVerifyOptions {
  /**
   * The app the credential must belong to. Without it, a token's app is the
   * one it names (and its signature then proves), and a key's app is the one
   * the issuer says it belongs to. A service's key acts in the app named here.
   */
  readonly appId?: string;
  /**
   * How far behind the app's revocation list may be for this check, such as
   * 30000 for writes and sensitive actions. @default the list's `maxLagMs`
   */
  readonly maxLagMs?: number;
}

export interface AppStatus {
  readonly appId: string;
  /** Whether its revocation list is followed. */
  readonly followed: boolean;
  /** When a credential last named it, in ms. */
  readonly lastUsedAt: number;
  readonly revocation: RevocationListStatus | null;
}

export interface AppVerifiersStatus {
  /** The apps held, the one called least recently first. */
  readonly apps: readonly AppStatus[];
  /** How many app ids are remembered as unknown. */
  readonly unknownApps: number;
}

export interface AppVerifiers {
  /** Check one credential. Never throws for a bad credential; the refusal says why. */
  verify(credential: Credential | null | undefined, options?: AppVerifyOptions): Promise<Verification>;
  /** Check one credential and return its Actor, or throw a `CredentialRefusedError`. */
  verifyOrThrow(credential: Credential | null | undefined, options?: AppVerifyOptions): Promise<Actor>;
  /** Check the credential a request carries: `Authorization: Bearer` first, then `x-api-key`. */
  verifyRequest(request: { readonly headers: HeadersLike }, options?: AppVerifyOptions): Promise<Verification>;
  status(): AppVerifiersStatus;
  /** Stop following every revocation list, and forget every app. */
  stop(): void;
}

interface AppRecord {
  readonly appId: string;
  readonly settings: AppSettings;
  readonly keySet: KeySet;
  puller: RevocationPuller | null;
  following: Promise<RevocationPuller> | null;
  /** The app's key set answered that there is no such app. */
  notFound: boolean;
  lastUsedAt: number;
}

const DEFAULT_MAX_APPS = 100;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_UNKNOWN_APP_TTL_MS = 60 * 1000;
const NOT_REVOKED: RevocationVerdict = Object.freeze({ revoked: false });
const UNKNOWN_APP: Refusal = refuse('unknown_app', 'The credential names an app this server does not know.');

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function usableSettings(settings: AppSettings): boolean {
  if (!settings || typeof settings !== 'object') return false;
  if (!isText(settings.issuer) || !isText(settings.audience)) return false;
  if (!settings.jwks && !isText(settings.jwksUrl)) return false;
  const lanes = settings.revocationLanes;
  if (lanes === 'none') return true;
  if (!lanes || typeof lanes !== 'object') return false;
  const entries = Object.entries(lanes);
  return entries.length > 0 && entries.every(([lane, url]) => isText(lane) && isText(url));
}

/**
 * Create the verifier for a server that serves many apps. One per process;
 * call `stop()` at shutdown.
 *
 * ```ts
 * const verifiers = createAppVerifiers({
 *   apps: async (appId) => (await appSettingsFor(appId)) ?? null,
 *   introspectionUrl,
 * });
 * const result = await verifiers.verifyRequest(request, { maxLagMs: isWrite ? 30_000 : undefined });
 * ```
 */
export function createAppVerifiers(options: AppVerifiersOptions): AppVerifiers {
  if (!options || typeof options.apps !== 'function') {
    throw new TypeError('createAppVerifiers: `apps` is required: it looks an app up by id, or says there is none.');
  }
  const maxApps = options.maxApps ?? DEFAULT_MAX_APPS;
  if (!Number.isSafeInteger(maxApps) || maxApps < 1) {
    throw new TypeError('createAppVerifiers: `maxApps` must be a whole number of at least 1.');
  }
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const unknownAppTtlMs = options.unknownAppTtlMs ?? DEFAULT_UNKNOWN_APP_TTL_MS;
  const maxUnknown = Math.max(1000, maxApps * 10);
  const clock = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  const introspect: ((key: string) => Promise<IntrospectionResult>) | null = options.introspectionUrl
    ? createIntrospectionClient({
        url: options.introspectionUrl,
        fetch: fetchImpl,
        cacheTtlMs: options.introspectionCacheTtlMs,
        timeoutMs: options.introspectionTimeoutMs,
      })
    : null;

  /** Every app held, the one called least recently first. */
  const records = new Map<string, AppRecord>();
  const resolving = new Map<string, Promise<{ record: AppRecord } | { refusal: Refusal }>>();
  /** App ids found unknown, and until when that is remembered. */
  const unknown = new Map<string, number>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  // ---- holding apps -------------------------------------------------------

  function touch(record: AppRecord): void {
    record.lastUsedAt = clock();
    records.delete(record.appId);
    records.set(record.appId, record);
  }

  function drop(record: AppRecord, why: string): void {
    record.puller?.stop();
    record.puller = null;
    if (records.get(record.appId) === record) records.delete(record.appId);
    log('App dropped', { appId: record.appId, why });
  }

  function rememberUnknown(appId: string): void {
    unknown.delete(appId);
    while (unknown.size >= maxUnknown) {
      const oldest = unknown.keys().next().value;
      if (oldest === undefined) break;
      unknown.delete(oldest);
    }
    unknown.set(appId, clock() + unknownAppTtlMs);
  }

  /** Drop every app nobody has called for `idleMs`. */
  function sweep(now: number): void {
    for (const record of records.values()) {
      if (now - record.lastUsedAt <= idleMs) break;
      drop(record, 'idle');
    }
    if (sweeper !== null && ![...records.values()].some((record) => record.puller !== null)) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }

  /** Drop the least recently called app that matches, while `count` of them is at the cap. */
  function makeRoom(matches: (record: AppRecord) => boolean, why: string): void {
    let held = 0;
    for (const record of records.values()) if (matches(record)) held += 1;
    for (const record of records.values()) {
      if (held < maxApps) break;
      if (!matches(record)) continue;
      drop(record, why);
      held -= 1;
    }
  }

  async function lookUp(appId: string): Promise<{ record: AppRecord } | { refusal: Refusal }> {
    let settings: AppSettings | null;
    try {
      settings = await options.apps(appId);
    } catch {
      return { refusal: refuse('unavailable', "The app's settings could not be loaded.") };
    }
    if (settings === null || settings === undefined) {
      rememberUnknown(appId);
      return { refusal: UNKNOWN_APP };
    }
    if (!usableSettings(settings)) {
      log('App settings are incomplete', { appId });
      return { refusal: refuse('unavailable', "The app's settings are incomplete.") };
    }
    const record: AppRecord = {
      appId,
      settings,
      keySet: createKeySet({
        url: settings.jwksUrl,
        keys: settings.jwks,
        fetch: fetchImpl,
        maxAgeMs: options.jwksCacheTtlMs,
        now: clock,
      }),
      puller: null,
      following: null,
      notFound: false,
      lastUsedAt: clock(),
    };
    makeRoom((held) => held.puller === null, 'too many apps held');
    records.set(appId, record);
    return { record };
  }

  async function appFor(appId: string): Promise<{ record: AppRecord } | { refusal: Refusal }> {
    const now = clock();
    sweep(now);
    const held = records.get(appId);
    if (held) {
      touch(held);
      return { record: held };
    }
    const until = unknown.get(appId);
    if (until !== undefined) {
      if (until > now) return { refusal: UNKNOWN_APP };
      unknown.delete(appId);
    }
    let pending = resolving.get(appId);
    if (!pending) {
      pending = lookUp(appId).finally(() => resolving.delete(appId));
      resolving.set(appId, pending);
    }
    return pending;
  }

  // ---- following an app's revocation list ---------------------------------

  function ensureSweeper(): void {
    if (sweeper !== null) return;
    sweeper = setInterval(() => sweep(clock()), Math.max(1000, Math.min(idleMs / 2, 60_000)));
    (sweeper as { unref?: () => void }).unref?.();
  }

  /** The app's puller, started now if it is not yet. Only ever called for a credential that passed every other check. */
  function follow(record: AppRecord, lanes: Readonly<Record<string, string>>): Promise<RevocationPuller> {
    if (record.puller) return Promise.resolve(record.puller);
    record.following ??= (async () => {
      try {
        await record.keySet.keys();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === KEY_SET_NOT_FOUND) record.notFound = true;
        throw error;
      }
      if (record.puller) return record.puller;
      makeRoom((held) => held !== record && held.puller !== null, 'too many apps followed');
      if (records.get(record.appId) !== record) records.set(record.appId, record);
      record.puller = createRevocationPuller({
        ...(options.revocation ?? {}),
        appId: record.appId,
        lanes,
        keySet: record.keySet,
        fetch: fetchImpl,
        log,
        now: clock,
      }).start();
      ensureSweeper();
      log('Following the revocation list', { appId: record.appId });
      return record.puller;
    })().finally(() => {
      record.following = null;
    });
    return record.following;
  }

  function rulesFor(record: AppRecord, maxLagMs: number | undefined): AppRules {
    const lanes = record.settings.revocationLanes;
    const revocationCheck: RevocationCheck =
      lanes === 'none'
        ? () => NOT_REVOKED
        : async (actor) => {
            const puller = await follow(record, lanes);
            return maxLagMs === undefined ? puller.check(actor) : puller.checkWithin(maxLagMs)(actor);
          };
    return {
      appId: record.appId,
      issuer: record.settings.issuer,
      audience: record.settings.audience,
      keySet: record.keySet,
      clockToleranceSeconds: options.clockToleranceSeconds ?? 0,
      trustedServiceAppId: options.trustedServiceAppId,
      revocationCheck,
      log,
    };
  }

  /** An app whose issuer publishes no keys for it is unknown: forget it, and say so. */
  function settle(record: AppRecord, result: Verification): Verification {
    if (!result.ok && (result.refusal.reason === 'unknown_app' || record.notFound)) {
      drop(record, 'unknown');
      rememberUnknown(record.appId);
      return { ok: false, refusal: UNKNOWN_APP };
    }
    return result;
  }

  function refused(refusal: Refusal): Verification {
    log('Credential refused', { reason: refusal.reason });
    return { ok: false, refusal };
  }

  // ---- checking -----------------------------------------------------------

  async function verifyToken(token: string, given: AppVerifyOptions): Promise<Verification> {
    if (!isCompactJws(token)) return refused(refuse('malformed', 'The token is malformed.'));
    let named: unknown;
    try {
      // Unchecked, and used only to pick which app's keys check the signature.
      named = decodeJwt(token).aid;
    } catch {
      return refused(refuse('malformed', 'The token is malformed.'));
    }
    if (!isText(named)) return refused(refuse('invalid_claims', 'The token does not name its app.'));
    if (given.appId !== undefined && given.appId !== named) {
      return refused(refuse('wrong_app', 'The token was issued for a different app.'));
    }
    const found = await appFor(named);
    if ('refusal' in found) return refused(found.refusal);
    return settle(found.record, await checkToken(rulesFor(found.record, given.maxLagMs), token));
  }

  async function verifyKey(key: string, given: AppVerifyOptions): Promise<Verification> {
    if (!introspect) return refused(refuse('not_accepted', 'Keys are not accepted here.'));
    let target: AppRecord | null = null;
    if (given.appId !== undefined) {
      const found = await appFor(given.appId);
      if ('refusal' in found) return refused(found.refusal);
      target = found.record;
    }
    const result = await introspect(key);
    if ('refusal' in result) return refused(result.refusal);
    if (target === null) {
      if (result.answer.active !== true) return refused(refuse('inactive', 'The key is not active.'));
      const appId = result.answer.appId;
      if (!isText(appId)) return refused(refuse('invalid_claims', 'The key does not name its app.'));
      const found = await appFor(appId);
      if ('refusal' in found) return refused(found.refusal);
      target = found.record;
    }
    return settle(target, await checkKeyAnswer(rulesFor(target, given.maxLagMs), result));
  }

  async function verify(credential: Credential | null | undefined, given: AppVerifyOptions = {}): Promise<Verification> {
    if (!credential || typeof credential.value !== 'string' || credential.value.length === 0) {
      return refused(refuse('missing', 'No credential was presented.'));
    }
    if (given.appId !== undefined && !isText(given.appId)) {
      return refused(refuse('invalid_claims', 'The app to check against is not an app id.'));
    }
    if (credential.type === 'token') return verifyToken(credential.value, given);
    if (credential.type === 'key') return verifyKey(credential.value, given);
    return refused(refuse('malformed', 'Unknown credential type.'));
  }

  return {
    verify,
    async verifyOrThrow(credential, given) {
      const result = await verify(credential, given);
      if (!result.ok) throw new CredentialRefusedError(result.refusal);
      return result.actor;
    },
    async verifyRequest(request, given) {
      const [first] = readCredentials(request.headers);
      return verify(first, given);
    },
    status() {
      sweep(clock());
      return {
        apps: [...records.values()].map((record) => ({
          appId: record.appId,
          followed: record.puller !== null,
          lastUsedAt: record.lastUsedAt,
          revocation: record.puller?.status() ?? null,
        })),
        unknownApps: unknown.size,
      };
    },
    stop() {
      for (const record of [...records.values()]) drop(record, 'stopped');
      records.clear();
      unknown.clear();
      if (sweeper !== null) clearInterval(sweeper);
      sweeper = null;
    },
  };
}
