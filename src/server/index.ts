/**
 * @nebulr-group/bridge-auth-core/server
 *
 * For the Child App's own server: check the tokens and keys its API is
 * called with, read flag results for the caller, and count usage ("count
 * this").
 *
 * Token checks follow the app's revocation list, so a session that ended, a
 * member who was removed or a key that was revoked is refused within seconds,
 * not when its token expires. While the list cannot be read, checks answer
 * `unavailable` (503), never yes.
 *
 * Runs on Node and edge runtimes: it uses only `fetch` and Web Crypto.
 */
import { Discovery, type IssuerMetadata } from '../core/discovery.js';
import { BridgeError } from '../core/errors.js';
import { call, platformFetch, withoutRedirects, type Fetch } from '../core/http.js';
import { REVOCATION_LANES, ROUTES } from '../core/routes.js';
import { randomId } from '../core/util.js';
import { fallbackType, FlagSet, resultsOf, type Hint } from '../flags.js';
import { snapshotOf, type QuotaRead, type QuotaSnapshot } from '../quota.js';
import {
  createCredentialVerifier,
  createKeySet,
  createRevocationPuller,
  readCredentials,
  type Actor as VerifiedActor,
  type CredentialVerifier,
  type HeadersLike,
  type RevocationListStatus,
  type RevocationPuller,
} from '../verifier/index.js';

/** Who is calling the Child App's API. */
export interface Actor {
  /** `person` for a signed-in person; a key's kind (`personal_key`, `service_account_key`, `app_key`) for a key; `job` for a job. */
  readonly kind: VerifiedActor['kind'];
  /** The person's id, or the key's or job's id. */
  readonly id: string;
  /** The person behind the call: the person, or the member who made a personal key. Null otherwise. */
  readonly personId: string | null;
  /** The workspace the call is for. Null when the credential names none. */
  readonly workspaceId: string | null;
  /** The sign-in session the token belongs to, for a person. */
  readonly sessionId: string | null;
  readonly appId: string;
  /** The workspace's standing, such as `active`. A workspace that is not active can only be read: `check` refuses a person's writes there. */
  readonly standing: string | null;
}

export interface BridgeServerOptions {
  /** The issuer, as for the browser SDK. */
  readonly issuer: string;
  /** The app's own key, for counting usage. Keep it on the server. */
  readonly appKey?: string;
  /**
   * The audience Bridge's access tokens name. Read from the issuer's
   * metadata; give it here only for an issuer that does not publish it.
   */
  readonly audience?: string;
  readonly fetch?: Fetch;
  /** How far behind the revocation list may fall before checks answer `unavailable`. @default 300000 (5 minutes) */
  readonly maxLagMs?: number;
  /** The tighter limit for `verify(..., { strict: true })`, for writes and sensitive actions. @default 30000 */
  readonly strictLagMs?: number;
  /** How often to fetch new revocation entries. @default 2000 */
  readonly revocationIntervalMs?: number;
  /** How often counted usage is sent. @default 5000 */
  readonly usageFlushMs?: number;
  /** The most reports kept while Bridge cannot take them; past it, the oldest are dropped and logged. @default 10000 */
  readonly maxQueuedReports?: number;
  /** The first wait before the issuer's metadata is read again after a failure; it doubles up to a minute. @default 1000 */
  readonly discoveryRetryMs?: number;
  /** Debug messages. Never receives a credential. */
  readonly log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface VerifyOptions {
  /** Refuse unless the revocation list is at most `strictLagMs` behind. For writes and sensitive actions. */
  readonly strict?: boolean;
  /**
   * The request's HTTP method, when the request object carries none. A write (any method but `GET`, `HEAD` and
   * `OPTIONS`) by a signed-in person is refused while their workspace is not active (403) or is locked for payment
   * (402), and while that cannot be told (503). Reads are never refused for these. Without a method nothing is
   * enforced: pass it, or pass a request that has one. Call `check` only for routes that need a credential: a public
   * route that ignores a failed check ignores these refusals too.
   */
  readonly method?: string;
}

/** Bridge's own locked flags: whether the person's workspace is active, and whether it is not locked for payment. */
export const WORKSPACE_FLAGS = Object.freeze({
  active: 'bridge-workspace-active',
  paid: 'bridge-workspace-paid',
});

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function problemError(kind: 'forbidden' | 'plan-required' | 'unavailable', status: number, slug: string, title: string, detail: string, extensions: Record<string, unknown> = {}): BridgeError {
  return new BridgeError(kind, detail, { status, code: slug, problem: { type: `urn:bridge:problem:${slug}`, title, status, detail, ...extensions } });
}

/** A write in a suspended or deletion-scheduled workspace: 403. */
function notActive(standing: string): BridgeError {
  return problemError('forbidden', 403, 'workspace-not-active', 'Workspace not active', `This workspace is ${standing.replace(/_/g, ' ')}; it can be read but not changed.`, { standing });
}

/** A write in a workspace locked for payment: 402. */
function billingLocked(access: unknown): BridgeError {
  return problemError('plan-required', 402, 'billing-locked', 'Payment required', 'This workspace is locked for payment; it can be read but not changed until it is paid up.', {
    reason: 'billing_locked',
    ...(typeof access === 'string' ? { billing: { access } } : {}),
  });
}

/** Bridge could not say whether the workspace may be written to: 503, never yes. */
function stateUnknown(detail: string, cause?: unknown): BridgeError {
  return new BridgeError('unavailable', detail, {
    status: 503,
    code: 'workspace-state-unavailable',
    problem: { type: 'urn:bridge:problem:unavailable', title: 'Service unavailable', status: 503, detail },
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * A request, or anything with its headers: a Fetch `Request`, Node's `IncomingMessage`, or `{ headers }`.
 * `method` is read from it when there is one: see {@link VerifyOptions.method}.
 */
export interface RequestLike {
  readonly headers: HeadersLike;
  readonly method?: string | undefined;
}

interface UsageReport {
  readonly id: string;
  readonly metric: string;
  readonly quantity: number;
  readonly workspace: string;
  readonly time: string;
  /** A gauge's level (`usage.set`), not sent: a newer level replaces an older one still waiting. */
  readonly level?: true;
}

/** A unit of a strict limit held for an action: confirm it when the action happened, give it back when it did not. */
export interface UsageHold {
  readonly id: string;
  readonly metric: string;
  /** The plan's limit on the metric. */
  readonly limit: number;
  /** What was used when the unit was held, the held unit not counted. */
  readonly used: number;
  /** How long Bridge keeps the hold before giving the unit back itself. */
  readonly expiresInSeconds: number;
  /** The action happened: the unit counts now. Once only; asking again does nothing. */
  confirm(): Promise<void>;
  /** The action did not happen: the unit goes back. Once only; a hold already gone is not an error. */
  giveBack(): Promise<void>;
}

export interface HoldOptions {
  /** The unit's size, a whole number from 1. @default 1 */
  readonly quantity?: number;
  /**
   * What the unit is held for. Holding again for the same decision holds once, so a retried request does not hold
   * twice: pass the request's own id. 1 to 200 visible characters. @default a new one each time
   */
  readonly decision?: string;
  /** The workspace, for a caller that acts in none. @default the caller's workspace */
  readonly workspace?: string;
}

const METRIC = /^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){0,3}$/;
/** As Bridge reads them: a report's one-time id, and a workspace id. */
const REPORT_ID = /^[\x21-\x7e]{1,200}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_BATCH = 1000;

/** Bridge refused the batch itself: sending it again would be refused again. */
function refusedForGood(error: unknown): boolean {
  return error instanceof BridgeError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function publicActor(actor: VerifiedActor): Actor {
  const standing = actor.claims['wst'];
  return Object.freeze({
    kind: actor.kind,
    id: actor.id,
    personId: actor.personId,
    workspaceId: actor.workspaceId,
    sessionId: actor.credential.sessionId,
    appId: actor.appId,
    standing: typeof standing === 'string' ? standing : null,
  });
}

function bearerOf(headers: HeadersLike): string | null {
  const found = readCredentials(headers).find((credential) => credential.type === 'token');
  return found?.value ?? null;
}

/** At most this many keys go in one report of flags found in code. */
const FLAG_REPORT_BATCH = 50;
/** At most this many keys are reported by one process: enough for any app's flags, never a flood. */
const MAX_REPORTED_FLAGS = 1000;

export function createBridgeServer(options: BridgeServerOptions) {
  // The app key reaches the whole app: it must never be in a page. The package's browser build of this entry throws too.
  if (options.appKey && typeof window !== 'undefined' && typeof document !== 'undefined') {
    throw new BridgeError('misconfigured', 'createBridgeServer holds the app key and runs only on a server, never in a browser.');
  }
  const fetchFn = options.fetch ?? platformFetch();
  // The key set, the revocation lanes and key introspection are read only where the metadata says, never via a redirect.
  const guardedFetch = withoutRedirects(fetchFn);
  const strictLagMs = options.strictLagMs ?? 30_000;
  const maxQueued = options.maxQueuedReports ?? 10_000;
  let metadata: IssuerMetadata | null = null;
  let verifier: CredentialVerifier | null = null;
  let puller: RevocationPuller | null = null;
  // Read when it can be, shared by token checks, flags and usage. A failed read is tried again later, never kept.
  const discovery = new Discovery(options.issuer, fetchFn, { retryMinMs: options.discoveryRetryMs ?? 1000 });
  let settingUp: Promise<void> | null = null;

  async function build(): Promise<void> {
    const endpoints = await discovery.get();
    if (verifier !== null) return;
    const found = endpoints.metadata;
    const audience = found.audience ?? options.audience;
    if (audience === undefined || audience === '') {
      throw new BridgeError('misconfigured', "The issuer's metadata does not name the access tokens' audience: pass `audience`.");
    }
    const jwksUrl = found.endpoints.jwks;
    if (jwksUrl === undefined) throw new BridgeError('misconfigured', "The issuer's metadata lists no key set (jwks).");
    const lanes: Record<string, string> = {};
    for (const lane of REVOCATION_LANES) {
      const url = found.revocationLanes[lane];
      if (url === undefined) throw new BridgeError('misconfigured', `The issuer's metadata lists no "${lane}" lane of the revocation list.`);
      lanes[lane] = url;
    }
    const keySet = createKeySet({ url: jwksUrl, fetch: guardedFetch });
    const made = createRevocationPuller({
      appId: found.appId,
      lanes,
      keySet,
      fetch: guardedFetch,
      ...(options.maxLagMs === undefined ? {} : { maxLagMs: options.maxLagMs }),
      ...(options.revocationIntervalMs === undefined ? {} : { intervalMs: options.revocationIntervalMs }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }).start();
    verifier = createCredentialVerifier({
      appId: found.appId,
      issuer: found.issuer,
      audience,
      keySet,
      ...(found.endpoints.introspect === undefined ? {} : { introspectionUrl: found.endpoints.introspect }),
      revocationCheck: made.check,
      fetch: guardedFetch,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    puller = made;
    metadata = found;
  }

  /** Sets up the token checks once the metadata can be read. Calls made while it cannot fail at once, until the next try. */
  function setUp(): Promise<void> {
    if (verifier !== null) return Promise.resolve();
    settingUp ??= build().finally(() => {
      settingUp = null;
    });
    return settingUp;
  }

  const ready = setUp();
  ready.catch(() => undefined);

  /**
   * Checks the request's credential: `Authorization: Bearer <token>`, or `x-api-key: <key>`.
   *
   * For a write by a signed-in person (see {@link VerifyOptions.method}) it also checks the workspace: a standing
   * that is not `active` is refused with 403, a workspace locked for payment with 402, and a workspace whose state
   * Bridge cannot tell with 503. The flag results it read for that come back as `flags`, so a gate on the same
   * request need not ask again.
   */
  async function check(request: RequestLike, verifyOptions: VerifyOptions = {}): Promise<{ ok: true; actor: Actor; flags?: FlagSet } | { ok: false; error: BridgeError }> {
    try {
      await setUp();
    } catch (cause) {
      // Not set up yet (Bridge unreachable, or its metadata unusable): never a yes.
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: new BridgeError('unavailable', `Credentials cannot be checked yet: ${reason}`, { status: 503, code: 'unavailable', cause }) };
    }
    const verification = await (verifier as CredentialVerifier).verifyRequest(request);
    if (!verification.ok) {
      const { reason, message } = verification.refusal;
      if (reason === 'unavailable') return { ok: false, error: new BridgeError('unavailable', message, { status: 503, code: reason }) };
      return { ok: false, error: new BridgeError('signed-out', message, { status: 401, code: reason }) };
    }
    if (verifyOptions.strict) {
      try {
        const verdict = await (puller as RevocationPuller).checkWithin(strictLagMs)(verification.actor);
        if (verdict.revoked) return { ok: false, error: new BridgeError('signed-out', verdict.message ?? 'Access was taken away.', { status: 401, code: 'revoked' }) };
      } catch {
        return { ok: false, error: new BridgeError('unavailable', 'The revocation list is too far behind for this action; try again shortly.', { status: 503, code: 'unavailable' }) };
      }
    }
    const actor = publicActor(verification.actor);
    const method = (verifyOptions.method ?? request.method ?? '').toUpperCase();
    if (actor.kind !== 'person' || method === '' || READ_METHODS.has(method)) return { ok: true, actor };
    return enforceWorkspace(actor, request);
  }

  /**
   * For a write by a person: the workspace must be active and not locked for payment. A token that names no
   * workspace has none to be locked. Fails closed: results that cannot be read or lack the answer refuse.
   */
  async function enforceWorkspace(actor: Actor, request: RequestLike): Promise<{ ok: true; actor: Actor; flags?: FlagSet } | { ok: false; error: BridgeError }> {
    if (actor.workspaceId === null) return { ok: true, actor };
    if (actor.standing !== null && actor.standing !== 'active') return { ok: false, error: notActive(actor.standing) };
    const token = bearerOf(request.headers);
    if (token === null) return { ok: true, actor };
    let flags: FlagSet;
    try {
      flags = await readFlags(token, {});
    } catch (cause) {
      return { ok: false, error: stateUnknown('The workspace\'s payment state could not be read from Bridge; try again shortly.', cause) };
    }
    const results = flags.all();
    // The token's standing can be a few minutes old: Bridge's live answer, when it gives one, refuses at once.
    if (results.has(WORKSPACE_FLAGS.active) && !flags.enabled(WORKSPACE_FLAGS.active)) return { ok: false, error: notActive(actor.standing ?? 'not active') };
    const paid = results.get(WORKSPACE_FLAGS.paid);
    if (paid === undefined || !('value' in paid)) return { ok: false, error: stateUnknown("Bridge gave no answer on whether the workspace's payment is in order, so the write is refused.") };
    if (paid.value !== true) return { ok: false, error: billingLocked(paid.metadata?.['access']) };
    return { ok: true, actor, flags };
  }

  /** Bridge's flag results for a person's token. Throws when Bridge cannot answer. */
  async function readFlags(token: string, hints: Readonly<Record<string, Hint>>): Promise<FlagSet> {
    const endpoints = await discovery.get();
    const answer = await call<unknown>(fetchFn, endpoints.url(ROUTES.flagsEvaluate), { method: 'POST', token, body: { context: hints } });
    return new FlagSet(resultsOf(answer.body), noticeMissing);
  }

  // Flags found in code. A key the app reads that Bridge gave no result for is reported once per process, with the app
  // key, in the background: Bridge makes each one it does not have, switched off, and shows it as found in code. A flag
  // that is off gives no result either, so it is reported too; Bridge leaves a flag it has as it is. Without the app
  // key nothing is reported. A report that fails is dropped: it is only a hint for the dashboard.
  const reportedKeys = new Set<string>();
  const unreported = new Map<string, string>();
  let reportingKeys = false;

  function noticeMissing(key: string, fallback: unknown): void {
    if (options.appKey === undefined || options.appKey === '') return;
    if (key.startsWith('bridge:') || reportedKeys.has(key) || unreported.has(key)) return;
    if (reportedKeys.size + unreported.size >= MAX_REPORTED_FLAGS) return;
    unreported.set(key, fallbackType(fallback));
    if (reportingKeys) return;
    reportingKeys = true;
    setTimeout(() => void reportKeys(), 0);
  }

  async function reportKeys(): Promise<void> {
    try {
      while (unreported.size > 0) {
        const batch = [...unreported].slice(0, FLAG_REPORT_BATCH);
        for (const [key] of batch) {
          unreported.delete(key);
          reportedKeys.add(key);
        }
        const endpoints = await discovery.get();
        await call(fetchFn, endpoints.url(ROUTES.flagsReport), { method: 'POST', apiKey: options.appKey ?? null, body: { flags: batch.map(([key, type]) => ({ key, type })) } });
      }
    } catch (error) {
      options.log?.('Flags found in code could not be reported; they are not sent again.', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      unreported.clear();
      reportingKeys = false;
    }
  }

  // Counting usage.
  let queue: UsageReport[] = [];
  let dropped = 0;
  let sending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function sendQueued(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH);
      // Until the metadata can be read, the reports wait (within the queue's limit).
      const endpoints = await discovery.get().catch(() => null);
      if (endpoints === null) return;
      try {
        const reports = batch.map(({ level: _level, ...report }) => report);
        await call(fetchFn, endpoints.url(ROUTES.usageReport), { method: 'POST', apiKey: options.appKey ?? null, body: { reports } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!refusedForGood(error)) {
          // Kept, and sent again whole with the same ids: Bridge counts each id once.
          options.log?.('Usage could not be sent; it is kept and sent again.', { reports: batch.length, error: message });
          return;
        }
        // Refused as it is: set aside, so the reports behind it are still counted.
        options.log?.('Usage reports were refused by Bridge and dropped.', { reports: batch.length, error: message });
      }
      const done = new Set(batch);
      queue = queue.filter((report) => !done.has(report));
    }
    if (dropped > 0) {
      options.log?.('Usage reports were dropped while the queue was full.', { dropped });
      dropped = 0;
    }
  }

  function flush(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sending ??= sendQueued().finally(() => {
      sending = null;
      if (queue.length > 0) schedule();
    });
    return sending;
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, options.usageFlushMs ?? 5000);
    // Never keeps a Node process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  }

  /** The workspace a usage call is for: the one named, or the caller's. */
  function workspaceFor(actor: Actor, named?: string): string {
    const workspace = named ?? actor.workspaceId;
    if (workspace === null) throw new BridgeError('invalid', 'This caller acts in no workspace: name the workspace the usage is for.');
    if (!WORKSPACE_ID.test(workspace)) throw new BridgeError('invalid', `"${workspace}" is not a workspace id.`);
    return workspace;
  }

  /** What a call that holds or reads a limit needs: the app key, the workspace and the endpoints. */
  async function usageCall(actor: Actor, metric: string, named?: string) {
    if (options.appKey === undefined || options.appKey === '') throw new BridgeError('misconfigured', 'Holding or reading a limit needs the app key: pass `appKey`.');
    if (!METRIC.test(metric)) throw new BridgeError('invalid', `"${metric}" is not a metric name: lower case, dot-separated, such as projects.`);
    return { workspace: workspaceFor(actor, named), endpoints: await discovery.get(), apiKey: options.appKey };
  }

  return {
    ready,
    /** What the issuer published. Available once `ready` resolves. */
    metadata: (): IssuerMetadata => {
      if (metadata === null) throw new BridgeError('misconfigured', 'The server is not ready yet: wait for `ready`.');
      return metadata;
    },
    check,
    /** Checks the request's credential and returns its Actor, or throws a `BridgeError` (401, or 503 while Bridge cannot be checked). */
    async verify(request: RequestLike, verifyOptions: VerifyOptions = {}): Promise<Actor> {
      const result = await check(request, verifyOptions);
      if (!result.ok) throw result.error;
      return result.actor;
    },
    flags: {
      /**
       * The caller's flag results, worked out by Bridge for the person whose
       * token came with the request. A request without a person's token gets
       * an empty set: every flag gives its fallback, as it does while Bridge
       * cannot answer.
       */
      async forRequest(request: RequestLike, hints: Readonly<Record<string, Hint>> = {}): Promise<FlagSet> {
        const token = bearerOf(request.headers);
        if (token === null) return new FlagSet();
        try {
          return await readFlags(token, hints);
        } catch (error) {
          // Gates fail closed: every flag gives its fallback while Bridge cannot answer.
          options.log?.('Flag results could not be read; every flag gives its fallback.', { error: error instanceof Error ? error.message : String(error) });
          return new FlagSet();
        }
      },
    },
    usage: {
      /**
       * Counts usage of a metric for the caller's workspace ("count this").
       * Sent in batches every few seconds; a batch that fails is sent again
       * with the same ids, so nothing is counted twice.
       */
      count(actor: Actor, metric: string, quantity = 1, countOptions: { readonly id?: string; readonly workspace?: string } = {}): void {
        if (options.appKey === undefined || options.appKey === '') throw new BridgeError('misconfigured', 'Counting usage needs the app key: pass `appKey`.');
        if (!METRIC.test(metric)) throw new BridgeError('invalid', `"${metric}" is not a metric name: lower case, dot-separated, such as api.calls.`);
        if (!Number.isFinite(quantity) || quantity < 0) throw new BridgeError('invalid', 'The quantity is a number of 0 or more.');
        const workspace = countOptions.workspace ?? actor.workspaceId;
        if (workspace === null) throw new BridgeError('invalid', 'This caller acts in no workspace: name the workspace the usage is for.');
        if (!WORKSPACE_ID.test(workspace)) throw new BridgeError('invalid', `"${workspace}" is not a workspace id.`);
        const id = countOptions.id ?? randomId();
        if (!REPORT_ID.test(id)) throw new BridgeError('invalid', 'A report id is 1 to 200 visible characters, with no spaces.');
        if (queue.length >= maxQueued) {
          // Full while Bridge cannot take reports: the oldest go, so memory stays bounded.
          queue.shift();
          dropped += 1;
          if (dropped === 1) options.log?.('The usage queue is full; the oldest reports are being dropped.', { limit: maxQueued });
        }
        queue.push({ id, metric, quantity, workspace, time: new Date().toISOString() });
        if (queue.length >= MAX_BATCH) void flush();
        else schedule();
      },
      /**
       * Sets a gauge metric's level for the caller's workspace: how many
       * exist now (projects, storage), not an amount to add. Queued and sent
       * like `count`; a level still waiting for the same metric is replaced,
       * since only the last one matters. For a metric the plan declares as a
       * gauge; Bridge adds the level up on a counter.
       */
      set(actor: Actor, metric: string, level: number, setOptions: { readonly id?: string; readonly workspace?: string } = {}): void {
        if (options.appKey === undefined || options.appKey === '') throw new BridgeError('misconfigured', 'Setting usage needs the app key: pass `appKey`.');
        if (!METRIC.test(metric)) throw new BridgeError('invalid', `"${metric}" is not a metric name: lower case, dot-separated, such as projects.`);
        if (!Number.isFinite(level) || level < 0) throw new BridgeError('invalid', 'The level is a number of 0 or more.');
        const workspace = workspaceFor(actor, setOptions.workspace);
        const id = setOptions.id ?? randomId();
        if (!REPORT_ID.test(id)) throw new BridgeError('invalid', 'A report id is 1 to 200 visible characters, with no spaces.');
        queue = queue.filter((report) => !(report.level === true && report.metric === metric && report.workspace === workspace));
        queue.push({ id, metric, quantity: level, workspace, time: new Date().toISOString(), level: true });
        if (queue.length >= MAX_BATCH) void flush();
        else schedule();
      },
      /**
       * Holds one unit of a strict limit before an action, so two requests
       * never get the last unit. Resolves with the hold: `confirm()` when the
       * action happened, `giveBack()` when it did not. Throws a `BridgeError`
       * of kind `plan-required` (status 402, code `limit-reached`, with
       * `error.quota`: the metric, the limit and what is used) when the plan's
       * limit is reached; `quotaExceededBody(error)` is the 402 body to answer
       * with. Any other failure (Bridge unreachable) is thrown as it is: the
       * limit could not be checked, so treat it as refused. A metered limit
       * is never refused; the overage is billed.
       */
      async hold(actor: Actor, metric: string, holdOptions: HoldOptions = {}): Promise<UsageHold> {
        const { workspace, endpoints, apiKey } = await usageCall(actor, metric, holdOptions.workspace);
        const decision = holdOptions.decision ?? randomId();
        if (!REPORT_ID.test(decision)) throw new BridgeError('invalid', 'A decision is 1 to 200 visible characters, with no spaces.');
        const quantity = holdOptions.quantity ?? 1;
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new BridgeError('invalid', 'The quantity is a whole number from 1.');
        const answer = await call<{ id: string; limit: number; used: number; expiresInSeconds: number }>(fetchFn, endpoints.url(ROUTES.usageHold), {
          method: 'POST',
          apiKey,
          headers: { 'Bridge-Workspace': workspace },
          body: { metric, decision, quantity },
        });
        const held = answer.body;
        let done: Promise<void> | null = null;
        const finish = (route: typeof ROUTES.usageHoldConfirm | typeof ROUTES.usageHoldGiveBack, goneIsFine: boolean): Promise<void> => {
          done ??= call(fetchFn, endpoints.url(route, { holdId: held.id }), { method: route.method, apiKey, headers: { 'Bridge-Workspace': workspace } }).then(
            () => undefined,
            (error: unknown) => {
              if (goneIsFine && error instanceof BridgeError && error.status === 404) return;
              // Not finished: asking again may work.
              done = null;
              throw error;
            },
          );
          return done;
        };
        return {
          id: held.id,
          metric,
          limit: held.limit,
          used: held.used,
          expiresInSeconds: held.expiresInSeconds,
          confirm: () => finish(ROUTES.usageHoldConfirm, false),
          giveBack: () => finish(ROUTES.usageHoldGiveBack, true),
        };
      },
      /**
       * A metric's quota for the caller's workspace, read now: what is used
       * (open holds not counted), the limit, the policy (`hard` or `metered`)
       * and the warning level. Null when the plan sets no limit on the
       * metric. Needs the app key. Throws when Bridge cannot answer: a check
       * that could not be made is not a yes.
       */
      async quota(actor: Actor, metric: string, quotaOptions: { readonly workspace?: string } = {}): Promise<QuotaSnapshot | null> {
        const { workspace, endpoints, apiKey } = await usageCall(actor, metric, quotaOptions.workspace);
        const answer = await call<QuotaRead | null | undefined>(fetchFn, endpoints.url(ROUTES.usageQuota, { metric }), { method: 'GET', apiKey, headers: { 'Bridge-Workspace': workspace } });
        return snapshotOf(metric, answer.body) ?? null;
      },
      /** Sends what is counted now. Call it before a short-lived process ends. */
      flush,
      /** How many reports wait to be sent. */
      pending: () => queue.length,
    },
    /** How the revocation list is followed, for a health check. */
    status(): RevocationListStatus | null {
      return puller?.status() ?? null;
    },
    /** Sends counted usage, and stops following the revocation list. */
    async close(): Promise<void> {
      await flush();
      puller?.stop();
    },
  };
}

export type BridgeServer = ReturnType<typeof createBridgeServer>;

export { BridgeError, isBridgeError } from '../core/errors.js';
export type { BridgeErrorKind } from '../core/errors.js';
export { FlagSet } from '../flags.js';
export { DEFAULT_MANAGE_ROUTE, ENTITLEMENT_FLAG_PREFIX, entitlementFlag, isLimitReached, quotaExceededBody } from '../quota.js';
export type { QuotaExceededBody, QuotaSnapshot } from '../quota.js';
export type { LimitReached } from '../core/errors.js';
export type { FlagReason, FlagResult, Hint } from '../flags.js';
